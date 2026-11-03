// tools/build_heap_demo_elf.js - Generates bin/heap_demo.elf testing dynamic heap allocation via sys_brk
import fs from "fs";

function buildHeapDemoElf() {
  const message = "[Heap Demo] Allocated 40 bytes on heap via sys_brk! Sum = 150\n";
  const messageBytes = Buffer.from(message, "utf8");

  const instructions = [
    // 0x00: movz x0, #0 (query brk)
    0xd2800000,
    // 0x04: movz x8, #214 (sys_brk)
    0xd2801ac8,
    // 0x08: svc  #0 (returns current break in X0)
    0xd4000001,

    // 0x0c: orr  x19, xzr, x0 (save buffer pointer into X19)
    0xaa0003f3,

    // 0x10: add  x0, x19, #40 (request 40 bytes)
    0x9100a260,
    // 0x14: movz x8, #214 (sys_brk)
    0xd2801ac8,
    // 0x18: svc  #0 (returns new break in X0)
    0xd4000001,

    // Write 5 64-bit integers to heap:
    // 0x1c: movz x1, #10
    0xd2800141,
    // 0x20: str  x1, [x19, #0]
    0xf9000261,

    // 0x24: movz x1, #20
    0xd2800281,
    // 0x28: str  x1, [x19, #8]
    0xf9000661,

    // 0x2c: movz x1, #30
    0xd28003c1,
    // 0x30: str  x1, [x19, #16]
    0xf9000a61,

    // 0x34: movz x1, #40
    0xd2800501,
    // 0x38: str  x1, [x19, #24]
    0xf9000e61,

    // 0x3c: movz x1, #50
    0xd2800641,
    // 0x40: str  x1, [x19, #32]
    0xf9001261,

    // Read back and sum into X20:
    // 0x44: movz x20, #0
    0xd2800014,

    // 0x48: ldr  x1, [x19, #0]
    0xf9400261,
    // 0x4c: add  x20, x20, x1
    0x8b010294,

    // 0x50: ldr  x1, [x19, #8]
    0xf9400661,
    // 0x54: add  x20, x20, x1
    0x8b010294,

    // 0x58: ldr  x1, [x19, #16]
    0xf9400a61,
    // 0x5c: add  x20, x20, x1
    0x8b010294,

    // 0x60: ldr  x1, [x19, #24]
    0xf9400e61,
    // 0x64: add  x20, x20, x1
    0x8b010294,

    // 0x68: ldr  x1, [x19, #32]
    0xf9401261,
    // 0x6c: add  x20, x20, x1
    0x8b010294,

    // Print message via sys_write:
    // 0x70: movz x0, #1 (stdout)
    0xd2800020,
    // 0x74: adr  x1, [offset +28B] -> message at 0x90
    0x100000e1,
    // 0x78: movz x2, #63 (message length)
    0xd28007e2,
    // 0x7c: movz x8, #64 (sys_write)
    0xd2800808,
    // 0x80: svc  #0
    0xd4000001,

    // Exit with sum (150) as exit code:
    // 0x84: orr  x0, xzr, x20
    0xaa1403e0,
    // 0x88: movz x8, #93 (sys_exit)
    0xd2800ba8,
    // 0x8c: svc  #0
    0xd4000001,
  ];

  const codeBytes = Buffer.alloc(instructions.length * 4);
  for (let i = 0; i < instructions.length; i++) {
    codeBytes.writeUInt32LE(instructions[i] >>> 0, i * 4);
  }

  const payload = Buffer.concat([codeBytes, messageBytes]);
  const entryAddr = 0x00400000n;
  const codeOffset = 0x1000;
  const totalFileSize = codeOffset + payload.length;
  const buffer = Buffer.alloc(totalFileSize, 0);

  // ELF64 Header
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46; // Magic
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // Little-Endian
  buffer[6] = 1; // Version
  buffer[7] = 0; // System V
  buffer.writeUInt16LE(2, 16);             // ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18);         // EM_AARCH64
  buffer.writeUInt32LE(1, 20);              // Version 1
  buffer.writeBigUInt64LE(entryAddr, 24);   // e_entry
  buffer.writeBigUInt64LE(64n, 32);         // e_phoff
  buffer.writeBigUInt64LE(0n, 40);          // e_shoff
  buffer.writeUInt32LE(0, 48);              // e_flags
  buffer.writeUInt16LE(64, 52);             // e_ehsize
  buffer.writeUInt16LE(56, 54);             // e_phentsize
  buffer.writeUInt16LE(1, 56);              // e_phnum (1 segment)

  // Program Header (PT_LOAD)
  buffer.writeUInt32LE(1, 64);                    // p_type = PT_LOAD
  buffer.writeUInt32LE(7, 68);                    // p_flags = RWX (1 | 2 | 4)
  buffer.writeBigUInt64LE(BigInt(codeOffset), 72);// p_offset
  buffer.writeBigUInt64LE(entryAddr, 80);         // p_vaddr
  buffer.writeBigUInt64LE(entryAddr, 88);         // p_paddr
  buffer.writeBigUInt64LE(BigInt(payload.length), 96);  // p_filesz
  buffer.writeBigUInt64LE(BigInt(payload.length), 104); // p_memsz
  buffer.writeBigUInt64LE(4096n, 112);            // p_align

  payload.copy(buffer, codeOffset);

  if (!fs.existsSync("bin")) {
    fs.mkdirSync("bin", { recursive: true });
  }
  fs.writeFileSync("bin/heap_demo.elf", buffer);
  console.log(`[ELF Builder] Successfully generated "bin/heap_demo.elf" (${buffer.length} bytes, payload: ${payload.length}B)`);
}

buildHeapDemoElf();
