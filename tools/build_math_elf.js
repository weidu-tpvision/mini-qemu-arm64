// tools/build_math_elf.js - Builds an ARM64 ELF binary testing function calls, stack frames, and math
import fs from "fs";

function buildMathElf() {
  const instructions = [
    // _start (at 0x00400000):
    // 0x00: movz x0, #12
    0xd2800180,
    // 0x04: movz x1, #8
    0xd2800101,
    // 0x08: bl [offset +12B] -> calls calculate at 0x14 (saves LR = 0x0c)
    0x94000003,
    // 0x0c: movz x8, #93 (sys_exit)
    0xd2800ba8,
    // 0x10: svc  #0 (terminate with return value from X0)
    0xd4000001,

    // calculate(x0, x1) at 0x14:
    // 0x14: sub  sp, sp, #16
    0xd10043ff,
    // 0x18: stp  x29, x30, [sp, #0] (save FP and LR to stack)
    0xa9007bfd,
    // 0x1c: mul  x2, x0, x1 (12 * 8 = 96)
    0x9b017c02,
    // 0x20: movz x3, #2
    0xd2800043,
    // 0x24: udiv x2, x2, x3 (96 / 2 = 48)
    0x9ac30842,
    // 0x28: eor  x4, x0, x1 (12 ^ 8 = 4)
    0xca010004,
    // 0x2c: add  x0, x2, x4 (48 + 4 = 52)
    0x8b040040,
    // 0x30: ldp  x29, x30, [sp, #0] (restore FP and LR from stack)
    0xa9407bfd,
    // 0x34: add  sp, sp, #16 (deallocate stack)
    0x910043ff,
    // 0x38: ret (return to caller at LR = 0x0c)
    0xd65f03c0,
  ];

  const codeByteLength = instructions.length * 4;
  const codeOffset = 0x1000;
  const totalFileSize = codeOffset + codeByteLength;
  const buffer = Buffer.alloc(totalFileSize, 0);

  // 1. ELF64 Header
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46;
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // Little-endian
  buffer[6] = 1; // Version
  buffer[7] = 0; // System V
  buffer.writeUInt16LE(2, 16);             // ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18);         // EM_AARCH64
  buffer.writeUInt32LE(1, 20);              // Version 1
  buffer.writeBigUInt64LE(0x00400000n, 24); // e_entry
  buffer.writeBigUInt64LE(64n, 32);         // e_phoff
  buffer.writeBigUInt64LE(0n, 40);          // e_shoff
  buffer.writeUInt32LE(0, 48);              // e_flags
  buffer.writeUInt16LE(64, 52);             // e_ehsize
  buffer.writeUInt16LE(56, 54);             // e_phentsize
  buffer.writeUInt16LE(1, 56);              // e_phnum
  buffer.writeUInt16LE(64, 58);             // e_shentsize
  buffer.writeUInt16LE(0, 60);              // e_shnum
  buffer.writeUInt16LE(0, 62);              // e_shstrndx

  // 2. Program Header (PT_LOAD)
  const phOffset = 64;
  buffer.writeUInt32LE(1, phOffset + 0);                    // PT_LOAD
  buffer.writeUInt32LE(5, phOffset + 4);                    // PF_R | PF_X
  buffer.writeBigUInt64LE(BigInt(codeOffset), phOffset + 8); // File offset
  buffer.writeBigUInt64LE(0x00400000n, phOffset + 16);      // Virtual address
  buffer.writeBigUInt64LE(0x00400000n, phOffset + 24);      // Physical address
  buffer.writeBigUInt64LE(BigInt(codeByteLength), phOffset + 32); // File size
  buffer.writeBigUInt64LE(BigInt(codeByteLength), phOffset + 40); // Memory size
  buffer.writeBigUInt64LE(0x1000n, phOffset + 48);          // 4KB align

  // 3. Write code
  for (let i = 0; i < instructions.length; i++) {
    buffer.writeUInt32LE(instructions[i] >>> 0, codeOffset + i * 4);
  }

  fs.mkdirSync("bin", { recursive: true });
  fs.writeFileSync("bin/math_func.elf", buffer);
  console.log(`Generated "bin/math_func.elf" (${buffer.length} bytes, instructions: ${instructions.length})`);
}

buildMathElf();
