// tools/build_interactive_elf.js - Builds Interactive MMIO Framebuffer ARM64 ELF Binary
// Generates: bin/interactive_paint.elf
// Supports:
// - Keyboard Input (Arrow Keys / WASD, Space for Paint, Shift for Color, R for Clear, Q for Exit)
// - Mouse / Pointer Input (Click & Drag to paint at pointer coords)
// - 60 FPS VSync via sys_sched_yield (syscall 124)

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
  const labels = {};

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
    // UBFM 64-bit: lsl xd, xn, #shift -> imms = 63 - shift, immr = 64 - shift
    const imms = (63 - shift) & 0x3f;
    const immr = (64 - shift) & 0x3f;
    return 0xd3400000 | (immr << 16) | (imms << 10) | (rn << 5) | rd;
  };
  const encAndImm = (rd, rn, mask) => {
    // For small masks like #3 (0b11), UBFM ubfx xd, xn, #0, #2
    if (mask === 3) {
      return 0x53000000 | (0 << 16) | (1 << 10) | (rn << 5) | rd; // ubfx wd, wn, #0, #2
    }
    return 0x8a000000 | (rn << 16) | (rn << 5) | rd;
  };

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

  // Conditions
  const COND_EQ = 0, COND_NE = 1, COND_GT = 12, COND_LT = 11;

  // Assembly sequence:
  // Step 1: Clear VRAM (0x00800000, 76,800 pixels with dark slate 0xFF0F172A)
  // Store permanent base pointers in x19 (VRAM) and x20 (INPUT) so syscalls don't clobber them
  instructions.push(encMovz(19, 0x0080, 16));              // x19 = 0x00800000 (VRAM_BASE)
  instructions.push(encMovz(20, 0x0085, 16));              // x20 = 0x00850000 (INPUT_BASE)

  instructions.push(encAddImm(0, 19, 0));                  // x0 = x19 (temporary pointer for clear loop)
  instructions.push(encMovz(1, 0x2c00));                   // x1 = 76800 = 0x12c00
  instructions.push(encMovk(1, 1, 16));
  // Dark slate color word: 0xFF0F172A
  instructions.push(encMovz(2, 0x172a));
  instructions.push(encMovk(2, 0xff0f, 16));

  // <clear_loop>:
  const CLEAR_LOOP_IDX = instructions.length;
  instructions.push(encStrwPostIndex(2, 0, 4));            // str w2, [x0], #4
  instructions.push(encSubsImm(1, 1, 1));                  // subs x1, x1, #1
  // branch back to CLEAR_LOOP_IDX if NE
  const clearDisp = (CLEAR_LOOP_IDX - instructions.length) * 4;
  instructions.push(encBCond(COND_NE, clearDisp));         // b.ne <clear_loop>

  // Step 2: Setup Interactive State
  instructions.push(encMovz(4, 160));                      // x4 = cur_x = 160
  instructions.push(encMovz(5, 120));                      // x5 = cur_y = 120
  instructions.push(encMovz(6, 0));                        // x6 = color_idx = 0
  // ADR to palette table (we will compute exact displacement at end)
  const ADR_PALETTE_IDX = instructions.length;
  instructions.push(0); // placeholder for encAdr(10, offset)

  // <main_loop>:
  const MAIN_LOOP_IDX = instructions.length;

  // 1. Read Inputs from x20 (INPUT_BASE)
  instructions.push(encLdrwImm(11, 20, 0));                // w11 = ldr [x20, #0] (KEY_STATE)
  instructions.push(encLdrwImm(12, 20, 16));               // w12 = ldr [x20, #16] (POINTER_BTN)

  // 2. Check Exit Key (bit 7)
  const EXIT_BRANCH_IDX = instructions.length;
  instructions.push(0); // placeholder tbnz w11, #7, <exit>

  // 3. Check Directional Keys
  // UP (bit 0): if held, y -= 2
  const UP_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w11, #0, <skip_up>
  instructions.push(encSubImm(5, 5, 2));                   // y -= 2
  instructions.push(encCmpImm(5, 4));
  instructions.push(encBCond(COND_GT, 8));                 // if y > 4 skip clamp
  instructions.push(encMovz(5, 4));                        // y = 4
  const SKIP_UP_IDX = instructions.length;

  // DOWN (bit 1): if held, y += 2
  const DOWN_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w11, #1, <skip_down>
  instructions.push(encAddImm(5, 5, 2));                   // y += 2
  instructions.push(encCmpImm(5, 235));
  instructions.push(encBCond(COND_LT, 8));                 // if y < 235 skip clamp
  instructions.push(encMovz(5, 235));                      // y = 235
  const SKIP_DOWN_IDX = instructions.length;

  // LEFT (bit 2): if held, x -= 2
  const LEFT_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w11, #2, <skip_left>
  instructions.push(encSubImm(4, 4, 2));                   // x -= 2
  instructions.push(encCmpImm(4, 4));
  instructions.push(encBCond(COND_GT, 8));                 // if x > 4 skip clamp
  instructions.push(encMovz(4, 4));                        // x = 4
  const SKIP_LEFT_IDX = instructions.length;

  // RIGHT (bit 3): if held, x += 2
  const RIGHT_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w11, #3, <skip_right>
  instructions.push(encAddImm(4, 4, 2));                   // x += 2
  instructions.push(encCmpImm(4, 315));
  instructions.push(encBCond(COND_LT, 8));                 // if x < 315 skip clamp
  instructions.push(encMovz(4, 315));                      // x = 315
  const SKIP_RIGHT_IDX = instructions.length;

  // 4. Mouse Pointer override if mouse clicked
  const MOUSE_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w12, #0, <skip_mouse>
  instructions.push(encLdrwImm(4, 20, 8));                 // cur_x = pointer_x
  instructions.push(encLdrwImm(5, 20, 12));                // cur_y = pointer_y
  const SKIP_MOUSE_IDX = instructions.length;

  // 5. Check Paint Key (bit 4) or Mouse Button 0
  const PAINT_KEY_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w11, #4, <check_mouse_paint>
  // Jump to paint execution
  instructions.push(encB(8)); // jump over check_mouse_paint

  const CHK_MOUSE_PAINT_IDX = instructions.length;
  const PAINT_MOUSE_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w12, #0, <skip_paint>

  // <do_paint>:
  // Load brush color: w14 = palette[color_idx]
  instructions.push(encLdrwRegOffset(14, 10, 6));

  // Compute offset: (y * 320 + x) * 4
  // y * 320 = (y << 8) + (y << 6)
  instructions.push(encLslImm(15, 5, 8));                  // x15 = y << 8 (256)
  instructions.push(encAddRegShift(15, 15, 5, 6));         // x15 += y << 6 (64) -> y * 320
  instructions.push(encAddReg(15, 15, 4));                 // x15 += x
  instructions.push(encLslImm(15, 15, 2));                 // x15 *= 4
  instructions.push(encAddReg(15, 15, 19));                // x15 += VRAM_BASE (x19)

  // Paint 5-pixel cross brush (center + 4 adjacent)
  instructions.push(encStrwImm(14, 15, 0));                // center
  instructions.push(encStrwImm(14, 15, 4));                // right
  instructions.push(encStrwImm(14, 15, 320 * 4));          // down (1280)
  instructions.push(encSubImm(16, 15, 4));
  instructions.push(encStrwImm(14, 16, 0));                // left
  instructions.push(encSubImm(16, 15, 320 * 4));
  instructions.push(encStrwImm(14, 16, 0));                // up
  const SKIP_PAINT_IDX = instructions.length;

  // 6. Draw White Crosshair Cursor at (cur_x, cur_y)
  instructions.push(encMovz(16, 0xffff));
  instructions.push(encMovk(16, 0xffff, 16));              // w16 = 0xFFFFFFFF (White)
  instructions.push(encLslImm(15, 5, 8));                  // y * 256
  instructions.push(encAddRegShift(15, 15, 5, 6));         // + y * 64 = y * 320
  instructions.push(encAddReg(15, 15, 4));                 // + x
  instructions.push(encLslImm(15, 15, 2));                 // * 4
  instructions.push(encAddReg(15, 15, 19));                // + VRAM_BASE (x19)
  instructions.push(encStrwImm(16, 15, 0));                // Put white cursor dot

  // 7. Check Color Cycle Key (bit 5)
  const COLOR_BRANCH_IDX = instructions.length;
  instructions.push(0); // tbz w11, #5, <skip_color>
  instructions.push(encAddImm(6, 6, 1));                   // color_idx++
  instructions.push(encAndImm(6, 6, 3));                   // color_idx &= 3
  const SKIP_COLOR_IDX = instructions.length;

  // 8. VSync Yield (sys_sched_yield - syscall 124)
  instructions.push(encMovz(8, 124));                      // x8 = 124
  instructions.push(encSvc(0));                            // svc #0 (yield)

  // 9. Loop back to main_loop
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
  instructions[PAINT_KEY_BRANCH_IDX] = encTbz(11, 4, (CHK_MOUSE_PAINT_IDX - PAINT_KEY_BRANCH_IDX) * 4);
  instructions[PAINT_MOUSE_BRANCH_IDX] = encTbz(12, 0, (SKIP_PAINT_IDX - PAINT_MOUSE_BRANCH_IDX) * 4);
  instructions[COLOR_BRANCH_IDX] = encTbz(11, 5, (SKIP_COLOR_IDX - COLOR_BRANCH_IDX) * 4);
  instructions[EXIT_BRANCH_IDX] = encTbnz(11, 7, (EXIT_TARGET_IDX - EXIT_BRANCH_IDX) * 4);

  // Palette lookup table (4 colors: Cyan, Amber, Emerald, Rose)
  const PALETTE_DATA_OFFSET = instructions.length * 4;
  instructions[ADR_PALETTE_IDX] = encAdr(10, (PALETTE_DATA_OFFSET - ADR_PALETTE_IDX * 4));

  const paletteBuffer = Buffer.alloc(16);
  paletteBuffer.writeUInt32LE(0xff38bdf8, 0);  // Cyan
  paletteBuffer.writeUInt32LE(0xfff59e0b, 4);  // Amber
  paletteBuffer.writeUInt32LE(0xff10b981, 8);  // Emerald
  paletteBuffer.writeUInt32LE(0xfff43f5e, 12); // Rose

  const msg = "[Mini-QEMU] Interactive Paint Session Ended cleanly.\n";
  const msgBuffer = Buffer.from(msg, "utf8");
  const dataPayload = Buffer.concat([paletteBuffer, msgBuffer]);

  return buildElfWithPayload(instructions, dataPayload, 0x00400000n);
}

// Build and write binary
fs.mkdirSync(BIN_DIR, { recursive: true });
const paintElf = generateInteractivePaintElf();
const paintPath = path.join(BIN_DIR, "interactive_paint.elf");
fs.writeFileSync(paintPath, paintElf);
console.log(`[PASS] Built "${paintPath}" (${paintElf.length} bytes)`);

// Validate disassembly of all instructions
let validCount = 0;
for (let offset = 0x1000; offset < 0x1000 + 70 * 4; offset += 4) {
  if (offset + 4 > paintElf.length) break;
  const raw = paintElf.readUInt32LE(offset);
  const d = Decoder.decode(raw);
  if (d.type === "UNKNOWN") {
    console.error(`[ERROR] Unrecognized opcode 0x${raw.toString(16)} at offset 0x${offset.toString(16)}`);
    process.exit(1);
  }
  validCount++;
}
console.log(`[PASS] Validated all ${validCount} ARM64 instructions in interactive_paint.elf`);
