// elf_loader.js - Minimal ELF64 (AArch64) Binary Loader
import fs from "fs";

export class ElfLoader {
  // Parse an ELF64 binary from an in-memory buffer or Uint8Array
  static loadFromBuffer(buffer, memory, name = "binary.elf") {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // 1. Validate ELF Magic Bytes (0x7F 'E' 'L' 'F')
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
      throw new Error(`Invalid ELF magic bytes: not an ELF binary!`);
    }

    // 2. Validate Architecture (64-bit & Little Endian)
    const elfClass = bytes[4]; // 1 = 32-bit, 2 = 64-bit
    const elfData = bytes[5];  // 1 = Little Endian, 2 = Big Endian
    if (elfClass !== 2) throw new Error(`Unsupported ELF Class: only 64-bit (ELFCLASS64) is supported.`);
    if (elfData !== 1) throw new Error(`Unsupported Endianness: only Little-Endian is supported.`);

    // 3. Validate Machine Architecture
    const e_type = view.getUint16(16, true);
    const e_machine = view.getUint16(18, true);
    if (e_machine !== 0x00b7) { // 0x00B7 = 183 = EM_AARCH64
      throw new Error(`Unsupported Target Machine: 0x${e_machine.toString(16)}. Expected AArch64 (0xB7).`);
    }

    // 4. Extract Entry Point and Program Headers Offset
    const e_entry = view.getBigUint64(24, true);
    const e_phoff = Number(view.getBigUint64(32, true));
    const e_phentsize = view.getUint16(54, true);
    const e_phnum = view.getUint16(56, true);

    console.log(`[ELF Loader] Loading "${name}"`);
    console.log(`  Target Architecture : AArch64 (ARM 64-bit)`);
    console.log(`  Entry Point Address : 0x${e_entry.toString(16).padStart(8, "0")}`);
    console.log(`  Program Headers     : ${e_phnum} entries at offset 0x${e_phoff.toString(16)}`);

    // 5. Parse Program Headers & Load PT_LOAD Segments into Memory
    memory.segments = [];
    let loadedSegments = 0;
    let phdrVaddr = 0x00400000n + BigInt(e_phoff);
    let tlsHeader = null;

    for (let i = 0; i < e_phnum; i++) {
      const phOffset = e_phoff + i * e_phentsize;
      const p_type = view.getUint32(phOffset + 0, true);

      // p_type == 6 is PT_PHDR (Program header table itself)
      if (p_type === 6) {
        phdrVaddr = view.getBigUint64(phOffset + 16, true);
      }

      // p_type == 7 is PT_TLS (Thread-Local Storage template)
      if (p_type === 7) {
        tlsHeader = {
          vaddr: view.getBigUint64(phOffset + 16, true),
          filesz: Number(view.getBigUint64(phOffset + 32, true)),
          memsz: Number(view.getBigUint64(phOffset + 40, true)),
          align: Number(view.getBigUint64(phOffset + 48, true))
        };
      }

      // p_type == 1 is PT_LOAD (Loadable segment)
      if (p_type === 1) {
        const p_flags = view.getUint32(phOffset + 4, true);
        const p_offset = Number(view.getBigUint64(phOffset + 8, true));
        const p_vaddr = view.getBigUint64(phOffset + 16, true);
        const p_filesz = Number(view.getBigUint64(phOffset + 32, true));
        const p_memsz = Number(view.getBigUint64(phOffset + 40, true));

        const segmentBytes = bytes.subarray(p_offset, p_offset + p_filesz);
        memory.loadSegment(p_vaddr, segmentBytes);

        // Zero-initialize .bss section if p_memsz > p_filesz
        if (p_memsz > p_filesz) {
          const bssStart = Number(p_vaddr) + p_filesz;
          const bssLen = p_memsz - p_filesz;
          for (let b = 0; b < bssLen; b++) {
            memory.write8(bssStart + b, 0);
          }
        }

        if (p_offset <= e_phoff && e_phoff < p_offset + p_filesz) {
          phdrVaddr = p_vaddr + BigInt(e_phoff - p_offset);
        }

        const r = (p_flags & 4) ? "R" : "-";
        const w = (p_flags & 2) ? "W" : "-";
        const x = (p_flags & 1) ? "X" : "-";

        memory.segments.push({
          vaddr: Number(p_vaddr),
          filesz: p_filesz,
          memsz: p_memsz,
          flags: p_flags,
          permissions: `${r}${w}${x}`,
          data: segmentBytes
        });

        console.log(`  Loaded Segment [${i}]: vaddr=0x${p_vaddr.toString(16)} size=${p_filesz}B${p_memsz > p_filesz ? ` (memsz=${p_memsz}B)` : ""} flags=[${r}${w}${x}]`);
        loadedSegments++;
      }
    }

    if (loadedSegments === 0) {
      throw new Error(`No loadable (PT_LOAD) segments found in ELF binary.`);
    }

    memory.elfHeader = {
      entry: e_entry,
      phoff: e_phoff,
      phentsize: e_phentsize,
      phnum: e_phnum,
      phdrVaddr,
      tlsHeader
    };
    memory.lastWritten.clear();

    return e_entry;
  }

  // Load from file path (Node.js) or pass through if already a buffer
  static load(filePathOrBuffer, memory) {
    if (typeof filePathOrBuffer !== "string") {
      return ElfLoader.loadFromBuffer(filePathOrBuffer, memory);
    }
    let filePath = filePathOrBuffer;
    if (!fs.existsSync(filePath) && fs.existsSync(`bin/${filePath}`)) {
      filePath = `bin/${filePath}`;
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`ELF file not found: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    return ElfLoader.loadFromBuffer(buffer, memory, filePath);
  }
}
