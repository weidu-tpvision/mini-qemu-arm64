// tools/build_dynamic_elf.js - Generates dynamic ARM64 shared library (.so) and executable (.elf)
import fs from "fs";
import path from "path";
import { DynamicTag, RelocationType } from "../src/dynamic_linker.js";

const OUT_DIR = "bin";
fs.mkdirSync(OUT_DIR, { recursive: true });

/**
 * Builds an ARM64 Shared Library (.so) with exported functions and DT_DYNAMIC table.
 */
export function buildSharedLibrary() {
  const fileSize = 0x2000;
  const buffer = Buffer.alloc(fileSize, 0);

  // Function 1: calc_add(x0, x1) -> return x0 + x1
  // 0x00: add x0, x0, x1 (0x8b010000)
  // 0x04: ret            (0xd65f03c0)
  const codeAddOffset = 0x1000;
  buffer.writeUInt32LE(0x8b010000, codeAddOffset + 0);
  buffer.writeUInt32LE(0xd65f03c0, codeAddOffset + 4);

  // Function 2: calc_cube(x0) -> return x0 * x0 * x0
  // 0x08: mul x1, x0, x0 (0x9b007c01)
  // 0x0c: mul x0, x1, x0 (0x9b007c20)
  // 0x10: ret            (0xd65f03c0)
  const codeCubeOffset = 0x1008;
  buffer.writeUInt32LE(0x9b007c01, codeCubeOffset + 0);
  buffer.writeUInt32LE(0x9b007c20, codeCubeOffset + 4);
  buffer.writeUInt32LE(0xd65f03c0, codeCubeOffset + 8);

  // Dynamic String Table (.dynstr)
  // Indices:
  // 0: ""
  // 1: "libcalc.so"
  // 12: "calc_add"
  // 21: "calc_cube"
  const strtabOffset = 0x1200;
  const strBytes = Buffer.from("\0libcalc.so\0calc_add\0calc_cube\0", "utf8");
  strBytes.copy(buffer, strtabOffset);
  const strtabSize = strBytes.length;

  // Dynamic Symbol Table (.dynsym)
  // Entry 0: STN_UNDEF (24 zeros)
  // Entry 1: calc_add (st_name: 12, st_info: 0x12 (GLOBAL FUNC), st_value: 0x1000, st_size: 8)
  // Entry 2: calc_cube (st_name: 21, st_info: 0x12 (GLOBAL FUNC), st_value: 0x1008, st_size: 12)
  const symtabOffset = 0x1300;
  const symentSize = 24;

  // Sym 1: calc_add
  buffer.writeUInt32LE(12, symtabOffset + 1 * symentSize + 0); // st_name
  buffer.writeUInt8(0x12, symtabOffset + 1 * symentSize + 4);  // st_info: STB_GLOBAL(1) | STT_FUNC(2)
  buffer.writeUInt8(0, symtabOffset + 1 * symentSize + 5);     // st_other
  buffer.writeUInt16LE(1, symtabOffset + 1 * symentSize + 6);  // st_shndx (in text)
  buffer.writeBigUInt64LE(BigInt(codeAddOffset), symtabOffset + 1 * symentSize + 8); // st_value
  buffer.writeBigUInt64LE(8n, symtabOffset + 1 * symentSize + 16); // st_size

  // Sym 2: calc_cube
  buffer.writeUInt32LE(21, symtabOffset + 2 * symentSize + 0); // st_name
  buffer.writeUInt8(0x12, symtabOffset + 2 * symentSize + 4);  // st_info
  buffer.writeUInt8(0, symtabOffset + 2 * symentSize + 5);     // st_other
  buffer.writeUInt16LE(1, symtabOffset + 2 * symentSize + 6);  // st_shndx
  buffer.writeBigUInt64LE(BigInt(codeCubeOffset), symtabOffset + 2 * symentSize + 8); // st_value
  buffer.writeBigUInt64LE(12n, symtabOffset + 2 * symentSize + 16); // st_size

  // Dynamic Array (.dynamic)
  const dynOffset = 0x1400;
  const dynEntries = [
    { tag: DynamicTag.DT_SONAME, val: 1n },
    { tag: DynamicTag.DT_STRTAB, val: BigInt(strtabOffset) },
    { tag: DynamicTag.DT_STRSZ, val: BigInt(strtabSize) },
    { tag: DynamicTag.DT_SYMTAB, val: BigInt(symtabOffset) },
    { tag: DynamicTag.DT_SYMENT, val: 24n },
    { tag: DynamicTag.DT_NULL, val: 0n }
  ];
  for (let i = 0; i < dynEntries.length; i++) {
    buffer.writeBigUInt64LE(BigInt(dynEntries[i].tag), dynOffset + i * 16 + 0);
    buffer.writeBigUInt64LE(dynEntries[i].val, dynOffset + i * 16 + 8);
  }
  const dynSize = dynEntries.length * 16;

  // ELF Header (64 bytes)
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46;
  buffer[4] = 2; // ELFCLASS64
  buffer[5] = 1; // ELFDATA2LSB
  buffer[6] = 1; // EV_CURRENT
  buffer.writeUInt16LE(3, 16); // e_type: 3 = ET_DYN (Shared Object)
  buffer.writeUInt16LE(0x00b7, 18); // e_machine: EM_AARCH64
  buffer.writeUInt32LE(1, 20); // e_version
  buffer.writeBigUInt64LE(0n, 24); // e_entry (none for library)
  buffer.writeBigUInt64LE(64n, 32); // e_phoff: 64
  buffer.writeUInt16LE(64, 52); // e_ehsize
  buffer.writeUInt16LE(56, 54); // e_phentsize
  buffer.writeUInt16LE(2, 56);  // e_phnum: 2 (PT_LOAD, PT_DYNAMIC)

  // Program Header 0: PT_LOAD (all file contents)
  let ph = 64;
  buffer.writeUInt32LE(1, ph + 0); // PT_LOAD
  buffer.writeUInt32LE(7, ph + 4); // PF_R | PF_W | PF_X
  buffer.writeBigUInt64LE(0n, ph + 8); // p_offset
  buffer.writeBigUInt64LE(0n, ph + 16); // p_vaddr
  buffer.writeBigUInt64LE(0n, ph + 24); // p_paddr
  buffer.writeBigUInt64LE(BigInt(fileSize), ph + 32); // p_filesz
  buffer.writeBigUInt64LE(BigInt(fileSize), ph + 40); // p_memsz
  buffer.writeBigUInt64LE(0x1000n, ph + 48); // p_align

  // Program Header 1: PT_DYNAMIC
  ph += 56;
  buffer.writeUInt32LE(2, ph + 0); // PT_DYNAMIC
  buffer.writeUInt32LE(6, ph + 4); // PF_R | PF_W
  buffer.writeBigUInt64LE(BigInt(dynOffset), ph + 8); // p_offset
  buffer.writeBigUInt64LE(BigInt(dynOffset), ph + 16); // p_vaddr
  buffer.writeBigUInt64LE(BigInt(dynOffset), ph + 24); // p_paddr
  buffer.writeBigUInt64LE(BigInt(dynSize), ph + 32); // p_filesz
  buffer.writeBigUInt64LE(BigInt(dynSize), ph + 40); // p_memsz
  buffer.writeBigUInt64LE(8n, ph + 48);

  const outPath = path.join(OUT_DIR, "libcalc.so");
  fs.writeFileSync(outPath, buffer);
  console.log(`Generated ELF Shared Library: ${outPath} (${fileSize} bytes)`);
  return buffer;
}

