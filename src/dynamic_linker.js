// src/dynamic_linker.js - ELF64 (AArch64) Dynamic Linker & Shared Library Loader
// Handles PT_DYNAMIC parsing, DT_NEEDED shared objects, symbol resolution, and relocations.

import fs from "fs";

// Standard ELF Dynamic Array Tags (d_tag)
export const DynamicTag = {
  DT_NULL: 0,
  DT_NEEDED: 1,
  DT_PLTRELSZ: 2,
  DT_PLTGOT: 3,
  DT_HASH: 4,
  DT_STRTAB: 5,
  DT_SYMTAB: 6,
  DT_RELA: 7,
  DT_RELASZ: 8,
  DT_RELAENT: 9,
  DT_STRSZ: 10,
  DT_SYMENT: 11,
  DT_INIT: 12,
  DT_FINI: 13,
  DT_SONAME: 14,
  DT_RPATH: 15,
  DT_SYMBOLIC: 16,
  DT_REL: 17,
  DT_RELSZ: 18,
  DT_RELENT: 19,
  DT_PLTREL: 20,
  DT_DEBUG: 21,
  DT_TEXTREL: 22,
  DT_JMPREL: 23,
  DT_BIND_NOW: 24,
  DT_INIT_ARRAY: 25,
  DT_FINI_ARRAY: 26,
  DT_INIT_ARRAYSZ: 27,
  DT_FINI_ARRAYSZ: 28,
  DT_RUNPATH: 29,
  DT_FLAGS: 30,
  DT_GNU_HASH: 0x6ffffef5,
  DT_RELACOUNT: 0x6ffffff9,
  DT_FLAGS_1: 0x6ffffffb
};

// Standard AArch64 Relocation Types (r_info low 32 bits)
export const RelocationType = {
  R_AARCH64_NONE: 0,
  R_AARCH64_ABS64: 257,
  R_AARCH64_COPY: 1024,
  R_AARCH64_GLOB_DAT: 1025,
  R_AARCH64_JUMP_SLOT: 1026,
  R_AARCH64_RELATIVE: 1027,
  R_AARCH64_TLS_TPREL64: 1030
};

export class DynamicLinker {
  constructor(emulator) {
    this.emulator = emulator;
    this.memory = emulator.memory;
    this.sharedLibraries = new Map(); // soname -> { baseAddr, symbols, info }
    this.globalSymbols = new Map();   // symbolName -> virtualAddress
    this.nextLibraryBase = 0x20000000n; // Default base for Position-Independent .so files
    this.hleHandlers = new Map();     // symbolName -> JS callback function

    this.registerDefaultHleHandlers();
  }

  /**
   * Registers default High-Level Emulation (HLE) stubs for standard C library symbols.
   */
  registerDefaultHleHandlers() {
    this.hleHandlers.set("puts", (cpu, memory) => {
      const strAddr = Number(cpu.x[0]);
      let s = "";
      let i = 0;
      while (i < 4096) {
        const b = memory.read8(strAddr + i++);
        if (b === 0) break;
        s += String.fromCharCode(b);
      }
      if (this.emulator.onWrite) {
        this.emulator.onWrite(s + "\n", 1);
      } else if (typeof process !== "undefined" && process.stdout && !this.emulator.suppressStdout) {
        process.stdout.write(s + "\n");
      }
      cpu.x[0] = BigInt(s.length + 1);
      return true;
    });

    this.hleHandlers.set("strlen", (cpu, memory) => {
      const strAddr = Number(cpu.x[0]);
      let len = 0;
      while (len < 1000000) {
        if (memory.read8(strAddr + len) === 0) break;
        len++;
      }
      cpu.x[0] = BigInt(len);
      return true;
    });

    this.hleHandlers.set("abs", (cpu) => {
      const val = BigInt.asIntN(32, cpu.x[0]);
      const res = val < 0n ? -val : val;
      cpu.x[0] = BigInt.asUintN(64, res);
      return true;
    });
  }

  /**
   * Registers a custom HLE callback for a named symbol.
   */
  registerHle(name, handler) {
    this.hleHandlers.set(name, handler);
  }

  /**
   * Reads a null-terminated string from memory at virtual address `vaddr`.
   */
  readString(vaddr) {
    let s = "";
    let cursor = Number(vaddr);
    const maxLen = 1024;
    for (let i = 0; i < maxLen; i++) {
      let b;
      try {
        b = this.memory.read8(cursor + i);
      } catch {
        break;
      }
      if (b === 0) break;
      s += String.fromCharCode(b);
    }
    return s;
  }

