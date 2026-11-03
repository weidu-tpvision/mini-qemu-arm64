// tools/build_interactive_elf.js - Builds Interactive MMIO Framebuffer ARM64 ELF Binary
// Generates: bin/interactive_paint.elf
// Supports:
// - Keyboard Input (Arrow Keys / WASD, Space for Paint, Shift/C for Color, R for Clear, Q for Exit)
// - Mouse / Pointer Input (Click & Drag to paint at pointer coords)
// - Non-destructive cursor save/restore across 60 FPS VSync yields (sys_sched_yield, syscall 124)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Decoder } from "../src/decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT_DIR, "bin");

// Helper to assemble standard ELF64 with code + data payload
function buildElfWithPayload(instructions, dataBuffer = Buffer.alloc(0), entryAddr = 0x00400000n) {
  const payload = Buffer.concat([
    Buffer.from(new Uint32Array(instructions).buffer),
    dataBuffer
  ]);

  const codeOffset = 0x1000; // 4KB page aligned
  const totalFileSize = codeOffset + payload.length;
  const buffer = Buffer.alloc(totalFileSize, 0);

  // 1. ELF Header (64 bytes)
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46; // Magic
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // Little-Endian
  buffer[6] = 1; // Version
  buffer[7] = 0; // Linux ABI
  buffer.writeUInt16LE(2, 16);             // ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18);         // EM_AARCH64 (183)
  buffer.writeUInt32LE(1, 20);              // Version 1
  buffer.writeBigUInt64LE(entryAddr, 24);   // Entry point
  buffer.writeBigUInt64LE(64n, 32);         // Program header offset
  buffer.writeBigUInt64LE(0n, 40);          // Section header offset
  buffer.writeUInt32LE(0, 48);              // Flags
  buffer.writeUInt16LE(64, 52);             // ELF header size
  buffer.writeUInt16LE(56, 54);             // Program header entry size
  buffer.writeUInt16LE(1, 56);              // Number of program headers
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(0, 60);
  buffer.writeUInt16LE(0, 62);

  // 2. Program Header (PT_LOAD)
  const phOffset = 64;
  buffer.writeUInt32LE(1, phOffset + 0);                    // PT_LOAD
  buffer.writeUInt32LE(7, phOffset + 4);                    // PF_R | PF_W | PF_X = 7
  buffer.writeBigUInt64LE(BigInt(codeOffset), phOffset + 8); // File offset
  buffer.writeBigUInt64LE(entryAddr, phOffset + 16);        // Virtual address
  buffer.writeBigUInt64LE(entryAddr, phOffset + 24);        // Physical address
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 32); // File size
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 40); // Memory size
  buffer.writeBigUInt64LE(0x1000n, phOffset + 48);          // 4KB alignment

  // 3. Write payload
  payload.copy(buffer, codeOffset);
  return buffer;
}

