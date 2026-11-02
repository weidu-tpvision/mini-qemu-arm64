// elf_loader.js - Minimal ELF64 (AArch64) Binary Loader
import fs from "fs";

export class ElfLoader {
  static load(filePath, memory) {
    if (!fs.existsSync(filePath) && fs.existsSync(`bin/${filePath}`)) {
      filePath = `bin/${filePath}`;
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`ELF file not found: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);

    // 1. Validate ELF Magic Bytes (0x7F 'E' 'L' 'F')
    if (buffer[0] !== 0x7f || buffer[1] !== 0x45 || buffer[2] !== 0x4c || buffer[3] !== 0x46) {
      throw new Error(`Invalid ELF magic bytes: not an ELF binary!`);
    }

    // 2. Validate Architecture (64-bit & Little Endian)
    const elfClass = buffer[4]; // 1 = 32-bit, 2 = 64-bit
    const elfData = buffer[5];  // 1 = Little Endian, 2 = Big Endian
    if (elfClass !== 2) throw new Error(`Unsupported ELF Class: only 64-bit (ELFCLASS64) is supported.`);
    if (elfData !== 1) throw new Error(`Unsupported Endianness: only Little-Endian is supported.`);

    // 3. Validate Machine Architecture
    const e_type = buffer.readUInt16LE(16);
    const e_machine = buffer.readUInt16LE(18);
    if (e_machine !== 0x00b7) { // 0x00B7 = 183 = EM_AARCH64
      throw new Error(`Unsupported Target Machine: 0x${e_machine.toString(16)}. Expected AArch64 (0xB7).`);
    }

    // 4. Extract Entry Point and Program Headers Offset
    const e_entry = buffer.readBigUInt64LE(24);
    const e_phoff = Number(buffer.readBigUInt64LE(32));
    const e_phentsize = buffer.readUInt16LE(54);
    const e_phnum = buffer.readUInt16LE(56);

    console.log(`[ELF Loader] Loading "${filePath}"`);
    console.log(`  Target Architecture : AArch64 (ARM 64-bit)`);
    console.log(`  Entry Point Address : 0x${e_entry.toString(16).padStart(8, "0")}`);
    console.log(`  Program Headers     : ${e_phnum} entries at offset 0x${e_phoff.toString(16)}`);

    // 5. Parse Program Headers & Load PT_LOAD Segments into Memory
    memory.segments = [];
    let loadedSegments = 0;
    for (let i = 0; i < e_phnum; i++) {
      const phOffset = e_phoff + i * e_phentsize;
      const p_type = buffer.readUInt32LE(phOffset + 0);

      // p_type == 1 is PT_LOAD (Loadable segment)
      if (p_type === 1) {
        const p_flags = buffer.readUInt32LE(phOffset + 4);
        const p_offset = Number(buffer.readBigUInt64LE(phOffset + 8));
        const p_vaddr = buffer.readBigUInt64LE(phOffset + 16);
        const p_filesz = Number(buffer.readBigUInt64LE(phOffset + 32));
        const p_memsz = Number(buffer.readBigUInt64LE(phOffset + 40));

        const segmentBytes = buffer.subarray(p_offset, p_offset + p_filesz);
        memory.loadSegment(p_vaddr, segmentBytes);

        const r = (p_flags & 4) ? "R" : "-";
        const w = (p_flags & 2) ? "W" : "-";
        const x = (p_flags & 1) ? "X" : "-";

        memory.segments.push({
          vaddr: Number(p_vaddr),
          filesz: p_filesz,
          memsz: p_memsz,
          flags: p_flags,
          permissions: `${r}${w}${x}`,
        });

        console.log(`  Loaded Segment [${i}]: vaddr=0x${p_vaddr.toString(16)} size=${p_filesz}B flags=[${r}${w}${x}]`);
        loadedSegments++;
      }
    }

    if (loadedSegments === 0) {
      throw new Error(`No loadable (PT_LOAD) segments found in ELF binary.`);
    }

    return e_entry;
  }
}