  /**
   * Parses the PT_DYNAMIC section table from memory.
   */
  parseDynamicSection(dynVaddr, dynSize, loadBias = 0n) {
    const info = {
      neededOffsets: [],
      neededNames: [],
      strtab: 0n,
      strsz: 0,
      symtab: 0n,
      syment: 24,
      rela: 0n,
      relasz: 0,
      relaent: 24,
      jmprel: 0n,
      pltrelsz: 0,
      init: 0n,
      fini: 0n,
      initArray: 0n,
      initArraySz: 0,
      soname: null,
      rpath: null
    };

    const count = Math.floor(dynSize / 16); // Each Elf64_Dyn is 16 bytes: uint64 d_tag, uint64 d_val
    for (let i = 0; i < count; i++) {
      const entryAddr = Number(dynVaddr) + i * 16;
      const tag = Number(this.memory.read64(entryAddr));
      const val = this.memory.read64(entryAddr + 8);

      if (tag === DynamicTag.DT_NULL) break;

      switch (tag) {
        case DynamicTag.DT_NEEDED:
          info.neededOffsets.push(Number(val));
          break;
        case DynamicTag.DT_STRTAB:
          info.strtab = val + loadBias;
          break;
        case DynamicTag.DT_STRSZ:
          info.strsz = Number(val);
          break;
        case DynamicTag.DT_SYMTAB:
          info.symtab = val + loadBias;
          break;
        case DynamicTag.DT_SYMENT:
          info.syment = Number(val);
          break;
        case DynamicTag.DT_RELA:
          info.rela = val + loadBias;
          break;
        case DynamicTag.DT_RELASZ:
          info.relasz = Number(val);
          break;
        case DynamicTag.DT_RELAENT:
          info.relaent = Number(val);
          break;
        case DynamicTag.DT_JMPREL:
          info.jmprel = val + loadBias;
          break;
        case DynamicTag.DT_PLTRELSZ:
          info.pltrelsz = Number(val);
          break;
        case DynamicTag.DT_INIT:
          info.init = val + loadBias;
          break;
        case DynamicTag.DT_FINI:
          info.fini = val + loadBias;
          break;
        case DynamicTag.DT_INIT_ARRAY:
          info.initArray = val + loadBias;
          break;
        case DynamicTag.DT_INIT_ARRAYSZ:
          info.initArraySz = Number(val);
          break;
        case DynamicTag.DT_SONAME:
          info.sonameOffset = Number(val);
          break;
        case DynamicTag.DT_RPATH:
        case DynamicTag.DT_RUNPATH:
          info.rpathOffset = Number(val);
          break;
      }
    }

    // Resolve string names once STRTAB is identified
    if (info.strtab !== 0n) {
      for (const off of info.neededOffsets) {
        const name = this.readString(info.strtab + BigInt(off));
        if (name) info.neededNames.push(name);
      }
      if (info.sonameOffset !== undefined) {
        info.soname = this.readString(info.strtab + BigInt(info.sonameOffset));
      }
      if (info.rpathOffset !== undefined) {
        info.rpath = this.readString(info.strtab + BigInt(info.rpathOffset));
      }
    }

    return info;
  }