export function generateInteractivePaintElf() {
  const instructions = [];

  // Helper encoders
  const encMovz = (rd, imm16, lsl = 0) => 0xd2800000 | ((lsl / 16) << 21) | ((imm16 & 0xffff) << 5) | rd;
  const encMovk = (rd, imm16, lsl = 0) => 0xf2800000 | ((lsl / 16) << 21) | ((imm16 & 0xffff) << 5) | rd;
  const encAddImm = (rd, rn, imm12) => 0x91000000 | ((imm12 & 0xfff) << 10) | (rn << 5) | rd;
  const encSubImm = (rd, rn, imm12) => 0xd1000000 | ((imm12 & 0xfff) << 10) | (rn << 5) | rd;
  const encSubsImm = (rd, rn, imm12) => 0xf1000000 | ((imm12 & 0xfff) << 10) | (rn << 5) | rd;
  const encCmpImm = (rn, imm12) => encSubsImm(31, rn, imm12);
  const encAddReg = (rd, rn, rm) => 0x8b000000 | (rm << 16) | (rn << 5) | rd;
  const encAddRegShift = (rd, rn, rm, lsl) => 0x8b000000 | (rm << 16) | ((lsl & 0x3f) << 10) | (rn << 5) | rd;
  const encLslImm = (rd, rn, shift) => {
    const imms = (63 - shift) & 0x3f;
    const immr = (64 - shift) & 0x3f;
    return 0xd3400000 | (immr << 16) | (imms << 10) | (rn << 5) | rd;
  };
  const encAndImm3 = (rd, rn) => 0x53000000 | (0 << 16) | (1 << 10) | (rn << 5) | rd; // ubfx wd, wn, #0, #2

  const encLdrwImm = (rt, rn, imm12) => 0xb9400000 | (((imm12 / 4) & 0xfff) << 10) | (rn << 5) | rt;
  const encStrwImm = (rt, rn, imm12) => 0xb9000000 | (((imm12 / 4) & 0xfff) << 10) | (rn << 5) | rt;
  const encStrwPostIndex = (rt, rn, offset) => 0xb8000400 | ((offset & 0x1ff) << 12) | (rn << 5) | rt;
  const encLdrwRegOffset = (rt, rn, rm) => 0xb8607800 | (rm << 16) | (rn << 5) | rt;
  const encSvc = (imm16 = 0) => 0xd4000001 | (imm16 << 5);

  const encTbz = (rt, bit, targetOffset) => {
    const imm14 = ((targetOffset / 4) & 0x3fff);
    const b5 = (bit >> 5) & 1;
    const b40 = bit & 0x1f;
    return 0x36000000 | (b5 << 31) | (b40 << 19) | (imm14 << 5) | rt;
  };
  const encTbnz = (rt, bit, targetOffset) => {
    const imm14 = ((targetOffset / 4) & 0x3fff);
    const b5 = (bit >> 5) & 1;
    const b40 = bit & 0x1f;
    return 0x37000000 | (b5 << 31) | (b40 << 19) | (imm14 << 5) | rt;
  };

  const encB = (targetOffset) => {
    const imm26 = ((targetOffset / 4) & 0x3ffffff);
    return 0x14000000 | imm26;
  };
  const encBCond = (cond, targetOffset) => {
    const imm19 = ((targetOffset / 4) & 0x7ffff);
    return 0x54000000 | (imm19 << 5) | (cond & 0xf);
  };
  const encAdr = (rd, offsetBytes) => {
    const imm = offsetBytes & 0x1fffff;
    const immlo = imm & 3;
    const immhi = (imm >> 2) & 0x7ffff;
    return 0x10000000 | (immlo << 29) | (immhi << 5) | rd;
  };

  const COND_NE = 1, COND_GT = 12, COND_LT = 11;

  // Step 1: Initialize Permanent Pointers & State
  // x19 = 0x00800000 (VRAM_BASE), x20 = 0x00850000 (INPUT_BASE), x21 = prev_keys = 0
  instructions.push(encMovz(19, 0x0080, 16));              // x19 = 0x00800000 (VRAM_BASE)
  instructions.push(encMovz(20, 0x0085, 16));              // x20 = 0x00850000 (INPUT_BASE)
  instructions.push(encMovz(21, 0));                       // x21 = prev_keys = 0
  instructions.push(encMovz(4, 160));                      // x4 = cur_x = 160
  instructions.push(encMovz(5, 120));                      // x5 = cur_y = 120
  instructions.push(encMovz(6, 0));                        // x6 = color_idx = 0
  const ADR_PALETTE_IDX = instructions.length;
  instructions.push(0);                                    // placeholder: adr x10, #palette_table

  // Dark slate color word (#0F172A -> R=0x0f, G=0x17, B=0x2a, A=0xff -> 0xFF2A170F in LE)
  instructions.push(encMovz(2, 0x170f));
  instructions.push(encMovk(2, 0xff2a, 16));               // w2 = 0xFF2A170F

  // <clear_canvas>: Fill all 76,800 pixels with w2 (0xFF2A170F)
  const CLEAR_CANVAS_IDX = instructions.length;
  instructions.push(encAddImm(0, 19, 0));                  // x0 = VRAM_BASE
  instructions.push(encMovz(1, 0x2c00));                   // x1 = 76800 = 0x12c00
  instructions.push(encMovk(1, 1, 16));

  const CLEAR_LOOP_IDX = instructions.length;
  instructions.push(encStrwPostIndex(2, 0, 4));            // str w2, [x0], #4
  instructions.push(encSubsImm(1, 1, 1));                  // subs x1, x1, #1
  instructions.push(encBCond(COND_NE, (CLEAR_LOOP_IDX - instructions.length) * 4));

  // Initialize cursor backup address (x18) & saved pixel (w17) at (cur_x, cur_y)
  instructions.push(encLslImm(18, 5, 8));                  // x18 = y << 8
  instructions.push(encAddRegShift(18, 18, 5, 6));         // x18 += y << 6 (y * 320)
  instructions.push(encAddReg(18, 18, 4));                 // x18 += x
  instructions.push(encLslImm(18, 18, 2));                 // x18 *= 4
  instructions.push(encAddReg(18, 18, 19));                // x18 += VRAM_BASE
  instructions.push(encAddImm(17, 2, 0));                  // w17 = background color (0xFF2A170F)

  // <main_loop>:
  const MAIN_LOOP_IDX = instructions.length;

  // 0. Erase previous frame's white cursor dot before moving or painting
  instructions.push(encStrwImm(17, 18, 0));                // str w17, [x18]

  // 1. Read Inputs from x20 (INPUT_BASE)
  instructions.push(encLdrwImm(11, 20, 0));                // w11 = ldr [x20, #0] (KEY_STATE)
  instructions.push(encLdrwImm(12, 20, 16));               // w12 = ldr [x20, #16] (POINTER_BTN)

  // 2. Check Exit Key (bit 7 = 0x80)
  const EXIT_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbnz w11, #7, <exit>

  // 3. Check Clear Key (bit 6 = 0x40) with rising-edge detection: if newly pressed, save x21 and jump to <clear_canvas>
  instructions.push(encTbz(11, 6, 16));                    // tbz w11, #6, +16 (<skip_clear>)
  instructions.push(encTbnz(21, 6, 12));                   // tbnz w21, #6, +12 (<skip_clear>)
  instructions.push(encAddImm(21, 11, 0));                 // x21 = x11 (mark handled before jumping)
  const clearBranchDisp = (CLEAR_CANVAS_IDX - instructions.length) * 4;
  instructions.push(encB(clearBranchDisp));                // b <clear_canvas>

  // 4. Check Directional Keys
  // UP (bit 0): if held, y -= 2
  const UP_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w11, #0, <skip_up>
  instructions.push(encSubImm(5, 5, 2));
  instructions.push(encCmpImm(5, 4));
  instructions.push(encBCond(COND_GT, 8));
  instructions.push(encMovz(5, 4));
  const SKIP_UP_IDX = instructions.length;

  // DOWN (bit 1): if held, y += 2
  const DOWN_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w11, #1, <skip_down>
  instructions.push(encAddImm(5, 5, 2));
  instructions.push(encCmpImm(5, 235));
  instructions.push(encBCond(COND_LT, 8));
  instructions.push(encMovz(5, 235));
  const SKIP_DOWN_IDX = instructions.length;

  // LEFT (bit 2): if held, x -= 2
  const LEFT_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w11, #2, <skip_left>
  instructions.push(encSubImm(4, 4, 2));
  instructions.push(encCmpImm(4, 4));
  instructions.push(encBCond(COND_GT, 8));
  instructions.push(encMovz(4, 4));
  const SKIP_LEFT_IDX = instructions.length;

  // RIGHT (bit 3): if held, x += 2
  const RIGHT_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w11, #3, <skip_right>
  instructions.push(encAddImm(4, 4, 2));
  instructions.push(encCmpImm(4, 315));
  instructions.push(encBCond(COND_LT, 8));
  instructions.push(encMovz(4, 315));
  const SKIP_RIGHT_IDX = instructions.length;

  // 5. Mouse Pointer override if mouse clicked
  const MOUSE_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w12, #0, <skip_mouse>
  instructions.push(encLdrwImm(4, 20, 8));                 // cur_x = pointer_x
  instructions.push(encLdrwImm(5, 20, 12));                // cur_y = pointer_y
  const SKIP_MOUSE_IDX = instructions.length;

  // 6. Check Color Cycle Key (bit 5) with rising-edge detection (w11 bit 5 == 1 && w21 bit 5 == 0)
  const COLOR_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w11, #5, <skip_color>
  const COLOR_EDGE_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbnz w21, #5, <skip_color>
  instructions.push(encAddImm(6, 6, 1));                   // color_idx++
  instructions.push(encAndImm3(6, 6));                     // color_idx &= 3
  const SKIP_COLOR_IDX = instructions.length;

  // Save current keys into x21 for next frame's edge detection
  instructions.push(encAddImm(21, 11, 0));                 // x21 = x11

  // 7. Compute Current Cursor VRAM Address into x18 = VRAM_BASE + (cur_y * 320 + cur_x) * 4
  instructions.push(encLslImm(18, 5, 8));                  // x18 = y << 8 (256)
  instructions.push(encAddRegShift(18, 18, 5, 6));         // x18 += y << 6 (64) -> y * 320
  instructions.push(encAddReg(18, 18, 4));                 // x18 += x
  instructions.push(encLslImm(18, 18, 2));                 // x18 *= 4
  instructions.push(encAddReg(18, 18, 19));                // x18 += VRAM_BASE (x19)

  // 8. Check Paint Key (bit 4) or Mouse Button 0
  const PAINT_KEY_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w11, #4, <check_mouse_paint>
  instructions.push(encB(8));                              // jump over check_mouse_paint

  const CHK_MOUSE_PAINT_IDX = instructions.length;
  const PAINT_MOUSE_BRANCH_IDX = instructions.length;
  instructions.push(0);                                    // tbz w12, #0, <skip_paint>

  // <do_paint>: Paint 5-pixel cross brush at x18
  instructions.push(encLdrwRegOffset(14, 10, 6));          // w14 = palette[color_idx]
  instructions.push(encStrwImm(14, 18, 0));                // center
  instructions.push(encStrwImm(14, 18, 4));                // right
  instructions.push(encStrwImm(14, 18, 320 * 4));          // down (1280)
  instructions.push(encSubImm(16, 18, 4));
  instructions.push(encStrwImm(14, 16, 0));                // left
  instructions.push(encSubImm(16, 18, 320 * 4));
  instructions.push(encStrwImm(14, 16, 0));                // up
  const SKIP_PAINT_IDX = instructions.length;

  // 9. Save Underlying Pixel at [x18] into w17, then Draw White Cursor Dot (0xFFFFFFFF)
  instructions.push(encLdrwImm(17, 18, 0));                // w17 = underlying pixel at [x18]
  instructions.push(encMovz(16, 0xffff));
  instructions.push(encMovk(16, 0xffff, 16));              // w16 = 0xFFFFFFFF (White)
  instructions.push(encStrwImm(16, 18, 0));                // Put white cursor dot at [x18]

  // 10. VSync Yield (sys_sched_yield - syscall 124)
  instructions.push(encMovz(8, 124));                      // x8 = 124
  instructions.push(encSvc(0));                            // svc #0 (yield)

  // 11. Loop back to <main_loop>
  const loopDisp = (MAIN_LOOP_IDX - instructions.length) * 4;
  instructions.push(encB(loopDisp));

  // <exit>:
  const EXIT_TARGET_IDX = instructions.length;
  instructions.push(encMovz(0, 0));                        // x0 = 0 (exit code)
  instructions.push(encMovz(8, 93));                       // x8 = 93 (sys_exit)
  instructions.push(encSvc(0));                            // svc #0

  // Patch forward branches
  instructions[UP_BRANCH_IDX] = encTbz(11, 0, (SKIP_UP_IDX - UP_BRANCH_IDX) * 4);
  instructions[DOWN_BRANCH_IDX] = encTbz(11, 1, (SKIP_DOWN_IDX - DOWN_BRANCH_IDX) * 4);
  instructions[LEFT_BRANCH_IDX] = encTbz(11, 2, (SKIP_LEFT_IDX - LEFT_BRANCH_IDX) * 4);
  instructions[RIGHT_BRANCH_IDX] = encTbz(11, 3, (SKIP_RIGHT_IDX - RIGHT_BRANCH_IDX) * 4);
  instructions[MOUSE_BRANCH_IDX] = encTbz(12, 0, (SKIP_MOUSE_IDX - MOUSE_BRANCH_IDX) * 4);
  instructions[COLOR_BRANCH_IDX] = encTbz(11, 5, (SKIP_COLOR_IDX - COLOR_BRANCH_IDX) * 4);
  instructions[COLOR_EDGE_BRANCH_IDX] = encTbnz(21, 5, (SKIP_COLOR_IDX - COLOR_EDGE_BRANCH_IDX) * 4);
  instructions[PAINT_KEY_BRANCH_IDX] = encTbz(11, 4, (CHK_MOUSE_PAINT_IDX - PAINT_KEY_BRANCH_IDX) * 4);
  instructions[PAINT_MOUSE_BRANCH_IDX] = encTbz(12, 0, (SKIP_PAINT_IDX - PAINT_MOUSE_BRANCH_IDX) * 4);
  instructions[EXIT_BRANCH_IDX] = encTbnz(11, 7, (EXIT_TARGET_IDX - EXIT_BRANCH_IDX) * 4);

  // Palette lookup table in Little-Endian 0xAABBGGRR format:
  // 0: Cyan    (#38BDF8 -> R=0x38, G=0xBD, B=0xF8, A=0xFF -> 0xFFF8BD38)
  // 1: Amber   (#F59E0B -> R=0xF5, G=0x9E, B=0x0B, A=0xFF -> 0xFF0B9EF5)
  // 2: Emerald (#10B981 -> R=0x10, G=0xB9, B=0x81, A=0xFF -> 0xFF81B910)
  // 3: Rose    (#F43F5E -> R=0xF4, G=0x3F, B=0x5E, A=0xFF -> 0xFF5E3FF4)
  const PALETTE_DATA_OFFSET = instructions.length * 4;
  instructions[ADR_PALETTE_IDX] = encAdr(10, (PALETTE_DATA_OFFSET - ADR_PALETTE_IDX * 4));

  const paletteBuffer = Buffer.alloc(16);
  paletteBuffer.writeUInt32LE(0xfff8bd38, 0);  // Cyan    (#38BDF8)
  paletteBuffer.writeUInt32LE(0xff0b9ef5, 4);  // Amber   (#F59E0B)
  paletteBuffer.writeUInt32LE(0xff81b910, 8);  // Emerald (#10B981)
  paletteBuffer.writeUInt32LE(0xff5e3ff4, 12); // Rose    (#F43F5E)

  const msg = "[Mini-QEMU] Interactive Paint Session Ended cleanly.\n";
  const msgBuffer = Buffer.from(msg, "utf8");
  const dataPayload = Buffer.concat([paletteBuffer, msgBuffer]);

  return { buffer: buildElfWithPayload(instructions, dataPayload, 0x00400000n), instructionCount: instructions.length };
}

// Build and write binary
fs.mkdirSync(BIN_DIR, { recursive: true });
const { buffer: paintElf, instructionCount } = generateInteractivePaintElf();
const paintPath = path.join(BIN_DIR, "interactive_paint.elf");
fs.writeFileSync(paintPath, paintElf);
console.log(`[PASS] Built "${paintPath}" (${paintElf.length} bytes)`);

// Validate disassembly of all instructions
let validCount = 0;
for (let offset = 0x1000; offset < 0x1000 + instructionCount * 4; offset += 4) {
  const raw = paintElf.readUInt32LE(offset);
  const d = Decoder.decode(raw);
  if (d.type === "UNKNOWN") {
    console.error(`[ERROR] Unrecognized opcode 0x${raw.toString(16)} at offset 0x${offset.toString(16)}`);
    process.exit(1);
  }
  validCount++;
}
console.log(`[PASS] Validated all ${validCount} ARM64 instructions in interactive_paint.elf`);
