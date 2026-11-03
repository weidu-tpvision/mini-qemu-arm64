// tools/build_graphics_elf.js - Builds Level 1 MMIO Graphics ARM64 ELF Binaries
// Generates:
// 1. bin/graphics_pattern.elf - SMPTE-style vertical color bars & RGB gradient test pattern
// 2. bin/plasma.elf           - Procedural RGB demoscene plasma field into VRAM (0x00800000)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Decoder } from "../src/decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT_DIR, "bin");

// Helper to assemble standard ELF64 with code + read-only payload
function buildElfWithPayload(instructions, dataBuffer = Buffer.alloc(0), entryAddr = 0x00400000n) {
  const codeByteLength = instructions.length * 4;
  const payload = Buffer.concat([
    Buffer.from(new Uint32Array(instructions).buffer),
    dataBuffer
  ]);

  const codeOffset = 0x1000; // 4KB aligned
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

// ----------------------------------------------------------------------------
// 1. Build graphics_pattern.elf
// ----------------------------------------------------------------------------
export function generatePatternElf() {
  const msg = "[Mini-QEMU] Level 1 MMIO Test Pattern rendered to VRAM (0x00800000)!\n";
  const msgBuffer = Buffer.from(msg, "utf8");

  // Instruction encodings:
  // Base VRAM: x0 = 0x00800000
  // x1 = line counter
  // x2 = pixel color
  // x3 = bar index 0..7
  // x4 = inner pixel counter
  const instructions = [
    // 0x00: movz x0, #0x0080, lsl #16  (x0 = 0x00800000 = VRAM_BASE)
    0xd2a00000 | (0x0080 << 5) | 0,

    // --- TOP BARS (160 scanlines) ---
    // 0x04: movz x1, #160              (x1 = 160 lines)
    0xd2800000 | (160 << 5) | 1,

    // <line_loop>: offset 0x08 (instruction index 2)
    // 0x08: movz x3, #0                (x3 = bar index 0..7)
    0xd2800000 | (0 << 5) | 3,

    // <bar_loop>: offset 0x0c (instruction index 3)
    // 0x0c: adr  x5, #bar_colors_table (offset to table at 0x84: (0x84 - 0x0c) = 120B -> +30 instructions)
    0x10000000 | (30 << 5) | 5,
    // 0x10: ldr  w2, [x5, x3, lsl #2] (w2 = color from table)
    0xb86378a2,
    // 0x14: movz x4, #40               (x4 = 40 pixels per bar)
    0xd2800000 | (40 << 5) | 4,

    // <pixel_loop>: offset 0x18 (instruction index 6)
    // 0x18: str  w2, [x0], #4          (store pixel & increment x0 by 4)
    0xb8004402,
    // 0x1c: subs x4, x4, #1            (x4--)
    0xf1000484,
    // 0x20: b.ne 0x18                  (-2 instructions = -8 bytes -> imm19 = -2)
    0x54000000 | (((-2) & 0x7ffff) << 5) | 1,

    // Next bar:
    // 0x24: add  x3, x3, #1            (x3++)
    0x91000463,
    // 0x28: cmp  x3, #8                (subs xzr, x3, #8)
    0xf100207f,
    // 0x2c: b.ne 0x0c                  (-8 instructions)
    0x54000000 | (((-8) & 0x7ffff) << 5) | 1,

    // Next top line:
    // 0x30: subs x1, x1, #1            (x1--)
    0xf1000421,
    // 0x34: b.ne 0x08                  (-11 instructions)
    0x54000000 | (((-11) & 0x7ffff) << 5) | 1,

    // --- BOTTOM GRADIENT RAMPS (80 scanlines) ---
    // 0x38: movz x1, #80               (x1 = 80 lines remaining)
    0xd2800000 | (80 << 5) | 1,

    // <bottom_line_loop>: offset 0x3c (instruction index 15)
    // 0x3c: movz x4, #0                (x4 = pixel X coordinate 0..319)
    0xd2800000 | (0 << 5) | 4,

    // <bottom_pixel_loop>: offset 0x40 (instruction index 16)
    // 0x40: uxtb w2, w4                (w2 = Red = X & 0xFF)
    0x53000000 | (0 << 16) | (7 << 10) | (4 << 5) | 2,
    // 0x44: lsl  w6, w1, #2            (w6 = line * 4)
    0x53000000 | (30 << 16) | (29 << 10) | (1 << 5) | 6,
    // 0x48: uxtb w6, w6                (w6 = Green & 0xFF)
    0x53000000 | (0 << 16) | (7 << 10) | (6 << 5) | 6,
    // 0x4c: lsl  w6, w6, #8            (w6 = Green << 8)
    0x53000000 | (24 << 16) | (23 << 10) | (6 << 5) | 6,
    // 0x50: orr  w2, w2, w6            (w2 = (Green << 8) | Red)
    0x2a060042,
    // 0x54: uxtb w7, w1                (w7 = line & 0xFF)
    0x53000000 | (0 << 16) | (7 << 10) | (1 << 5) | 7,
    // 0x58: lsl  w7, w7, #16           (w7 = Blue << 16)
    0x53000000 | (16 << 16) | (15 << 10) | (7 << 5) | 7,
    // 0x5c: orr  w2, w2, w7            (w2 = (Blue << 16) | (Green << 8) | Red)
    0x2a070042,
    // 0x60: movz w7, #0xff00, lsl #16  (w7 = Alpha 0xFF000000)
    0x52800000 | (1 << 21) | (0xff00 << 5) | 7,
    // 0x64: orr  w2, w2, w7            (w2 |= Alpha)
    0x2a070042,

    // 0x68: str  w2, [x0], #4          (store pixel & increment x0 by 4)
    0xb8004402,
    // 0x6c: add  x4, x4, #1            (x4++)
    0x91000484,
    // 0x70: cmp  x4, #320              (subs xzr, x4, #320)
    0xf105009f,
    // 0x74: b.ne 0x40                  (-13 instructions -> imm19 = -13)
    0x54000000 | (((-13) & 0x7ffff) << 5) | 1,

    // 0x78: subs x1, x1, #1            (x1--)
    0xf1000421,
    // 0x7c: b.ne 0x3c                  (-16 instructions -> imm19 = -16)
    0x54000000 | (((-16) & 0x7ffff) << 5) | 1,

    // --- Jump over Bar Colors Table ---
    // 0x80: b  #after_table            (jump over 8 table words: +9 instructions -> to 0xa4)
    0x14000000 | (9 & 0x3ffffff),

    // --- Table of 8 Bar Colors at 0x84 (8 words = 32 bytes) ---
    0xffffffff, // Bar 0: White
    0xff00ffff, // Bar 1: Yellow
    0xffffff00, // Bar 2: Cyan
    0xff00ff00, // Bar 3: Green
    0xffff00ff, // Bar 4: Magenta
    0xff0000ff, // Bar 5: Red
    0xffff0000, // Bar 6: Blue
    0xff1a1a1a, // Bar 7: Dark Gray / Black

    // <after_table>: offset 0xa4
    // 0xa4: movz x0, #1                (fd = 1 stdout)
    0xd2800020,
    // 0xa8: adr  x1, #msg              (offset to msg at 0xc4: (0xc4 - 0xa8) = 28B = +7 instructions)
    0x100000e1,
    // 0xac: movz x2, #len              (msg length)
    0xd2800000 | (msgBuffer.length << 5) | 2,
    // 0xb0: movz x8, #64               (syscall 64: sys_write)
    0xd2800808,
    // 0xb4: svc  #0                    (trap to host)
    0xd4000001,

    // --- Exit via sys_exit(0) ---
    // 0xb8: movz x0, #0                (code 0)
    0xd2800000,
    // 0xbc: movz x8, #93               (syscall 93: sys_exit)
    0xd2800ba8,
    // 0xc0: svc  #0                    (exit)
    0xd4000001,
  ];

  return buildElfWithPayload(instructions, msgBuffer);
}

// ----------------------------------------------------------------------------
// 2. Build plasma.elf
// ----------------------------------------------------------------------------
export function generatePlasmaElf() {
  const msg = "[Mini-QEMU] Level 1 MMIO Plasma rendered 76,800 pixels into VRAM (0x00800000)!\n";
  const msgBuffer = Buffer.from(msg, "utf8");

  const instructions = [
    // 0x00: movz x0, #0x0080, lsl #16  (x0 = 0x00800000 = VRAM_BASE)
    0xd2a00000 | (0x0080 << 5) | 0,

    // 0x04: movz x1, #0                (x1 = Y coordinate: 0..239)
    0xd2800000 | (0 << 5) | 1,

    // <y_loop>: offset 0x08 (instruction index 2)
    // 0x08: movz x2, #0                (x2 = X coordinate: 0..319)
    0xd2800000 | (0 << 5) | 2,

    // <x_loop>: offset 0x0c (instruction index 3)
    // 0x0c: eor  w3, w2, w1            (w3 = X ^ Y)
    0x4a010043,
    // 0x10: uxtb w3, w3                (Red = (X ^ Y) & 0xFF)
    0x53000000 | (0 << 16) | (7 << 10) | (3 << 5) | 3,

    // 0x14: add  w4, w2, w1            (w4 = X + Y)
    0x0b010044,
    // 0x18: uxtb w4, w4                (w4 = (X + Y) & 0xFF)
    0x53000000 | (0 << 16) | (7 << 10) | (4 << 5) | 4,
    // 0x1c: lsl  w4, w4, #8            (Green = w4 << 8)
    0x53000000 | (24 << 16) | (23 << 10) | (4 << 5) | 4,
    // 0x20: orr  w3, w3, w4            (Color = Green | Red)
    0x2a040063,

    // 0x24: lsl  w5, w2, #1            (w5 = 2*X)
    0x53000000 | (31 << 16) | (30 << 10) | (2 << 5) | 5,
    // 0x28: add  w5, w5, w2            (w5 = 3*X)
    0x0b0200a5,
    // 0x2c: uxtb w5, w5                (w5 & 0xFF)
    0x53000000 | (0 << 16) | (7 << 10) | (5 << 5) | 5,
    // 0x30: lsl  w5, w5, #16           (Blue = (3*X) << 16)
    0x53000000 | (16 << 16) | (15 << 10) | (5 << 5) | 5,
    // 0x34: orr  w3, w3, w5            (Color |= Blue)
    0x2a050063,

    // 0x38: movz w6, #0xff00, lsl #16  (Alpha = 0xFF000000)
    0x52800000 | (1 << 21) | (0xff00 << 5) | 6,
    // 0x3c: orr  w3, w3, w6            (Color |= Alpha)
    0x2a060063,

    // 0x40: str  w3, [x0], #4          (store pixel word & advance x0 by 4)
    0xb8004403,

    // Advance X:
    // 0x44: add  x2, x2, #1            (X++)
    0x91000442,
    // 0x48: cmp  x2, #320              (X == 320?)
    0xf105005f,
    // 0x4c: b.ne 0x0c                  (-16 instructions -> imm19 = -16)
    0x54000000 | (((-16) & 0x7ffff) << 5) | 1,

    // Advance Y:
    // 0x50: add  x1, x1, #1            (Y++)
    0x91000421,
    // 0x54: cmp  x1, #240              (Y == 240?)
    0xf103c03f,
    // 0x58: b.ne 0x08                  (-20 instructions -> imm19 = -20)
    0x54000000 | (((-20) & 0x7ffff) << 5) | 1,

    // --- Output Message via sys_write ---
    // 0x5c: movz x0, #1                (fd = 1 stdout)
    0xd2800020,
    // 0x60: adr  x1, #msg              (offset to msg at 0x7c: (0x7c - 0x60) = 28B = +7 instructions)
    0x100000e1,
    // 0x64: movz x2, #len              (msg length)
    0xd2800000 | (msgBuffer.length << 5) | 2,
    // 0x68: movz x8, #64               (sys_write)
    0xd2800808,
    // 0x6c: svc  #0                    (write)
    0xd4000001,

    // --- Exit ---
    // 0x70: movz x0, #0                (code 0)
    0xd2800000,
    // 0x74: movz x8, #93               (sys_exit)
    0xd2800ba8,
    // 0x78: svc  #0                    (exit)
    0xd4000001,
  ];

  return buildElfWithPayload(instructions, msgBuffer);
}

// Generate files
fs.mkdirSync(BIN_DIR, { recursive: true });

const patternElf = generatePatternElf();
fs.writeFileSync(path.join(BIN_DIR, "graphics_pattern.elf"), patternElf);
console.log(`Generated "bin/graphics_pattern.elf" (${patternElf.length} bytes)`);

const plasmaElf = generatePlasmaElf();
fs.writeFileSync(path.join(BIN_DIR, "plasma.elf"), plasmaElf);
console.log(`Generated "bin/plasma.elf" (${plasmaElf.length} bytes)`);