  /**
   * Loads an ELF shared library (.so) into virtual memory at an aligned base address.
   */
  loadSharedObject(bufferOrPath, soname = null) {
    let bytes;
    let name = soname || "shared_lib.so";
    if (typeof bufferOrPath === "string") {
      name = soname || bufferOrPath.split(/[/\\]/).pop();
      let path = bufferOrPath;
      if (!fs.existsSync(path) && fs.existsSync(`bin/${path}`)) path = `bin/${path}`;
      if (!fs.existsSync(path)) {
        throw new Error(`Shared object not found: ${bufferOrPath}`);
      }
      bytes = fs.readFileSync(path);
    } else {
      bytes = bufferOrPath instanceof Uint8Array ? bufferOrPath : new Uint8Array(bufferOrPath);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Validate ELF
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
      throw new Error(`Invalid ELF magic in shared object: ${name}`);
    }

    const e_type = view.getUint16(16, true); // 3 = ET_DYN
    const e_phoff = Number(view.getBigUint64(32, true));
    const e_phentsize = view.getUint16(54, true);
    const e_phnum = view.getUint16(56, true);

    const loadBias = (e_type === 3) ? this.nextLibraryBase : 0n;

    let dynamicHeader = null;
    let minVaddr = 0xffffffffffffffffn;
    let maxVaddr = 0n;

    // First pass: find virtual bounds
    for (let i = 0; i < e_phnum; i++) {
      const phOffset = e_phoff + i * e_phentsize;
      const p_type = view.getUint32(phOffset, true);
      if (p_type === 1) { // PT_LOAD
        const p_vaddr = view.getBigUint64(phOffset + 16, true);
        const p_memsz = view.getBigUint64(phOffset + 40, true);
        if (p_vaddr < minVaddr) minVaddr = p_vaddr;
        if (p_vaddr + p_memsz > maxVaddr) maxVaddr = p_vaddr + p_memsz;
      }
    }

    // Load segments with loadBias
    for (let i = 0; i < e_phnum; i++) {
      const phOffset = e_phoff + i * e_phentsize;
      const p_type = view.getUint32(phOffset, true);
      const p_offset = Number(view.getBigUint64(phOffset + 8, true));
      const p_vaddr = view.getBigUint64(phOffset + 16, true);
      const p_filesz = Number(view.getBigUint64(phOffset + 32, true));
      const p_memsz = Number(view.getBigUint64(phOffset + 40, true));

      if (p_type === 1) { // PT_LOAD
        const targetVaddr = p_vaddr + loadBias;
        const segmentBytes = bytes.subarray(p_offset, p_offset + p_filesz);
        this.memory.loadSegment(targetVaddr, segmentBytes);

        if (p_memsz > p_filesz) {
          const bssStart = Number(targetVaddr) + p_filesz;
          const bssLen = p_memsz - p_filesz;
          for (let b = 0; b < bssLen; b++) {
            this.memory.write8(bssStart + b, 0);
          }
        }
      } else if (p_type === 2) { // PT_DYNAMIC
        dynamicHeader = {
          vaddr: p_vaddr + loadBias,
          filesz: p_filesz,
          memsz: p_memsz
        };
      }
    }

    // Advance nextLibraryBase page-aligned
    if (e_type === 3) {
      const libSpan = (maxVaddr - minVaddr + 4095n) & ~4095n;
      this.nextLibraryBase += (libSpan > 0n ? libSpan : 0x100000n) + 0x10000n;
    }

    // Parse dynamic info
    let dynamicInfo = null;
    if (dynamicHeader) {
      dynamicInfo = this.parseDynamicSection(dynamicHeader.vaddr, dynamicHeader.filesz, loadBias);
    }

    const libRecord = {
      name,
      soname: dynamicInfo?.soname || name,
      loadBias,
      dynamicInfo,
      exportedSymbols: new Map()
    };

    // Extract exported symbols from .dynsym
    if (dynamicInfo?.symtab && dynamicInfo?.strtab) {
      this.extractSymbols(libRecord);
    }

    this.sharedLibraries.set(libRecord.soname, libRecord);
    console.log(`[Dynamic Linker] Loaded shared library "${libRecord.soname}" at base 0x${loadBias.toString(16)} (${libRecord.exportedSymbols.size} symbols)`);

    return libRecord;
  }

  /**
   * Extracts exported dynamic symbols from a library's .dynsym table.
   */
  extractSymbols(libRecord) {
    const { symtab, strtab, syment } = libRecord.dynamicInfo;
    const loadBias = libRecord.loadBias;

    // Limit to reasonable scan bound
    const maxSymbols = 10000;
    let idx = 0;

    while (idx < maxSymbols) {
      const entryAddr = Number(symtab) + idx * syment;
      let st_name;
      try {
        st_name = this.memory.read32(entryAddr);
      } catch {
        break; // Reached end of mapped symbol table
      }

      if (idx > 0 && st_name === 0) {
        // Can be an internal or padding entry, continue checking up to a few blanks
        let hasMore = false;
        for (let lookahead = 1; lookahead <= 4; lookahead++) {
          try {
            if (this.memory.read32(entryAddr + lookahead * syment) !== 0) {
              hasMore = true;
              break;
            }
          } catch { break; }
        }
        if (!hasMore) break;
      }

      const st_info = this.memory.read8(entryAddr + 4);
      const st_shndx = this.memory.read16(entryAddr + 6);
      const st_value = this.memory.read64(entryAddr + 8);
      const st_size = this.memory.read64(entryAddr + 16);

      const bind = st_info >> 4; // 1 = STB_GLOBAL, 2 = STB_WEAK
      const type = st_info & 0xf; // 1 = STT_OBJECT, 2 = STT_FUNC

      if (st_shndx !== 0 && st_name !== 0) { // Not SHN_UNDEF
        const symName = this.readString(strtab + BigInt(st_name));
        if (symName) {
          const symAddr = st_value + loadBias;
          libRecord.exportedSymbols.set(symName, {
            name: symName,
            addr: symAddr,
            size: Number(st_size),
            bind,
            type
          });
          this.globalSymbols.set(symName, symAddr);
        }
      }

      idx++;
    }
  }

