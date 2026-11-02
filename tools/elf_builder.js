// tools/elf_builder.js - Generates a valid standard ELF64 ARM64 Executable Binary
import fs from "fs";

export function buildElf64(instructions, entryAddr = 0x00400000n) {
  const codeByteLength = instructions.length * 4;
  const codeOffset = 0x1000; // 4KB page aligned
  const totalFileSize = codeOffset + codeByteLength;

  const buffer = Buffer.alloc(totalFileSize, 0);

  // -------------------------------------------------------------
  // 1. ELF Header (64 bytes)
  // -------------------------------------------------------------
  // e_ident[16]
  buffer[0] = 0x7f;
  buffer[1] = 0x45; // 'E'
  buffer[2] = 0x4c; // 'L'
  buffer[3] = 0x46; // 'F'
  buffer[4] = 2;    // EI_CLASS: 2 = 64-bit (ELFCLASS64)
  buffer[5] = 1;    // EI_DATA: 1 = Little-Endian (ELFDATA2LSB)
  buffer[6] = 1;    // EI_VERSION: 1 (EV_CURRENT)
  buffer[7] = 0;    // EI_OSABI: 0 = System V / Linux
  // bytes 8..15 are 0 (ABI version & padding)

  buffer.writeUInt16LE(2, 16);             // e_type: ET_EXEC (Executable file)
  buffer.writeUInt16LE(0x00b7, 18);         // e_machine: 183 = EM_AARCH64 (ARM 64-bit)
  buffer.writeUInt32LE(1, 20);              // e_version: 1
  buffer.writeBigUInt64LE(entryAddr, 24);   // e_entry: Entry point address
  buffer.writeBigUInt64LE(64n, 32);         // e_phoff: Program header offset (at byte 64)
  buffer.writeBigUInt64LE(0n, 40);          // e_shoff: Section header offset (none)
  buffer.writeUInt32LE(0, 48);              // e_flags: Architecture-specific flags
  buffer.writeUInt16LE(64, 52);             // e_ehsize: ELF header size (64 bytes)
  buffer.writeUInt16LE(56, 54);             // e_phentsize: Program header size (56 bytes)
  buffer.writeUInt16LE(1, 56);              // e_phnum: Number of program headers (1)
  buffer.writeUInt16LE(64, 58);             // e_shentsize: Section header size
  buffer.writeUInt16LE(0, 60);              // e_shnum: Number of section headers
  buffer.writeUInt16LE(0, 62);              // e_shstrndx: Section header string table index

  // -------------------------------------------------------------
  // 2. Program Header 0: PT_LOAD Segment (56 bytes, starts at offset 64)
  // -------------------------------------------------------------
  const phOffset = 64;
  buffer.writeUInt32LE(1, phOffset + 0);                    // p_type: 1 = PT_LOAD (Loadable segment)
  buffer.writeUInt32LE(5, phOffset + 4);                    // p_flags: PF_R (4) | PF_X (1) = 5 (Read/Execute)
  buffer.writeBigUInt64LE(BigInt(codeOffset), phOffset + 8); // p_offset: File offset of segment
  buffer.writeBigUInt64LE(entryAddr, phOffset + 16);        // p_vaddr: Virtual address in RAM
  buffer.writeBigUInt64LE(entryAddr, phOffset + 24);        // p_paddr: Physical address in RAM
  buffer.writeBigUInt64LE(BigInt(codeByteLength), phOffset + 32); // p_filesz: Segment size in file
  buffer.writeBigUInt64LE(BigInt(codeByteLength), phOffset + 40); // p_memsz: Segment size in memory
  buffer.writeBigUInt64LE(0x1000n, phOffset + 48);          // p_align: 4KB page alignment

  // -------------------------------------------------------------
  // 3. Write Machine Code into Segment (at codeOffset = 0x1000)
  // -------------------------------------------------------------
  for (let i = 0; i < instructions.length; i++) {
    buffer.writeUInt32LE(instructions[i] >>> 0, codeOffset + i * 4);
  }

  return buffer;
}

// Generate fib.elf
const fibonacciInstructions = [
  0xd2800000, // 0x00: movz x0, #0       (a = 0)
  0xd2800021, // 0x04: movz x1, #1       (b = 1)
  0xd2800142, // 0x08: movz x2, #10      (n = 10, loop count)
  // <loop>:
  0x8b010003, // 0x0c: add  x3, x0, x1   (next = a + b)
  0xaa0103e0, // 0x10: mov  x0, x1       (a = b)
  0xaa0303e1, // 0x14: mov  x1, x3       (b = next)
  0xf1000442, // 0x18: subs x2, x2, #1   (n = n - 1, sets flags)
  0x54ffff81, // 0x1c: b.ne 0x0c         (branch to <loop> if n != 0)
  // <exit>:
  0xd2800ba8, // 0x20: movz x8, #93      (x8 = 93, Linux sys_exit)
  0xd4000001, // 0x24: svc  #0           (supervisor call trap)
];

const elfBuffer = buildElf64(fibonacciInstructions, 0x00400000n);
fs.mkdirSync("bin", { recursive: true });
fs.writeFileSync("bin/fib.elf", elfBuffer);
console.log(`Generated standard ARM64 ELF executable: bin/fib.elf (${elfBuffer.length} bytes, Entry Point: 0x00400000)`);