/**
 * Builds an ARM64 Dynamic Executable (.elf) with PT_INTERP, DT_NEEDED = "libcalc.so",
 * and GOT/PLT dynamic relocations calling shared library functions.
 */
export function buildDynamicExecutable() {
  const fileSize = 0x3000;
  const buffer = Buffer.alloc(fileSize, 0);
  const baseVaddr = 0x00400000n;

  // Interp string: "/lib/ld-linux-aarch64.so.1"
  const interpOffset = 0x500;
  const interpBytes = Buffer.from("/lib/ld-linux-aarch64.so.1\0", "utf8");
  interpBytes.copy(buffer, interpOffset);

  // Dynamic String Table (.dynstr)
  // Indices:
  // 0: ""
  // 1: "libcalc.so"
  // 12: "calc_add"
  // 21: "calc_cube"
  // 31: "abs"
  const strtabOffset = 0x1200;
  const strtabVaddr = baseVaddr + BigInt(strtabOffset);
  const strBytes = Buffer.from("\0libcalc.so\0calc_add\0calc_cube\0abs\0", "utf8");
  strBytes.copy(buffer, strtabOffset);
  const strtabSize = strBytes.length;

  // Dynamic Symbol Table (.dynsym) - imported symbols (st_shndx = 0)
  const symtabOffset = 0x1300;
  const symtabVaddr = baseVaddr + BigInt(symtabOffset);
  const symentSize = 24;

  // Sym 1: calc_add (imported)
  buffer.writeUInt32LE(12, symtabOffset + 1 * symentSize + 0);
  buffer.writeUInt8(0x12, symtabOffset + 1 * symentSize + 4);

  // Sym 2: calc_cube (imported)
  buffer.writeUInt32LE(21, symtabOffset + 2 * symentSize + 0);
  buffer.writeUInt8(0x12, symtabOffset + 2 * symentSize + 4);

  // Sym 3: abs (imported HLE)
  buffer.writeUInt32LE(31, symtabOffset + 3 * symentSize + 0);
  buffer.writeUInt8(0x12, symtabOffset + 3 * symentSize + 4);

  // Global Offset Table (.got) in writable memory
  // Offset 0x2000 -> GOT[0] for calc_add
  // Offset 0x2008 -> GOT[1] for calc_cube
  // Offset 0x2010 -> GOT[2] for abs
  const gotOffset = 0x2000;
  const gotVaddr = baseVaddr + BigInt(gotOffset);

  // Relocations (.rela.plt)
  const relaOffset = 0x1400;
  const relaVaddr = baseVaddr + BigInt(relaOffset);
  const relaEntries = [
    // Reloc 0: GOT[0] -> calc_add (sym 1, type 1026 R_AARCH64_JUMP_SLOT)
    { offset: gotVaddr + 0n, sym: 1n, type: BigInt(RelocationType.R_AARCH64_JUMP_SLOT), addend: 0n },
    // Reloc 1: GOT[1] -> calc_cube (sym 2, type 1026)
    { offset: gotVaddr + 8n, sym: 2n, type: BigInt(RelocationType.R_AARCH64_JUMP_SLOT), addend: 0n },
    // Reloc 2: GOT[2] -> abs (sym 3, type 1026)
    { offset: gotVaddr + 16n, sym: 3n, type: BigInt(RelocationType.R_AARCH64_JUMP_SLOT), addend: 0n }
  ];
  for (let i = 0; i < relaEntries.length; i++) {
    const entryAddr = relaOffset + i * 24;
    buffer.writeBigUInt64LE(relaEntries[i].offset, entryAddr + 0);
    const r_info = (relaEntries[i].sym << 32n) | (relaEntries[i].type & 0xffffffffn);
    buffer.writeBigUInt64LE(r_info, entryAddr + 8);
    buffer.writeBigUInt64LE(relaEntries[i].addend, entryAddr + 16);
  }
  const relaSize = relaEntries.length * 24;

  // Dynamic Table (.dynamic)
  const dynOffset = 0x1600;
  const dynVaddr = baseVaddr + BigInt(dynOffset);
  const dynEntries = [
    { tag: DynamicTag.DT_NEEDED, val: 1n }, // "libcalc.so"
    { tag: DynamicTag.DT_STRTAB, val: strtabVaddr },
    { tag: DynamicTag.DT_STRSZ, val: BigInt(strtabSize) },
    { tag: DynamicTag.DT_SYMTAB, val: symtabVaddr },
    { tag: DynamicTag.DT_SYMENT, val: 24n },
    { tag: DynamicTag.DT_JMPREL, val: relaVaddr },
    { tag: DynamicTag.DT_PLTRELSZ, val: BigInt(relaSize) },
    { tag: DynamicTag.DT_PLTGOT, val: gotVaddr },
    { tag: DynamicTag.DT_RELA, val: relaVaddr },
    { tag: DynamicTag.DT_RELASZ, val: BigInt(relaSize) },
    { tag: DynamicTag.DT_RELAENT, val: 24n },
    { tag: DynamicTag.DT_NULL, val: 0n }
  ];
  for (let i = 0; i < dynEntries.length; i++) {
    buffer.writeBigUInt64LE(BigInt(dynEntries[i].tag), dynOffset + i * 16 + 0);
    buffer.writeBigUInt64LE(dynEntries[i].val, dynOffset + i * 16 + 8);
  }
  const dynSize = dynEntries.length * 16;

  // Code Section (.text) at offset 0x1000 (vaddr: 0x00401000)
  const codeOffset = 0x1000;
  const entryAddr = baseVaddr + BigInt(codeOffset);

  // Machine Code:
  // 1. Call calc_add(15, 25):
  //    movz x0, #15          (0xd28001e0)
  //    movz x1, #25          (0xd2800321)
  //    adrp x16, #0x402000   (0x90000010) [page of GOT at 0x402000]
  //    ldr  x16, [x16, #0]   (0xf9400210) [GOT[0] = calc_add]
  //    blr  x16              (0xd63f0200) -> returns x0 = 40
  //
  // 2. Call calc_cube(x0) with x0 = 3:
  //    mov  x19, x0          (0xaa0003f3) [save 40 in x19]
  //    movz x0, #3           (0xd2800060)
  //    adrp x16, #0x402000   (0x90000010)
  //    ldr  x16, [x16, #8]   (0xf9400610) [GOT[1] = calc_cube]
  //    blr  x16              (0xd63f0200) -> returns x0 = 27
  //
  // 3. Call abs(-15):
  //    mov  x20, x0          (0xaa0003f4) [save 27 in x20]
  //    movn x0, #14          (0x928001c0) [x0 = -15]
  //    adrp x16, #0x402000   (0x90000010)
  //    ldr  x16, [x16, #16]  (0xf9400a10) [GOT[2] = abs]
  //    blr  x16              (0xd63f0200) -> returns x0 = 15
  //
  // 4. Compute final exit code: x0 = x19 + x20 + x0 = 40 + 27 + 15 = 82
  //    add  x0, x19, x20     (0x8b140260) [40 + 27 = 67]
  //    add  x0, x0, #15      (0x91003c00) [67 + 15 = 82]
  //    movz x8, #93          (0xd2800ba8) [sys_exit]
  //    svc  #0               (0xd4000001)

  const instructions = [
    0xd28001e0, // movz x0, #15
    0xd2800321, // movz x1, #25
    0xb0000010, // adrp x16, 0x402000 (GOT page +1)
    0xf9400210, // ldr  x16, [x16, #0] (GOT[0]: calc_add)
    0xd63f0200, // blr  x16
    0xaa0003f3, // mov  x19, x0 (save 40)
    0xd2800060, // movz x0, #3
    0xb0000010, // adrp x16, 0x402000
    0xf9400610, // ldr  x16, [x16, #8] (GOT[1]: calc_cube)
    0xd63f0200, // blr  x16
    0xaa0003f4, // mov  x20, x0 (save 27)
    0x928001c0, // movn x0, #14 (-15)
    0xb0000010, // adrp x16, 0x402000
    0xf9400a10, // ldr  x16, [x16, #16] (GOT[2]: abs)
    0xd63f0200, // blr  x16
    0xaa0003f5, // mov  x21, x0 (save 15 in x21)
    0x8b140260, // add  x0, x19, x20 (40 + 27 = 67)
    0x8b150000, // add  x0, x0, x21 (67 + 15 = 82)
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc  #0
  ];

  for (let i = 0; i < instructions.length; i++) {
    buffer.writeUInt32LE(instructions[i] >>> 0, codeOffset + i * 4);
  }

  // ELF Header (64 bytes)
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46;
  buffer[4] = 2; // ELFCLASS64
  buffer[5] = 1; // ELFDATA2LSB
  buffer[6] = 1; // EV_CURRENT
  buffer.writeUInt16LE(2, 16); // e_type: 2 = ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18); // e_machine: EM_AARCH64
  buffer.writeUInt32LE(1, 20); // e_version
  buffer.writeBigUInt64LE(entryAddr, 24); // e_entry
  buffer.writeBigUInt64LE(64n, 32); // e_phoff: 64
  buffer.writeUInt16LE(64, 52); // e_ehsize
  buffer.writeUInt16LE(56, 54); // e_phentsize
  buffer.writeUInt16LE(4, 56);  // e_phnum: 4 (PT_PHDR, PT_INTERP, PT_LOAD, PT_DYNAMIC)

  // PH 0: PT_PHDR
  let ph = 64;
  buffer.writeUInt32LE(6, ph + 0); // PT_PHDR
  buffer.writeUInt32LE(4, ph + 4); // PF_R
  buffer.writeBigUInt64LE(64n, ph + 8);
  buffer.writeBigUInt64LE(baseVaddr + 64n, ph + 16);
  buffer.writeBigUInt64LE(baseVaddr + 64n, ph + 24);
  buffer.writeBigUInt64LE(BigInt(4 * 56), ph + 32);
  buffer.writeBigUInt64LE(BigInt(4 * 56), ph + 40);
  buffer.writeBigUInt64LE(8n, ph + 48);

  // PH 1: PT_INTERP
  ph += 56;
  buffer.writeUInt32LE(3, ph + 0); // PT_INTERP
  buffer.writeUInt32LE(4, ph + 4); // PF_R
  buffer.writeBigUInt64LE(BigInt(interpOffset), ph + 8);
  buffer.writeBigUInt64LE(baseVaddr + BigInt(interpOffset), ph + 16);
  buffer.writeBigUInt64LE(baseVaddr + BigInt(interpOffset), ph + 24);
  buffer.writeBigUInt64LE(BigInt(interpBytes.length), ph + 32);
  buffer.writeBigUInt64LE(BigInt(interpBytes.length), ph + 40);
  buffer.writeBigUInt64LE(1n, ph + 48);

  // PH 2: PT_LOAD
  ph += 56;
  buffer.writeUInt32LE(1, ph + 0); // PT_LOAD
  buffer.writeUInt32LE(7, ph + 4); // PF_R | PF_W | PF_X
  buffer.writeBigUInt64LE(0n, ph + 8);
  buffer.writeBigUInt64LE(baseVaddr, ph + 16);
  buffer.writeBigUInt64LE(baseVaddr, ph + 24);
  buffer.writeBigUInt64LE(BigInt(fileSize), ph + 32);
  buffer.writeBigUInt64LE(BigInt(fileSize), ph + 40);
  buffer.writeBigUInt64LE(0x1000n, ph + 48);

  // PH 3: PT_DYNAMIC
  ph += 56;
  buffer.writeUInt32LE(2, ph + 0); // PT_DYNAMIC
  buffer.writeUInt32LE(6, ph + 4); // PF_R | PF_W
  buffer.writeBigUInt64LE(BigInt(dynOffset), ph + 8);
  buffer.writeBigUInt64LE(dynVaddr, ph + 16);
  buffer.writeBigUInt64LE(dynVaddr, ph + 24);
  buffer.writeBigUInt64LE(BigInt(dynSize), ph + 32);
  buffer.writeBigUInt64LE(BigInt(dynSize), ph + 40);
  buffer.writeBigUInt64LE(8n, ph + 48);

  const outPath = path.join(OUT_DIR, "dynamic_app.elf");
  fs.writeFileSync(outPath, buffer);
  console.log(`Generated Dynamic ELF Executable: ${outPath} (${fileSize} bytes, Entry Point: 0x${entryAddr.toString(16)})`);
  return buffer;
}

buildSharedLibrary();
buildDynamicExecutable();