  /**
   * Applies relocations for an ELF binary or shared object.
   */
  applyRelocations(relaVaddr, relaSize, relaEnt, loadBias = 0n, symtab = 0n, strtab = 0n, syment = 24) {
    if (relaVaddr === 0n || relaSize === 0) return 0;

    const count = Math.floor(relaSize / relaEnt);
    let appliedCount = 0;

    for (let i = 0; i < count; i++) {
      const entryAddr = Number(relaVaddr) + i * relaEnt;
      const r_offset = this.memory.read64(entryAddr);
      const r_info = this.memory.read64(entryAddr + 8);
      const r_addend = BigInt.asIntN(64, this.memory.read64(entryAddr + 16));

      const r_type = Number(r_info & 0xffffffffn);
      const r_sym = Number(r_info >> 32n);

      const targetAddr = Number(r_offset + loadBias);

      switch (r_type) {
        case RelocationType.R_AARCH64_NONE:
          break;

        case RelocationType.R_AARCH64_RELATIVE: {
          // Base relocation: *targetAddr = loadBias + r_addend
          const val = loadBias + BigInt(r_addend);
          this.memory.write64(targetAddr, val);
          appliedCount++;
          break;
        }

        case RelocationType.R_AARCH64_GLOB_DAT:
        case RelocationType.R_AARCH64_JUMP_SLOT:
        case RelocationType.R_AARCH64_ABS64: {
          // Symbol lookup
          let symAddr = 0n;
          let symName = "";

          if (r_sym > 0 && symtab !== 0n && strtab !== 0n) {
            const symEntry = Number(symtab) + r_sym * syment;
            const st_name = this.memory.read32(symEntry);
            symName = this.readString(strtab + BigInt(st_name));
          }

          if (symName) {
            if (this.globalSymbols.has(symName)) {
              symAddr = this.globalSymbols.get(symName);
            } else if (this.hleHandlers.has(symName)) {
              // Create dynamic HLE trampoline stub
              symAddr = this.createHleStub(symName);
              this.globalSymbols.set(symName, symAddr);
            } else {
              console.warn(`[Dynamic Linker] Unresolved dynamic symbol: "${symName}" (reloc type ${r_type})`);
            }
          }

          const finalVal = symAddr + BigInt(r_addend);
          this.memory.write64(targetAddr, finalVal);
          appliedCount++;
          break;
        }

        default:
          console.warn(`[Dynamic Linker] Unsupported relocation type ${r_type} at offset 0x${targetAddr.toString(16)}`);
          break;
      }
    }

    return appliedCount;
  }

  /**
   * Generates a small AArch64 HLE trampoline stub in virtual memory:
   *   0x00: svc #0xdd  (custom HLE syscall trap)
   *   0x04: ret
   */
  createHleStub(symbolName) {
    if (!this.hleStubBase) {
      this.hleStubBase = 0x003f0000; // Place right below default 0x00400000 code
      this.hleStubMap = new Map();
      this.nextHleId = 1;
    }

    const stubAddr = this.hleStubBase;
    const hleId = this.nextHleId++;
    this.hleStubBase += 16; // 16-byte aligned stubs

    // Encode:
    // movz x8, #hleId
    // svc #0xdd
    // ret
    const movzX8 = 0xd2800008 | ((hleId & 0xffff) << 5);
    const svcDD = 0xd4001ba1; // svc #0xdd
    const ret = 0xd65f03c0;   // ret

    this.memory.write32(stubAddr + 0, movzX8);
    this.memory.write32(stubAddr + 4, svcDD);
    this.memory.write32(stubAddr + 8, ret);
    this.memory.write32(stubAddr + 12, 0xd503201f); // nop

    this.hleStubMap.set(hleId, { name: symbolName, addr: BigInt(stubAddr) });
    return BigInt(stubAddr);
  }

