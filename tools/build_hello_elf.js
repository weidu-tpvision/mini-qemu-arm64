// tools/build_hello_elf.js - Generates hello.elf for Mini-QEMU
import fs from "fs";

function buildHelloElf() {
  const message = "Hello from ARM64 running on Windows via Mini-QEMU!\n";
  const messageBytes = Buffer.from(message, "utf8");

  // Instructions array
  const instructions = [
    // 0x00: movz x4, #0x1234 (4660)
    0xd2824684,
    // 0x04: movz x5, #0x0040, lsl #16 (0x00400000)
    0xd2a00805,
    // 0x08: add  x5, x5, #2, lsl #12 (Adds 0x2000 -> x5 = 0x00402000, safe RAM data area!)
    0x914008a5,
    // 0x0c: str  x4, [x5, #0] (Write 0x1234 to virtual RAM at 0x00402000)
    0xf90000a4,
    // 0x10: ldr  x6, [x5, #0] (Read it back into X6)
    0xf94000a6,

    // 0x14: movz x0, #1 (fd = stdout)
    0xd2800020,
    // 0x18: adr  x1, [offset +28B] (points to message at 0x34)
    0x100000e1,
    // 0x1c: movz x2, #51 (message length = 51 bytes)
    0xd2800662,
    // 0x20: movz x8, #64 (syscall 64: sys_write)
    0xd2800808,
    // 0x24: svc  #0 (supervisor call trap: prints message!)
    0xd4000001,

    // 0x28: movz x0, #0 (exit code 0)
    0xd2800000,
    // 0x2c: movz x8, #93 (syscall 93: sys_exit)
    0xd2800ba8,
    // 0x30: svc  #0 (supervisor call trap: exits)
    0xd4000001,
  ];

  const codeBytes = Buffer.alloc(instructions.length * 4);
  for (let i = 0; i < instructions.length; i++) {
    codeBytes.writeUInt32LE(instructions[i] >>> 0, i * 4);
  }

  // Combined payload: instructions + embedded string
  const payload = Buffer.concat([codeBytes, messageBytes]);

  const entryAddr = 0x00400000n;
  const codeOffset = 0x1000;
  const totalFileSize = codeOffset + payload.length;
  const buffer = Buffer.alloc(totalFileSize, 0);

  // 1. ELF Header
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46; // Magic
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // Little-Endian
  buffer[6] = 1; // Version
  buffer[7] = 0; // System V / Linux
  buffer.writeUInt16LE(2, 16);             // ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18);         // EM_AARCH64 (183)
  buffer.writeUInt32LE(1, 20);              // Version 1
  buffer.writeBigUInt64LE(entryAddr, 24);   // e_entry: 0x00400000
  buffer.writeBigUInt64LE(64n, 32);         // e_phoff: 64
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
  buffer.writeBigUInt64LE(entryAddr, phOffset + 16);        // Virtual address
  buffer.writeBigUInt64LE(entryAddr, phOffset + 24);        // Physical address
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 32); // File size
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 40); // Memory size
  buffer.writeBigUInt64LE(0x1000n, phOffset + 48);          // 4KB align

  // 3. Write payload into segment
  payload.copy(buffer, codeOffset);

  fs.mkdirSync("bin", { recursive: true });
  fs.writeFileSync("bin/hello.elf", buffer);
  console.log(`Successfully generated "bin/hello.elf" (${buffer.length} bytes)`);
}

buildHelloElf();