  /**
   * Handles an HLE syscall trap (svc #0xdd) triggered from a dynamic trampoline.
   */
  handleHleCall(imm16) {
    if (imm16 !== 0xdd || !this.hleStubMap) return false;
    const hleId = Number(this.emulator.cpu.x[8] & 0xffffn);
    const stubInfo = this.hleStubMap.get(hleId);
    if (!stubInfo) return false;

    const handler = this.hleHandlers.get(stubInfo.name);
    if (!handler) return false;

    return handler(this.emulator.cpu, this.memory);
  }

  /**
   * Main entry point: Performs full dynamic linking for the loaded program in emulator.
   */
  link(mainDynamicHeader, loadBias = 0n) {
    if (!mainDynamicHeader) return false;

    console.log(`[Dynamic Linker] Initializing dynamic linking pipeline...`);

    // 1. Parse main binary dynamic section
    const mainDyn = this.parseDynamicSection(mainDynamicHeader.vaddr, mainDynamicHeader.filesz, loadBias);

    // 2. Discover and load DT_NEEDED shared libraries
    for (const neededLib of mainDyn.neededNames) {
      if (!this.sharedLibraries.has(neededLib)) {
        try {
          this.loadSharedObject(neededLib);
        } catch (err) {
          console.warn(`[Dynamic Linker] Could not load DT_NEEDED library "${neededLib}": ${err.message}`);
        }
      }
    }

    // 3. Relocate all loaded shared libraries
    for (const [name, lib] of this.sharedLibraries) {
      if (lib.dynamicInfo) {
        const dyn = lib.dynamicInfo;
        if (dyn.rela && dyn.relasz) {
          const applied = this.applyRelocations(dyn.rela, dyn.relasz, dyn.relaent, lib.loadBias, dyn.symtab, dyn.strtab, dyn.syment);
          console.log(`[Dynamic Linker] Applied ${applied} .rela.dyn relocations in "${name}"`);
        }
        if (dyn.jmprel && dyn.pltrelsz) {
          const applied = this.applyRelocations(dyn.jmprel, dyn.pltrelsz, dyn.relaent, lib.loadBias, dyn.symtab, dyn.strtab, dyn.syment);
          console.log(`[Dynamic Linker] Applied ${applied} .rela.plt relocations in "${name}"`);
        }
      }
    }

    // 4. Relocate main executable
    if (mainDyn.rela && mainDyn.relasz) {
      const applied = this.applyRelocations(mainDyn.rela, mainDyn.relasz, mainDyn.relaent, loadBias, mainDyn.symtab, mainDyn.strtab, mainDyn.syment);
      console.log(`[Dynamic Linker] Applied ${applied} .rela.dyn relocations in main executable`);
    }
    if (mainDyn.jmprel && mainDyn.pltrelsz) {
      const applied = this.applyRelocations(mainDyn.jmprel, mainDyn.pltrelsz, mainDyn.relaent, loadBias, mainDyn.symtab, mainDyn.strtab, mainDyn.syment);
      console.log(`[Dynamic Linker] Applied ${applied} .rela.plt relocations in main executable`);
    }

    // 5. Execute library constructors (DT_INIT and DT_INIT_ARRAY)
    this.executeConstructors(mainDyn, loadBias);

    console.log(`[Dynamic Linker] Dynamic linking completed successfully.`);
    return true;
  }

  /**
   * Executes initialization constructors for shared libraries and main executable.
   */
  executeConstructors(mainDyn, loadBias = 0n) {
    const initList = [];

    // Collect library constructors first
    for (const lib of this.sharedLibraries.values()) {
      if (lib.dynamicInfo?.init && lib.dynamicInfo.init !== 0n) {
        initList.push(lib.dynamicInfo.init);
      }
      if (lib.dynamicInfo?.initArray && lib.dynamicInfo.initArraySz) {
        const entries = Math.floor(lib.dynamicInfo.initArraySz / 8);
        for (let i = 0; i < entries; i++) {
          const fnPtr = this.memory.read64(Number(lib.dynamicInfo.initArray) + i * 8);
          if (fnPtr !== 0n) initList.push(fnPtr);
        }
      }
    }

    // Main executable constructors
    if (mainDyn.init && mainDyn.init !== 0n) {
      initList.push(mainDyn.init);
    }
    if (mainDyn.initArray && mainDyn.initArraySz) {
      const entries = Math.floor(mainDyn.initArraySz / 8);
      for (let i = 0; i < entries; i++) {
        const fnPtr = this.memory.read64(Number(mainDyn.initArray) + i * 8);
        if (fnPtr !== 0n) initList.push(fnPtr);
      }
    }

    this.constructorList = initList;
  }
}
