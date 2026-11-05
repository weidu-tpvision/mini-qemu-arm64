// emulator.js - Mini-QEMU ARM64 User-Space Emulator (75+ Integer, System, VFP Float & NEON SIMD Instructions)
import {
  Memory,
  VRAM_BASE, FB_WIDTH, FB_HEIGHT, FB_BPP, FB_SIZE, VRAM_END,
  INPUT_BASE, INPUT_REG_KEY_STATE, INPUT_REG_LAST_KEY, INPUT_REG_POINTER_X,
  INPUT_REG_POINTER_Y, INPUT_REG_POINTER_BTN, INPUT_REG_FRAME_COUNT,
  KEY_MASK_UP, KEY_MASK_DOWN, KEY_MASK_LEFT, KEY_MASK_RIGHT,
  KEY_MASK_ACTION_A, KEY_MASK_ACTION_B, KEY_MASK_RESET
} from "./memory.js";
import { CPU } from "./cpu.js";
import { Decoder, InstructionType, ConditionCode } from "./decoder.js";
import { ElfLoader } from "./elf_loader.js";
import { JitCompiler } from "./jit.js";

export class MiniQEMU {
  constructor(options = {}) {
    this.memory = new Memory();
    this.cpu = new CPU(this.memory);
    this.cycleCount = 0;
    this.breakpoints = new Set();
    this.onWrite = null;
    this.onStep = null;
    this.onHalt = null;
    this.loadedSource = null;
    this.entryPoint = 0n;
    this.heapStart = 0x00500000n;
    this.brk = 0x00500000n;
    this.mmapCurrent = 0x10000000n;
    this.mmapRegions = new Map();
    this.onRead = null;
    this.stdinQueue = [];
    this.lastYielded = false;

    // Dynamic Just-In-Time (JIT) Compilation Engine
    this.jitEnabled = options.jitEnabled ?? true;
    this.jit = new JitCompiler({
      hotThreshold: options.jitHotThreshold ?? 5,
      maxBlockInstructions: options.maxBlockInstructions ?? 64
    });

    // Virtual File System (VFS) & Linux File Descriptor Table (fd >= 3)
    this.vfs = new Map();
    this.fds = new Map();
    this.nextFd = 3;
    this.cwd = "/workspace";
  }

  allocFd(minFd = 3) {
    let fd = Math.max(minFd, 3);
    while (this.fds.has(fd)) {
      fd++;
    }
    this.nextFd = Math.max(this.nextFd, fd + 1);
    return fd;
  }

  normalizeVfsPath(rawPath) {
    if (!rawPath) return "";
    let p = String(rawPath).replace(/\\/g, "/").trim();
    if (p.startsWith("/workspace/")) p = p.slice("/workspace/".length);
    if (p.startsWith("./")) p = p.slice(2);
    if (p.startsWith("/")) p = p.slice(1);
    return p;
  }

  mountFile(path, content) {
    const key = this.normalizeVfsPath(path);
    const bytes = typeof content === "string"
      ? new TextEncoder().encode(content)
      : new Uint8Array(content);
    this.vfs.set(key, new Uint8Array(bytes));
  }

  readVfsFile(path, asString = false) {
    const key = this.normalizeVfsPath(path);
    const data = this.vfs.get(key);
    if (!data) return null;
    return asString ? new TextDecoder().decode(data) : new Uint8Array(data);
  }

  readGuestCString(addr, maxLen = 1024) {
    const bytes = [];
    for (let i = 0; i < maxLen; i++) {
      const b = this.memory.read8(addr + i);
      if (b === 0) break;
      bytes.push(b);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  readBytesFromFd(fd, count) {
    if (count <= 0) return new Uint8Array(0);
    let desc = this.fds.get(fd);
    if (desc?.stdFd !== undefined) {
      fd = desc.stdFd;
      desc = null;
    }
    if (desc?.pipe) {
      if (desc.writable) return -9; // -EBADF
      const toRead = Math.min(count, desc.pipe.buf.length);
      const res = new Uint8Array(toRead);
      for (let i = 0; i < toRead; i++) {
        res[i] = desc.pipe.buf.shift();
      }
      return res;
    }
    if (!desc && fd === 0) {
      let bytes = [];
      if (this.onRead) {
        const r = this.onRead(count);
        if (r) {
          const rawBytes = typeof r === "string" ? new TextEncoder().encode(r) : r;
          const len = Math.min(count, rawBytes.length);
          for (let i = 0; i < len; i++) bytes.push(rawBytes[i]);
        }
      } else if (this.stdinQueue.length > 0) {
        while (bytes.length < count && this.stdinQueue.length > 0) {
          bytes.push(this.stdinQueue.shift());
        }
      }
      return new Uint8Array(bytes);
    }
    if (desc && desc.data) {
      const avail = Math.max(0, desc.data.length - desc.pos);
      const toRead = Math.min(count, avail);
      const res = desc.data.slice(desc.pos, desc.pos + toRead);
      desc.pos += toRead;
      return res;
    }
    return -9; // -EBADF
  }

  writeBytesToFd(fd, bytes) {
    let desc = this.fds.get(fd);
    if (desc?.stdFd !== undefined) {
      fd = desc.stdFd;
      desc = null;
    }
    if (desc?.pipe) {
      if (!desc.writable) return -9; // -EBADF
      for (let i = 0; i < bytes.length; i++) {
        desc.pipe.buf.push(bytes[i]);
      }
      return bytes.length;
    }
    if (!desc && (fd === 1 || fd === 2 || fd === 0)) {
      if (fd === 1 || fd === 2) {
        const text = new TextDecoder().decode(bytes);
        if (this.onWrite) {
          this.onWrite(text, fd);
        }
        if (typeof process !== "undefined" && process.stdout && !this.suppressStdout) {
          process.stdout.write(text);
        }
      }
      return bytes.length;
    }
    if (!desc || !desc.writable || !desc.data) return -9; // -EBADF
    if (desc.append) {
      desc.pos = desc.data.length;
    }
    const endPos = desc.pos + bytes.length;
    if (endPos > desc.data.length) {
      const grown = new Uint8Array(endPos);
      grown.set(desc.data);
      desc.data = grown;
    }
    desc.data.set(bytes, desc.pos);
    desc.pos = endPos;
    if (desc.path) {
      this.vfs.set(desc.path, new Uint8Array(desc.data));
    }
    return bytes.length;
  }

  writeGuestStatStruct(statBufAddr, sizeBytes, isCharDev = false) {
    // Zero 128-byte AArch64 struct stat
    for (let i = 0; i < 128; i += 8) {
      this.memory.write64(statBufAddr + i, 0n);
    }
    // st_mode at offset 16 (32-bit): S_IFCHR (0020000 | 0666 = 0x21b6) or S_IFREG (0100000 | 0644 = 0x81a4)
    const mode = isCharDev ? 0x21b6 : 0x81a4;
    this.memory.write32(statBufAddr + 16, mode);
    // st_nlink at offset 20 (32-bit)
    this.memory.write32(statBufAddr + 20, 1);
    // st_size at offset 48 (64-bit)
    this.memory.write64(statBufAddr + 48, BigInt(sizeBytes));
    // st_blksize at offset 56 (32-bit)
    this.memory.write32(statBufAddr + 56, 4096);
  }

  feedStdin(data) {
    if (typeof data === "string") {
      const bytes = new TextEncoder().encode(data);
      for (const b of bytes) this.stdinQueue.push(b);
    } else if (data instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(data))) {
      for (const b of data) this.stdinQueue.push(b);
    }
  }

  addBreakpoint(addr) {
    this.breakpoints.add(Number(addr));
    this.jit?.invalidateRange(Number(addr), 4);
  }

  removeBreakpoint(addr) {
    this.breakpoints.delete(Number(addr));
  }

  toggleBreakpoint(addr) {
    const a = Number(addr);
    if (this.breakpoints.has(a)) {
      this.breakpoints.delete(a);
      this.jit?.invalidateRange(a, 4);
      return false;
    } else {
      this.breakpoints.add(a);
      this.jit?.invalidateRange(a, 4);
      return true;
    }
  }

  clearBreakpoints() {
    this.breakpoints.clear();
  }

  hasBreakpoint(addr) {
    return this.breakpoints.has(Number(addr));
  }

  loadElf(filePathOrBuffer, name = "binary.elf") {
    this.jit?.reset();
    this.memory.clear();
    this.cpu.reset();
    this.cycleCount = 0;
    const progName = typeof filePathOrBuffer === "string" ? filePathOrBuffer.split(/[/\\]/).pop() : name;
    this.loadedSource = { source: filePathOrBuffer, name: progName };
    const entryPoint = ElfLoader.load(filePathOrBuffer, this.memory);
    this.entryPoint = entryPoint;
    this.cpu.pc = entryPoint;

    // Calculate initial program break (brk) at 0x00500000 (or past highest loaded segment, page-aligned)
    let maxAddr = 0x00500000n;
    if (this.memory.segments && this.memory.segments.length > 0) {
      for (const seg of this.memory.segments) {
        const segEnd = BigInt(seg.vaddr + Math.max(seg.filesz, seg.memsz));
        if (segEnd > maxAddr) maxAddr = segEnd;
      }
    }
    this.heapStart = (maxAddr + 4095n) & ~4095n;
    this.brk = this.heapStart;
    this.mmapCurrent = 0x10000000n;
    this.mmapRegions.clear();
    this.stdinQueue = [];
    this.fds.clear();
    this.nextFd = 3;

    // Setup standard Linux initial stack frame (argc, argv, envp, auxv)
    this.setupLinuxStack(entryPoint, progName);

    return entryPoint;
  }

  // Linux AArch64 Initial Process Stack Frame ABI:
  // [SP + 0]: argc
  // [SP + 8]: argv[0] ... argv[argc-1], NULL
  // [SP + ...]: envp[0] ... envp[envc-1], NULL
  // [SP + ...]: auxv vector pairs (AT_PHDR, AT_PHENT, AT_PHNUM, AT_PAGESZ, AT_ENTRY, AT_RANDOM, AT_PLATFORM, etc.)
  setupLinuxStack(entryPoint, programNameOrArgv = "program", envp = []) {
    const stackTop = 0x00700000;
    const argv = Array.isArray(programNameOrArgv) ? programNameOrArgv : [String(programNameOrArgv)];
    let cursor = stackTop;

    // 1. Allocate deterministic 16-byte random seed for AT_RANDOM (stack canary seed)
    cursor -= 16;
    const randomAddr = cursor;
    for (let i = 0; i < 16; i++) {
      this.memory.write8(randomAddr + i, (0xa5 ^ (i * 17)) & 0xff);
    }

    // 2. Write AT_PLATFORM string ("aarch64\0")
    const platformBytes = new TextEncoder().encode("aarch64\0");
    cursor -= platformBytes.length;
    const platformAddr = cursor;
    for (let i = 0; i < platformBytes.length; i++) {
      this.memory.write8(platformAddr + i, platformBytes[i]);
    }

    // 3. Write envp strings
    const envpPtrs = [];
    for (let i = envp.length - 1; i >= 0; i--) {
      const eBytes = new TextEncoder().encode(String(envp[i]) + "\0");
      cursor -= eBytes.length;
      for (let b = 0; b < eBytes.length; b++) {
        this.memory.write8(cursor + b, eBytes[b]);
      }
      envpPtrs.unshift(cursor);
    }

    // 4. Write argv strings
    const argvPtrs = [];
    for (let i = argv.length - 1; i >= 0; i--) {
      const aBytes = new TextEncoder().encode(String(argv[i]) + "\0");
      cursor -= aBytes.length;
      for (let b = 0; b < aBytes.length; b++) {
        this.memory.write8(cursor + b, aBytes[b]);
      }
      argvPtrs.unshift(cursor);
    }

    const elfHdr = this.memory.elfHeader || {};
    const phdrVaddr = elfHdr.phdrVaddr ?? 0x00400040n;
    const phentsize = BigInt(elfHdr.phentsize ?? 56);
    const phnum = BigInt(elfHdr.phnum ?? 1);

    // Build the stack values:
    // argc
    const words = [BigInt(argv.length)];
    // argv pointers + NULL
    for (const ptr of argvPtrs) words.push(BigInt(ptr));
    words.push(0n);
    // envp pointers + NULL
    for (const ptr of envpPtrs) words.push(BigInt(ptr));
    words.push(0n);

    // auxv entries (key, value)
    words.push(3n, BigInt(phdrVaddr));   // AT_PHDR (3)
    words.push(4n, phentsize);           // AT_PHENT (4)
    words.push(5n, phnum);               // AT_PHNUM (5)
    words.push(6n, 4096n);                // AT_PAGESZ (6)
    words.push(9n, BigInt(entryPoint));  // AT_ENTRY (9)
    words.push(25n, BigInt(randomAddr)); // AT_RANDOM (25)
    words.push(7n, 0n);                  // AT_BASE (7)
    words.push(8n, 0n);                  // AT_FLAGS (8)
    words.push(11n, 1000n);              // AT_UID (11)
    words.push(12n, 1000n);              // AT_EUID (12)
    words.push(13n, 1000n);              // AT_GID (13)
    words.push(14n, 1000n);              // AT_EGID (14)
    words.push(15n, BigInt(platformAddr));// AT_PLATFORM (15)
    words.push(16n, 0x3n);               // AT_HWCAP (16): HWCAP_FP (1) | HWCAP_ASIMD (2) - emulator does not implement AES/PMULL/SHA/CRC32/atomics
    words.push(26n, 0n);                 // AT_HWCAP2 (26)
    words.push(17n, 100n);               // AT_CLKTCK (17)
    words.push(23n, 0n);                 // AT_SECURE (23)
    words.push(31n, BigInt(argvPtrs[0] ?? platformAddr)); // AT_EXECFN (31)
    words.push(33n, 0n);                 // AT_SYSINFO_EHDR (33)
    words.push(0n, 0n);                  // AT_NULL (0)

    const tableSizeBytes = words.length * 8;
    const spAddr = (cursor - tableSizeBytes) & ~0xf; // 16-byte aligned

    for (let i = 0; i < words.length; i++) {
      this.memory.write64(spAddr + i * 8, words[i]);
    }

    this.cpu.sp = BigInt(spAddr);
    this.memory.lastWritten.clear();
  }

  reset() {
    this.jit?.reset();
    if (this.loadedSource) {
      return this.loadElf(this.loadedSource.source, this.loadedSource.name);
    } else {
      this.memory.clear();
      this.cpu.reset();
      this.cycleCount = 0;
      return 0n;
    }
  }

  loadProgram(instructions, loadAddress = 0x00400000) {
    this.jit?.reset();
    this.memory.loadProgram(loadAddress, instructions);
    this.cpu.pc = BigInt(loadAddress);
    this.memory.lastWritten.clear();
  }

  // --- Level 1 MMIO Graphics Framebuffer Helpers ---
  getVramBuffer(targetArray = null) {
    return this.memory.readVram(targetArray);
  }

  isVramDirty() {
    return this.memory.isVramDirty();
  }

  clearVramDirty() {
    this.memory.clearVramDirty();
  }

  getVramInfo() {
    return {
      base: VRAM_BASE,
      end: VRAM_END,
      width: FB_WIDTH,
      height: FB_HEIGHT,
      bpp: FB_BPP,
      sizeBytes: FB_SIZE,
      isDirty: this.memory.isVramDirty()
    };
  }

  writeVramPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= FB_WIDTH || y < 0 || y >= FB_HEIGHT) return;
    const offset = VRAM_BASE + (y * FB_WIDTH + x) * FB_BPP;
    this.memory.write8(offset + 0, r);
    this.memory.write8(offset + 1, g);
    this.memory.write8(offset + 2, b);
    this.memory.write8(offset + 3, a);
  }

  readVramPixel(x, y) {
    if (x < 0 || x >= FB_WIDTH || y < 0 || y >= FB_HEIGHT) return { r: 0, g: 0, b: 0, a: 0 };
    const offset = VRAM_BASE + (y * FB_WIDTH + x) * FB_BPP;
    return {
      r: this.memory.read8(offset + 0),
      g: this.memory.read8(offset + 1),
      b: this.memory.read8(offset + 2),
      a: this.memory.read8(offset + 3)
    };
  }

  // --- MMIO Interactive Input Helpers (Keyboard, Gamepad & Pointer) ---
  setKeyState(keyMask, lastKey = 0) {
    this.memory.write32(INPUT_REG_KEY_STATE, keyMask >>> 0);
    if (lastKey) {
      this.memory.write32(INPUT_REG_LAST_KEY, lastKey >>> 0);
    }
  }

  setPointerState(x, y, buttons = 0) {
    const clX = Math.max(0, Math.min(FB_WIDTH - 1, Math.floor(x)));
    const clY = Math.max(0, Math.min(FB_HEIGHT - 1, Math.floor(y)));
    this.memory.write32(INPUT_REG_POINTER_X, clX);
    this.memory.write32(INPUT_REG_POINTER_Y, clY);
    this.memory.write32(INPUT_REG_POINTER_BTN, buttons >>> 0);
  }

  getKeyState() {
    return this.memory.read32(INPUT_REG_KEY_STATE);
  }

  getPointerState() {
    return {
      x: this.memory.read32(INPUT_REG_POINTER_X),
      y: this.memory.read32(INPUT_REG_POINTER_Y),
      buttons: this.memory.read32(INPUT_REG_POINTER_BTN)
    };
  }

  getInputInfo() {
    return {
      base: INPUT_BASE,
      keyState: this.getKeyState(),
      lastKey: this.memory.read32(INPUT_REG_LAST_KEY),
      pointer: this.getPointerState(),
      frameCount: this.memory.read32(INPUT_REG_FRAME_COUNT)
    };
  }

  // Apply ARM64 barrel shifter (00=LSL, 01=LSR, 10=ASR)
  applyShift(value, shiftType = 0, amount = 0, sf = 1) {
    const bits = sf === 0 ? 32 : 64;
    const maskedVal = BigInt.asUintN(bits, value);
    if (!amount) return maskedVal;
    const amt = BigInt(amount & (sf === 0 ? 0x1f : 0x3f));
    if (shiftType === 0b00) return BigInt.asUintN(bits, maskedVal << amt); // LSL
    if (shiftType === 0b01) return BigInt.asUintN(bits, maskedVal >> amt); // LSR
    if (shiftType === 0b10) return BigInt.asUintN(bits, BigInt.asIntN(bits, maskedVal) >> amt); // ASR
    return maskedVal;
  }

  // Apply ARM64 Unsigned Bitfield Move (UBFM / UXTB / UXTH / UBFX / LSR / LSL)
  applyUBFM(srcVal, immr, imms, bits = 64) {
    const src = BigInt.asUintN(bits, srcVal);
    if (imms >= immr) {
      const width = imms - immr + 1;
      const mask = (1n << BigInt(width)) - 1n;
      return (src >> BigInt(immr)) & mask;
    } else {
      const width = imms + 1;
      const shift = bits - immr;
      const mask = (1n << BigInt(width)) - 1n;
      return BigInt.asUintN(bits, (src & mask) << BigInt(shift));
    }
  }

  // Apply ARM64 Signed Bitfield Move (SBFM / SXTB / SXTH / SXTW / SBFX / ASR)
  applySBFM(srcVal, immr, imms, bits = 64) {
    const src = BigInt.asUintN(bits, srcVal);
    if (imms >= immr) {
      const width = imms - immr + 1;
      const mask = (1n << BigInt(width)) - 1n;
      const field = (src >> BigInt(immr)) & mask;
      return BigInt.asUintN(bits, BigInt.asIntN(width, field));
    } else {
      const width = imms + 1;
      const shift = bits - immr;
      const mask = (1n << BigInt(width)) - 1n;
      const field = src & mask;
      return BigInt.asUintN(bits, BigInt.asIntN(width, field) << BigInt(shift));
    }
  }

  // Compute effective memory address for single-register loads/stores (Immediate, Unscaled, Pre/Post-Index, or Register-Offset)
  computeLoadStoreAddr(decoded) {
    const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
    if (decoded.isRegOffset) {
      const rmVal = this.cpu.getReg(decoded.rm);
      let indexVal;
      if (decoded.option === 0b010) {
        indexVal = BigInt.asUintN(32, rmVal); // UXTW
      } else if (decoded.option === 0b110) {
        indexVal = BigInt.asIntN(32, rmVal);  // SXTW
      } else if (decoded.option === 0b111) {
        indexVal = BigInt.asIntN(64, rmVal);  // SXTX
      } else {
        indexVal = BigInt.asIntN(64, rmVal);  // LSL / UXTX
      }
      if (decoded.regShift > 0) {
        indexVal = indexVal << BigInt(decoded.regShift);
      }
      return { baseAddr, targetAddr: baseAddr + Number(indexVal) };
    }
    const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
    return { baseAddr, targetAddr };
  }

  evalCondition(cond) {
    const { N, Z, C, V } = this.cpu.flags;
    switch (cond) {
      case ConditionCode.EQ: return Z;
      case ConditionCode.NE: return !Z;
      case ConditionCode.CS: return C;
      case ConditionCode.CC: return !C;
      case ConditionCode.MI: return N;
      case ConditionCode.PL: return !N;
      case ConditionCode.VS: return V;
      case ConditionCode.VC: return !V;
      case ConditionCode.HI: return C && !Z;
      case ConditionCode.LS: return !C || Z;
      case ConditionCode.GE: return N === V;
      case ConditionCode.LT: return N !== V;
      case ConditionCode.GT: return !Z && (N === V);
      case ConditionCode.LE: return Z || (N !== V);
      case ConditionCode.AL: return true;
      default:
        throw new Error(`Unsupported condition code: ${cond}`);
    }
  }

  handleSyscall(imm16 = 0) {
    const syscallNum = Number(this.cpu.getReg(8));
    let isYield = false;

    if (syscallNum === 93 || syscallNum === 94) { // sys_exit (93) / sys_exit_group (94)
      this.cpu.exitCode = Number(this.cpu.getReg(0));
      this.cpu.halted = true;
      if (this.onHalt) {
        this.onHalt(this.cpu.exitCode);
      }
    } else if (syscallNum === 17) { // sys_getcwd(buf, size)
      const bufAddr = Number(this.cpu.getReg(0));
      const size = Number(this.cpu.getReg(1));
      const cwdBytes = new TextEncoder().encode(this.cwd + "\0");
      if (size < cwdBytes.length) {
        this.cpu.setReg(0, BigInt.asUintN(64, -34n)); // -ERANGE
      } else {
        for (let i = 0; i < cwdBytes.length; i++) {
          this.memory.write8(bufAddr + i, cwdBytes[i]);
        }
        this.cpu.setReg(0, BigInt(bufAddr));
      }
    } else if (syscallNum === 35) { // sys_unlinkat(dirfd, pathname, flags)
      const pathAddr = Number(this.cpu.getReg(1));
      const key = this.normalizeVfsPath(this.readGuestCString(pathAddr));
      if (this.vfs.has(key)) {
        this.vfs.delete(key);
        this.cpu.setReg(0, 0n);
      } else {
        this.cpu.setReg(0, BigInt.asUintN(64, -2n)); // -ENOENT
      }
    } else if (syscallNum === 56) { // sys_openat(dirfd, pathname, flags, mode)
      const pathAddr = Number(this.cpu.getReg(1));
      const flags = Number(this.cpu.getReg(2));
      const key = this.normalizeVfsPath(this.readGuestCString(pathAddr));

      // Linux AArch64 open flags: O_ACCMODE=3 (0=RDONLY, 1=WRONLY, 2=RDWR), O_CREAT=0x40, O_TRUNC=0x200, O_APPEND=0x400
      const accMode = flags & 0x3;
      const isCreat = (flags & 0x40) !== 0;
      const isTrunc = (flags & 0x200) !== 0;
      const isAppend = (flags & 0x400) !== 0;
      const writable = (accMode === 1 || accMode === 2);

      let existing = this.vfs.get(key);
      if (!existing && !isCreat) {
        this.cpu.setReg(0, BigInt.asUintN(64, -2n)); // -ENOENT
      } else {
        const data = (!existing || isTrunc) ? new Uint8Array(0) : new Uint8Array(existing);
        this.vfs.set(key, new Uint8Array(data));
        const fd = this.allocFd();
        this.fds.set(fd, {
          path: key,
          data,
          pos: isAppend ? data.length : 0,
          flags,
          writable,
          append: isAppend,
        });
        this.cpu.setReg(0, BigInt(fd));
      }
    } else if (syscallNum === 57) { // sys_close(fd)
      const fd = Number(this.cpu.getReg(0));
      if (this.fds.has(fd)) {
        const desc = this.fds.get(fd);
        if (desc.writable && desc.path && desc.data) {
          this.vfs.set(desc.path, new Uint8Array(desc.data));
        }
        this.fds.delete(fd);
        this.cpu.setReg(0, 0n);
      } else if (fd >= 0 && fd <= 2) {
        this.cpu.setReg(0, 0n);
      } else {
        this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
      }
    } else if (syscallNum === 62) { // sys_lseek(fd, offset, whence)
      const fd = Number(this.cpu.getReg(0));
      const offset = Number(BigInt.asIntN(64, this.cpu.getReg(1)));
      const whence = Number(this.cpu.getReg(2)); // 0=SEEK_SET, 1=SEEK_CUR, 2=SEEK_END
      let desc = this.fds.get(fd);
      if (desc?.stdFd !== undefined || (desc === undefined && fd >= 0 && fd <= 2) || desc?.pipe) {
        this.cpu.setReg(0, BigInt.asUintN(64, -29n)); // -ESPIPE
      } else if (!desc || !desc.data) {
        this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
      } else {
        let newPos = desc.pos;
        if (whence === 0) newPos = offset;
        else if (whence === 1) newPos = desc.pos + offset;
        else if (whence === 2) newPos = desc.data.length + offset;
        else {
          this.cpu.setReg(0, BigInt.asUintN(64, -22n)); // -EINVAL
          newPos = null;
        }
        if (newPos !== null) {
          if (newPos < 0) {
            this.cpu.setReg(0, BigInt.asUintN(64, -22n)); // -EINVAL
          } else {
            desc.pos = newPos;
            this.cpu.setReg(0, BigInt(newPos));
          }
        }
      }
    } else if (syscallNum === 64) { // sys_write(fd, buf, count)
      const fd = Number(this.cpu.getReg(0));
      const bufAddr = Number(this.cpu.getReg(1));
      const count = Number(this.cpu.getReg(2));

      const bytes = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        bytes[i] = this.memory.read8(bufAddr + i);
      }
      const written = this.writeBytesToFd(fd, bytes);
      this.cpu.setReg(0, BigInt.asUintN(64, BigInt(written)));
    } else if (syscallNum === 66) { // sys_writev(fd, iov, iovcnt) - scatter/gather I/O used by musl/glibc printf
      const fd = Number(this.cpu.getReg(0));
      const iovAddr = Number(this.cpu.getReg(1));
      const iovcnt = Number(this.cpu.getReg(2));

      let totalWritten = 0;
      for (let v = 0; v < iovcnt; v++) {
        const entryAddr = iovAddr + v * 16;
        const basePtr = Number(this.memory.read64(entryAddr));
        const len = Number(this.memory.read64(entryAddr + 8));
        if (len > 0) {
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = this.memory.read8(basePtr + i);
          }
          const res = this.writeBytesToFd(fd, bytes);
          if (res < 0) {
            totalWritten = res;
            break;
          }
          totalWritten += res;
        }
      }
      this.cpu.setReg(0, BigInt.asUintN(64, BigInt(totalWritten)));
    } else if (syscallNum === 63) { // sys_read(fd, buf, count)
      const fd = Number(this.cpu.getReg(0));
      const bufAddr = Number(this.cpu.getReg(1));
      const count = Number(this.cpu.getReg(2));

      const res = this.readBytesFromFd(fd, count);
      if (typeof res === "number") {
        this.cpu.setReg(0, BigInt.asUintN(64, BigInt(res)));
      } else {
        for (let i = 0; i < res.length; i++) {
          this.memory.write8(bufAddr + i, res[i]);
        }
        this.cpu.setReg(0, BigInt(res.length));
      }
    } else if (syscallNum === 214) { // sys_brk(brk)
      const requestedBrk = this.cpu.getReg(0);
      if (requestedBrk === 0n || requestedBrk < this.heapStart) {
        // Return current program break
        this.cpu.setReg(0, this.brk);
      } else {
        if (requestedBrk < this.brk) {
          // Contraction: free pages between requestedBrk and this.brk
          const shrinkLen = Number(this.brk - requestedBrk);
          this.memory.freeRange(Number(requestedBrk), shrinkLen);
          this.jit?.invalidateRange(Number(requestedBrk), shrinkLen);
        }
        // Expand or update heap to requested address
        this.brk = requestedBrk;
        this.cpu.setReg(0, this.brk);
      }
    } else if (syscallNum === 222) { // sys_mmap(addr, length, prot, flags, fd, offset)
      const addr = this.cpu.getReg(0);
      const len = this.cpu.getReg(1);
      const prot = Number(this.cpu.getReg(2));
      const flags = Number(this.cpu.getReg(3));
      const fd = Number(BigInt.asIntN(32, this.cpu.getReg(4)));
      const offset = Number(this.cpu.getReg(5));
      // Allocate page-aligned chunk from mmap space
      const alignedLen = (len + 4095n) & ~4095n;
      let allocAddr = addr;
      if (allocAddr === 0n) {
        allocAddr = this.mmapCurrent;
        this.mmapCurrent += alignedLen;
      }
      const numAllocAddr = Number(allocAddr);
      // Populate mapped pages if file-backed (fd >= 0 in VFS table)
      if (fd >= 0 && this.fds.has(fd)) {
        const desc = this.fds.get(fd);
        if (desc.data) {
          const avail = Math.max(0, desc.data.length - offset);
          const copyLen = Math.min(Number(len), avail);
          for (let i = 0; i < copyLen; i++) {
            this.memory.write8(numAllocAddr + i, desc.data[offset + i]);
          }
        }
      }
      this.mmapRegions.set(numAllocAddr, {
        addr: numAllocAddr,
        len: Number(alignedLen),
        prot,
        flags,
        fd,
        offset
      });
      this.cpu.setReg(0, allocAddr);
    } else if (syscallNum === 215) { // sys_munmap(addr, length)
      const addr = Number(this.cpu.getReg(0));
      const len = Number(this.cpu.getReg(1));
      const alignedLen = (len + 4095) & ~4095;
      this.memory.freeRange(addr, alignedLen);
      this.jit?.invalidateRange(addr, alignedLen);
      if (this.mmapRegions.has(addr)) {
        const region = this.mmapRegions.get(addr);
        if (alignedLen >= region.len) {
          this.mmapRegions.delete(addr);
        } else {
          // Shrink region if only the leading portion was unmapped
          this.mmapRegions.delete(addr);
          this.mmapRegions.set(addr + alignedLen, {
            ...region,
            addr: addr + alignedLen,
            len: region.len - alignedLen
          });
        }
      }
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 226) { // sys_mprotect
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 113) { // sys_clock_gettime(clk_id, tp)
      const tpAddr = Number(this.cpu.getReg(1));
      const nowMs = Date.now();
      const sec = BigInt(Math.floor(nowMs / 1000));
      const nsec = BigInt((nowMs % 1000) * 1_000_000);
      this.memory.write64(tpAddr, sec);
      this.memory.write64(tpAddr + 8, nsec);
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 160) { // sys_uname(buf)
      const bufAddr = Number(this.cpu.getReg(0));
      const writeField = (offset, text) => {
        const bytes = new TextEncoder().encode(text);
        for (let i = 0; i < 64; i++) {
          this.memory.write8(bufAddr + offset + i, i < bytes.length ? bytes[i] : 0);
        }
        this.memory.write8(bufAddr + offset + 64, 0);
      };
      writeField(0, "Linux");
      writeField(65, "mini-qemu");
      writeField(130, "6.1.0-mini-qemu");
      writeField(195, "#1 SMP Mini-QEMU");
      writeField(260, "aarch64");
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 96 || syscallNum === 172 || syscallNum === 178) { // set_tid_address (96), getpid (172), gettid (178)
      this.cpu.setReg(0, 1000n);
    } else if (syscallNum === 278) { // sys_getrandom(buf, buflen, flags)
      const bufAddr = Number(this.cpu.getReg(0));
      const buflen = Number(this.cpu.getReg(1));
      for (let i = 0; i < buflen; i++) {
        this.memory.write8(bufAddr + i, ((i * 37) ^ 0x5c) & 0xff);
      }
      this.cpu.setReg(0, BigInt(buflen));
    } else if (syscallNum === 80) { // sys_fstat(fd, statbuf)
      const fd = Number(this.cpu.getReg(0));
      const statBufAddr = Number(this.cpu.getReg(1));
      let desc = this.fds.get(fd);
      if (desc) {
        if (desc.stdFd !== undefined || desc.pipe) {
          if (statBufAddr > 0) this.writeGuestStatStruct(statBufAddr, 0, true);
          this.cpu.setReg(0, 0n);
        } else if (desc.data) {
          if (statBufAddr > 0) this.writeGuestStatStruct(statBufAddr, desc.data.length, false);
          this.cpu.setReg(0, 0n);
        } else {
          this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
        }
      } else if (fd >= 0 && fd <= 2) {
        if (statBufAddr > 0) this.writeGuestStatStruct(statBufAddr, 0, true);
        this.cpu.setReg(0, 0n);
      } else {
        this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
      }
    } else if (syscallNum === 79) { // sys_newfstatat(dirfd, pathname, statbuf, flags)
      const pathAddr = Number(this.cpu.getReg(1));
      const statBufAddr = Number(this.cpu.getReg(2));
      const key = this.normalizeVfsPath(this.readGuestCString(pathAddr));
      if (this.vfs.has(key)) {
        const data = this.vfs.get(key);
        if (statBufAddr > 0) this.writeGuestStatStruct(statBufAddr, data.length, false);
        this.cpu.setReg(0, 0n);
      } else {
        this.cpu.setReg(0, BigInt.asUintN(64, -2n)); // -ENOENT
      }
    } else if (syscallNum === 124) { // sys_sched_yield
      const curFrames = this.memory.read32(INPUT_REG_FRAME_COUNT);
      this.memory.write32(INPUT_REG_FRAME_COUNT, (curFrames + 1) >>> 0);
      this.cpu.setReg(0, 0n);
      isYield = true;
    } else if (syscallNum === 65) { // sys_readv(fd, iov, iovcnt)
      const fd = Number(this.cpu.getReg(0));
      const iovAddr = Number(this.cpu.getReg(1));
      const iovcnt = Number(this.cpu.getReg(2));
      let totalRead = 0;
      let hadError = false;
      let errVal = 0;
      for (let v = 0; v < iovcnt; v++) {
        const entryAddr = iovAddr + v * 16;
        const basePtr = Number(this.memory.read64(entryAddr));
        const len = Number(this.memory.read64(entryAddr + 8));
        if (len > 0) {
          const res = this.readBytesFromFd(fd, len);
          if (typeof res === "number") {
            hadError = true;
            errVal = res;
            break;
          }
          for (let i = 0; i < res.length; i++) {
            this.memory.write8(basePtr + i, res[i]);
          }
          totalRead += res.length;
          if (res.length < len) break; // short read
        }
      }
      if (hadError && totalRead === 0) {
        this.cpu.setReg(0, BigInt.asUintN(64, BigInt(errVal)));
      } else {
        this.cpu.setReg(0, BigInt.asUintN(64, BigInt(totalRead)));
      }
    } else if (syscallNum === 23) { // sys_dup(oldfd)
      const oldFd = Number(this.cpu.getReg(0));
      let desc;
      if (this.fds.has(oldFd)) {
        desc = this.fds.get(oldFd);
      } else if (oldFd >= 0 && oldFd <= 2) {
        desc = { stdFd: oldFd };
      } else {
        this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
        desc = null;
      }
      if (desc) {
        const newFd = this.allocFd();
        this.fds.set(newFd, desc);
        this.cpu.setReg(0, BigInt(newFd));
      }
    } else if (syscallNum === 24) { // sys_dup3(oldfd, newfd, flags)
      const oldFd = Number(this.cpu.getReg(0));
      const newFd = Number(this.cpu.getReg(1));
      if (oldFd === newFd) {
        this.cpu.setReg(0, BigInt.asUintN(64, -22n)); // -EINVAL
      } else {
        let desc;
        if (this.fds.has(oldFd)) {
          desc = this.fds.get(oldFd);
        } else if (oldFd >= 0 && oldFd <= 2) {
          desc = { stdFd: oldFd };
        } else {
          this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
          desc = null;
        }
        if (desc) {
          if (this.fds.has(newFd)) {
            const oldTarget = this.fds.get(newFd);
            if (oldTarget.writable && oldTarget.path && oldTarget.data) {
              this.vfs.set(oldTarget.path, new Uint8Array(oldTarget.data));
            }
            this.fds.delete(newFd);
          }
          this.fds.set(newFd, desc);
          if (newFd >= 3) {
            this.nextFd = Math.max(this.nextFd, newFd + 1);
          }
          this.cpu.setReg(0, BigInt(newFd));
        }
      }
    } else if (syscallNum === 59) { // sys_pipe2(pipefd, flags)
      const pipeFdAddr = Number(this.cpu.getReg(0));
      const pipe = { buf: [] };
      const rFd = this.allocFd();
      this.fds.set(rFd, { path: null, pipe, writable: false, readable: true });
      const wFd = this.allocFd();
      this.fds.set(wFd, { path: null, pipe, writable: true });
      this.memory.write32(pipeFdAddr, rFd);
      this.memory.write32(pipeFdAddr + 4, wFd);
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 98) { // sys_futex(uaddr, futex_op, val, timeout, uaddr2, val3)
      const uaddr = Number(this.cpu.getReg(0));
      const futexOp = Number(this.cpu.getReg(1)) & ~128; // Clear FUTEX_PRIVATE_FLAG (128)
      const val = Number(BigInt.asIntN(32, this.cpu.getReg(2)));
      if (futexOp === 0) { // FUTEX_WAIT
        if (uaddr > 0) {
          const curVal = this.memory.read32(uaddr);
          if (curVal !== val) {
            this.cpu.setReg(0, BigInt.asUintN(64, -11n)); // -EAGAIN
          } else {
            this.cpu.setReg(0, 0n);
          }
        } else {
          this.cpu.setReg(0, 0n);
        }
      } else { // FUTEX_WAKE (1), FUTEX_REQUEUE (3), etc.
        this.cpu.setReg(0, 0n);
      }
    } else if (syscallNum === 99) { // sys_set_robust_list(head, len)
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 134) { // sys_rt_sigaction(signum, act, oldact, sigsetsize)
      const oldActAddr = Number(this.cpu.getReg(2));
      if (oldActAddr > 0) {
        for (let i = 0; i < 32; i += 8) this.memory.write64(oldActAddr + i, 0n);
      }
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 135) { // sys_rt_sigprocmask(how, set, oldset, sigsetsize)
      const oldSetAddr = Number(this.cpu.getReg(2));
      if (oldSetAddr > 0) {
        this.memory.write64(oldSetAddr, 0n);
      }
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 132) { // sys_sigaltstack(ss, old_ss)
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 129 || syscallNum === 130 || syscallNum === 131) { // sys_kill (129), sys_tkill (130), sys_tgkill (131)
      const sig = syscallNum === 131 ? Number(this.cpu.getReg(2)) : Number(this.cpu.getReg(1));
      if (sig === 6 || sig === 9 || sig === 15) { // SIGABRT, SIGKILL, SIGTERM
        this.cpu.exitCode = 128 + sig;
        this.cpu.halted = true;
        if (this.onHalt) this.onHalt(this.cpu.exitCode);
      }
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 173) { // sys_getppid
      this.cpu.setReg(0, 1n);
    } else if (syscallNum >= 174 && syscallNum <= 177) { // sys_getuid (174), sys_geteuid (175), sys_getgid (176), sys_getegid (177)
      this.cpu.setReg(0, 1000n);
    } else if (syscallNum === 169) { // sys_gettimeofday(tv, tz)
      const tvAddr = Number(this.cpu.getReg(0));
      if (tvAddr > 0) {
        const nowMs = Date.now();
        const sec = BigInt(Math.floor(nowMs / 1000));
        const usec = BigInt((nowMs % 1000) * 1000);
        this.memory.write64(tvAddr, sec);
        this.memory.write64(tvAddr + 8, usec);
      }
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 101 || syscallNum === 115) { // sys_nanosleep (101), sys_clock_nanosleep (115)
      this.cpu.setReg(0, 0n);
      isYield = true;
    } else if (syscallNum === 233) { // sys_madvise(addr, len, advice)
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 261) { // sys_prlimit64(pid, resource, new_limit, old_limit)
      const resource = Number(this.cpu.getReg(1));
      const oldLimitAddr = Number(this.cpu.getReg(3));
      if (oldLimitAddr > 0) {
        const RLIM_INFINITY = 0xffffffffffffffffn;
        let rlimCur = RLIM_INFINITY;
        let rlimMax = RLIM_INFINITY;
        if (resource === 3) { // RLIMIT_STACK
          rlimCur = 8n * 1024n * 1024n; // 8MB
          rlimMax = RLIM_INFINITY;
        } else if (resource === 7) { // RLIMIT_NOFILE
          rlimCur = 1024n;
          rlimMax = 4096n;
        } else if (resource === 9 || resource === 2) { // RLIMIT_AS (9), RLIMIT_DATA (2)
          rlimCur = RLIM_INFINITY;
          rlimMax = RLIM_INFINITY;
        }
        this.memory.write64(oldLimitAddr, rlimCur);
        this.memory.write64(oldLimitAddr + 8, rlimMax);
      }
      this.cpu.setReg(0, 0n);
    } else if (syscallNum === 291 || syscallNum === 293) { // sys_statx (291), sys_rseq (293)
      this.cpu.setReg(0, BigInt.asUintN(64, -38n)); // -ENOSYS
    } else if (syscallNum === 25) { // sys_fcntl(fd, cmd, arg)
      const fd = Number(this.cpu.getReg(0));
      const cmd = Number(this.cpu.getReg(1));
      const arg = Number(this.cpu.getReg(2));
      if (cmd === 0 || cmd === 1030) { // F_DUPFD (0), F_DUPFD_CLOEXEC (1030)
        let desc;
        if (this.fds.has(fd)) {
          desc = this.fds.get(fd);
        } else if (fd >= 0 && fd <= 2) {
          desc = { stdFd: fd };
        } else {
          this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
          desc = null;
        }
        if (desc) {
          const newFd = this.allocFd(arg);
          this.fds.set(newFd, desc);
          this.cpu.setReg(0, BigInt(newFd));
        }
      } else if (cmd === 1 || cmd === 2 || cmd === 4) { // F_GETFD (1), F_SETFD (2), F_SETFL (4)
        const isValid = (this.fds.has(fd) || (fd >= 0 && fd <= 2));
        if (isValid) {
          this.cpu.setReg(0, 0n);
        } else {
          this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
        }
      } else if (cmd === 3) { // F_GETFL
        if (this.fds.has(fd)) {
          const desc = this.fds.get(fd);
          if (desc.stdFd !== undefined) this.cpu.setReg(0, 2n); // O_RDWR
          else if (desc.pipe) this.cpu.setReg(0, desc.writable ? 1n : 0n);
          else this.cpu.setReg(0, BigInt(desc.flags || 0));
        } else if (fd >= 0 && fd <= 2) {
          this.cpu.setReg(0, 2n);
        } else {
          this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
        }
      } else {
        const isValid = (this.fds.has(fd) || (fd >= 0 && fd <= 2));
        if (isValid) {
          this.cpu.setReg(0, 0n);
        } else {
          this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
        }
      }
    } else if (syscallNum === 29) { // sys_ioctl(fd, cmd, arg)
      const fd = Number(this.cpu.getReg(0));
      const cmd = Number(this.cpu.getReg(1));
      const arg = Number(this.cpu.getReg(2));
      const desc = this.fds.get(fd);
      const isTty = (desc === undefined && fd >= 0 && fd <= 2) || (desc?.stdFd !== undefined);
      if (!isTty) {
        if (this.fds.has(fd)) {
          this.cpu.setReg(0, BigInt.asUintN(64, -25n)); // -ENOTTY
        } else {
          this.cpu.setReg(0, BigInt.asUintN(64, -9n)); // -EBADF
        }
      } else {
        // TIOCGWINSZ (0x5413): window size query used by terminal/curses/musl stdout setup
        if (cmd === 0x5413 && arg > 0) {
          this.memory.write16(arg + 0, 24); // ws_row = 24
          this.memory.write16(arg + 2, 80); // ws_col = 80
          this.memory.write16(arg + 4, 0);  // ws_xpixel = 0
          this.memory.write16(arg + 6, 0);  // ws_ypixel = 0
          this.cpu.setReg(0, 0n);
        } else if (cmd === 0x5401 && arg > 0) { // TCGETS (0x5401)
          for (let i = 0; i < 60; i++) {
            this.memory.write8(arg + i, 0);
          }
          this.cpu.setReg(0, 0n);
        } else {
          this.cpu.setReg(0, 0n);
        }
      }
    } else {
      // Return -ENOSYS (-38) per official Linux kernel semantics for unknown/unsupported syscalls
      this.cpu.setReg(0, BigInt.asUintN(64, -38n));
    }

    this.lastYielded = isYield;
    return { yielded: isYield, halted: this.cpu.halted };
  }

  // Execute one cycle: Fetch -> Decode -> Execute
  step(verbose = true) {
    if (this.cpu.halted) {
      return {
        cycle: this.cycleCount,
        pc: Number(this.cpu.pc),
        halted: true,
        exitCode: this.cpu.exitCode
      };
    }

    const currentPC = Number(this.cpu.pc);
    const prevRegs = Array.from(this.cpu.x);
    const prevV64 = new BigUint64Array(this.cpu.vUint64);
    const prevSP = this.cpu.sp;
    this.memory.lastWritten.clear();

    // 1. FETCH
    const rawInstr = this.memory.read32(currentPC);
    const hexPC = `0x${currentPC.toString(16).padStart(8, "0")}`;
    const hexInstr = `0x${rawInstr.toString(16).padStart(8, "0")}`;

    // 2. DECODE
    const decoded = Decoder.decode(rawInstr);
    let isYield = false;

    // 3. EXECUTE
    switch (decoded.type) {
      // --- Immediates ---
      case InstructionType.ADR: {
        const targetAddr = currentPC + decoded.offsetBytes;
        this.cpu.setReg(decoded.rd, BigInt(targetAddr));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ADRP: {
        const basePage = BigInt(currentPC) & ~0xfffn;
        const targetPage = BigInt.asUintN(64, basePage + BigInt(decoded.imm21) * 4096n);
        this.cpu.setReg(decoded.rd, targetPage);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MOVZ:
      case InstructionType.MOVN: {
        const bits = decoded.sf === 0 ? 32 : 64;
        this.cpu.setReg(decoded.rd, BigInt.asUintN(bits, decoded.immValue));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MOVK: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const clearMask = ~(0xffffn << BigInt(decoded.shift));
        const kept = this.cpu.getReg(decoded.rd) & clearMask;
        const val = BigInt.asUintN(bits, kept | decoded.immValue);
        this.cpu.setReg(decoded.rd, val);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ADD_IMM: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const sum = BigInt.asUintN(bits, BigInt.asUintN(bits, this.cpu.getSPOrReg(decoded.rn)) + decoded.immValue);
        this.cpu.setSPOrReg(decoded.rd, sum);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUB_IMM: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const diff = BigInt.asUintN(bits, BigInt.asUintN(bits, this.cpu.getSPOrReg(decoded.rn)) - decoded.immValue);
        this.cpu.setSPOrReg(decoded.rd, diff);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUBS_IMM: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const signBit = BigInt(bits - 1);
        const op1 = BigInt.asUintN(bits, this.cpu.getSPOrReg(decoded.rn));
        const op2 = BigInt.asUintN(bits, decoded.immValue);
        const result = BigInt.asUintN(bits, op1 - op2);

        this.cpu.setReg(decoded.rd, result);

        this.cpu.flags.Z = (result === 0n);
        this.cpu.flags.N = ((result & (1n << signBit)) !== 0n);
        this.cpu.flags.C = (op1 >= op2);
        const s_op1 = BigInt.asIntN(bits, op1);
        const s_op2 = BigInt.asIntN(bits, op2);
        const s_res = BigInt.asIntN(bits, result);
        this.cpu.flags.V = ((s_op1 ^ s_op2) < 0n) && ((s_op1 ^ s_res) < 0n);

        this.cpu.pc += 4n;
        break;
      }

      // --- Register Arithmetic & Logic ---
      case InstructionType.ADD_REG: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const op1 = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6, decoded.sf);
        const sum = BigInt.asUintN(bits, op1 + op2);
        this.cpu.setReg(decoded.rd, sum);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUB_REG: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const op1 = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6, decoded.sf);
        const diff = BigInt.asUintN(bits, op1 - op2);
        this.cpu.setReg(decoded.rd, diff);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUBS_REG: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const signBit = BigInt(bits - 1);
        const op1 = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6, decoded.sf);
        const result = BigInt.asUintN(bits, op1 - op2);

        this.cpu.setReg(decoded.rd, result);

        this.cpu.flags.Z = (result === 0n);
        this.cpu.flags.N = ((result & (1n << signBit)) !== 0n);
        this.cpu.flags.C = (op1 >= op2);
        const s_op1 = BigInt.asIntN(bits, op1);
        const s_op2 = BigInt.asIntN(bits, op2);
        const s_res = BigInt.asIntN(bits, result);
        this.cpu.flags.V = ((s_op1 ^ s_op2) < 0n) && ((s_op1 ^ s_res) < 0n);

        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.AND_REG: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const op1 = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6, decoded.sf);
        const res = BigInt.asUintN(bits, op1 & op2);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ORR_REG: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const op1 = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6, decoded.sf);
        const res = BigInt.asUintN(bits, op1 | op2);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.EOR_REG: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const op1 = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6, decoded.sf);
        const res = BigInt.asUintN(bits, op1 ^ op2);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MVN_REG: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6, decoded.sf);
        const res = BigInt.asUintN(bits, ~op2);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      // --- Conditional Select (CSEL / CSINC / CSINV / CSNEG / CSET) ---
      case InstructionType.CSEL:
      case InstructionType.CSINC:
      case InstructionType.CSINV:
      case InstructionType.CSNEG: {
        const condMet = this.evalCondition(decoded.cond);
        let val;
        if (condMet) {
          val = this.cpu.getReg(decoded.rn);
        } else {
          const rmVal = this.cpu.getReg(decoded.rm);
          if (decoded.type === InstructionType.CSEL) {
            val = rmVal;
          } else if (decoded.type === InstructionType.CSINC) {
            val = BigInt.asUintN(64, rmVal + 1n);
          } else if (decoded.type === InstructionType.CSINV) {
            val = BigInt.asUintN(64, ~rmVal);
          } else if (decoded.type === InstructionType.CSNEG) {
            val = BigInt.asUintN(64, -rmVal);
          }
        }
        if (!decoded.sf) {
          val = BigInt.asUintN(32, val);
        }
        this.cpu.setReg(decoded.rd, val);
        this.cpu.pc += 4n;
        break;
      }

      // --- Math: Multiply, Multiply-Add/Sub & Divide ---
      case InstructionType.MUL: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const res = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn) * this.cpu.getReg(decoded.rm));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MADD: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const prod = this.cpu.getReg(decoded.rn) * this.cpu.getReg(decoded.rm);
        const res = BigInt.asUintN(bits, this.cpu.getReg(decoded.ra) + prod);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MSUB: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const prod = this.cpu.getReg(decoded.rn) * this.cpu.getReg(decoded.rm);
        const res = BigInt.asUintN(bits, this.cpu.getReg(decoded.ra) - prod);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.UDIV: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const op1 = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const divisor = BigInt.asUintN(bits, this.cpu.getReg(decoded.rm));
        const res = (divisor === 0n) ? 0n : BigInt.asUintN(bits, op1 / divisor);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SDIV: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const s_op1 = BigInt.asIntN(bits, this.cpu.getReg(decoded.rn));
        const s_op2 = BigInt.asIntN(bits, this.cpu.getReg(decoded.rm));
        const res = (s_op2 === 0n) ? 0n : BigInt.asUintN(bits, s_op1 / s_op2);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      // --- Bit Shifts ---
      case InstructionType.LSL: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const mask = decoded.sf === 0 ? 0x1fn : 0x3fn;
        const shift = Number(this.cpu.getReg(decoded.rm) & mask);
        const res = BigInt.asUintN(bits, BigInt.asUintN(bits, this.cpu.getReg(decoded.rn)) << BigInt(shift));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LSR: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const mask = decoded.sf === 0 ? 0x1fn : 0x3fn;
        const shift = Number(this.cpu.getReg(decoded.rm) & mask);
        const res = BigInt.asUintN(bits, BigInt.asUintN(bits, this.cpu.getReg(decoded.rn)) >> BigInt(shift));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ASR: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const mask = decoded.sf === 0 ? 0x1fn : 0x3fn;
        const shift = Number(this.cpu.getReg(decoded.rm) & mask);
        const s_val = BigInt.asIntN(bits, this.cpu.getReg(decoded.rn));
        const res = BigInt.asUintN(bits, s_val >> BigInt(shift));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.UBFM:
      case InstructionType.SBFM: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const src = this.cpu.getReg(decoded.rn);
        const res = decoded.type === InstructionType.SBFM
          ? this.applySBFM(src, decoded.immr, decoded.imms, bits)
          : this.applyUBFM(src, decoded.immr, decoded.imms, bits);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      // --- Single Load/Store ---
      case InstructionType.STR_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.memory.write64(targetAddr, this.cpu.getReg(decoded.rt));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDR_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.cpu.setReg(decoded.rt, this.memory.read64(targetAddr));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STRW_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.memory.write32(targetAddr, Number(this.cpu.getReg(decoded.rt) & 0xffffffffn));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRW_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.cpu.setReg(decoded.rt, BigInt(this.memory.read32(targetAddr)));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRSW_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        const raw32 = BigInt(this.memory.read32(targetAddr));
        const signExt64 = BigInt.asUintN(64, BigInt.asIntN(32, raw32));
        this.cpu.setReg(decoded.rt, signExt64);
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STRH_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.memory.write16(targetAddr, Number(this.cpu.getReg(decoded.rt) & 0xffffn));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRH_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.cpu.setReg(decoded.rt, BigInt(this.memory.read16(targetAddr)));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRSH_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        const bits = decoded.sf === 0 ? 32 : 64;
        const raw16 = BigInt(this.memory.read16(targetAddr));
        const signExt = BigInt.asUintN(bits, BigInt.asIntN(16, raw16));
        this.cpu.setReg(decoded.rt, signExt);
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STRB_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.memory.write8(targetAddr, Number(this.cpu.getReg(decoded.rt) & 0xffn));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRB_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        this.cpu.setReg(decoded.rt, BigInt(this.memory.read8(targetAddr)));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRSB_IMM: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        const bits = decoded.sf === 0 ? 32 : 64;
        const raw8 = BigInt(this.memory.read8(targetAddr));
        const signExt = BigInt.asUintN(bits, BigInt.asIntN(8, raw8));
        this.cpu.setReg(decoded.rt, signExt);
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      // --- Pair Load/Store (Stack Frames) ---
      case InstructionType.STP: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        if (decoded.sf === 0) {
          this.memory.write32(targetAddr, Number(this.cpu.getReg(decoded.rt1) & 0xffffffffn));
          this.memory.write32(targetAddr + 4, Number(this.cpu.getReg(decoded.rt2) & 0xffffffffn));
        } else {
          this.memory.write64(targetAddr, this.cpu.getReg(decoded.rt1));
          this.memory.write64(targetAddr + 8, this.cpu.getReg(decoded.rt2));
        }
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDP: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        if (decoded.sf === 0) {
          this.cpu.setReg(decoded.rt1, BigInt(this.memory.read32(targetAddr)));
          this.cpu.setReg(decoded.rt2, BigInt(this.memory.read32(targetAddr + 4)));
        } else {
          this.cpu.setReg(decoded.rt1, this.memory.read64(targetAddr));
          this.cpu.setReg(decoded.rt2, this.memory.read64(targetAddr + 8));
        }
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      // --- Branches & Subroutine Calls ---
      case InstructionType.B_COND: {
        if (this.evalCondition(decoded.cond)) {
          this.cpu.pc = BigInt(currentPC + decoded.offsetBytes);
        } else {
          this.cpu.pc += 4n;
        }
        break;
      }

      case InstructionType.CBZ:
      case InstructionType.CBNZ: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const val = BigInt.asUintN(bits, this.cpu.getReg(decoded.rt));
        const shouldBranch = decoded.type === InstructionType.CBZ ? (val === 0n) : (val !== 0n);
        if (shouldBranch) {
          this.cpu.pc = BigInt(currentPC + decoded.offsetBytes);
        } else {
          this.cpu.pc += 4n;
        }
        break;
      }

      case InstructionType.TBZ:
      case InstructionType.TBNZ: {
        const bitVal = (this.cpu.getReg(decoded.rt) >> BigInt(decoded.bitPos)) & 1n;
        const shouldBranch = decoded.type === InstructionType.TBZ ? (bitVal === 0n) : (bitVal !== 0n);
        if (shouldBranch) {
          this.cpu.pc = BigInt(currentPC + decoded.offsetBytes);
        } else {
          this.cpu.pc += 4n;
        }
        break;
      }

      case InstructionType.B: {
        this.cpu.pc = BigInt(currentPC + decoded.offsetBytes);
        break;
      }

      case InstructionType.BL: {
        // Save return address into Link Register (X30)
        this.cpu.setReg(30, BigInt(currentPC + 4));
        this.cpu.pc = BigInt(currentPC + decoded.offsetBytes);
        break;
      }

      case InstructionType.BR: {
        this.cpu.pc = this.cpu.getReg(decoded.rn);
        break;
      }

      case InstructionType.BLR: {
        this.cpu.setReg(30, BigInt(currentPC + 4));
        this.cpu.pc = this.cpu.getReg(decoded.rn);
        break;
      }

      case InstructionType.RET: {
        this.cpu.pc = this.cpu.getReg(decoded.rn);
        break;
      }

      // --- System Register Access (TPIDR_EL0 Thread Pointer / TLS) ---
      case InstructionType.MSR: {
        const val = this.cpu.getReg(decoded.rt);
        if (decoded.sysreg === 0xde82) {
          this.cpu.tpidr_el0 = val;
        } else {
          this.cpu.sysRegs.set(decoded.sysreg, val);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MRS: {
        const val = decoded.sysreg === 0xde82
          ? this.cpu.tpidr_el0
          : (this.cpu.sysRegs.get(decoded.sysreg) ?? 0n);
        this.cpu.setReg(decoded.rt, val);
        this.cpu.pc += 4n;
        break;
      }

      // --- System Hints & Memory Barriers ---
      case InstructionType.NOP:
      case InstructionType.DMB:
      case InstructionType.DSB:
      case InstructionType.ISB: {
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.YIELD: {
        isYield = true;
        this.cpu.pc += 4n;
        break;
      }

      // --- Bit Manipulation & Byte Swap ---
      case InstructionType.CLZ: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const val = this.cpu.getReg(decoded.rn);
        let zeros = 0;
        if (decoded.sf === 0) {
          zeros = Math.clz32(Number(val & 0xffffffffn));
        } else {
          const hi = Number((val >> 32n) & 0xffffffffn);
          const lo = Number(val & 0xffffffffn);
          zeros = hi !== 0 ? Math.clz32(hi) : (32 + Math.clz32(lo));
        }
        this.cpu.setReg(decoded.rd, BigInt(zeros));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.REV: {
        const val = this.cpu.getReg(decoded.rn);
        if (decoded.sf === 0) {
          const v = Number(val & 0xffffffffn);
          const r = ((v & 0xff) << 24) | (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | ((v >>> 24) & 0xff);
          this.cpu.setReg(decoded.rd, BigInt(r >>> 0));
        } else {
          let r = 0n;
          for (let b = 0n; b < 8n; b++) {
            r = (r << 8n) | ((val >> (b * 8n)) & 0xffn);
          }
          this.cpu.setReg(decoded.rd, r);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.REV16: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const val = this.cpu.getReg(decoded.rn);
        let r = 0n;
        const halfwords = bits / 16;
        for (let h = 0; h < halfwords; h++) {
          const shift = BigInt(h * 16);
          const hw = Number((val >> shift) & 0xffffn);
          const swapped = ((hw & 0xff) << 8) | ((hw >> 8) & 0xff);
          r |= (BigInt(swapped) << shift);
        }
        this.cpu.setReg(decoded.rd, r);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.REV32: {
        const val = this.cpu.getReg(decoded.rn);
        const lo = Number(val & 0xffffffffn);
        const hi = Number((val >> 32n) & 0xffffffffn);
        const swap32 = v => ((v & 0xff) << 24) | (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | ((v >>> 24) & 0xff);
        const r = (BigInt(swap32(hi) >>> 0) << 32n) | BigInt(swap32(lo) >>> 0);
        this.cpu.setReg(decoded.rd, r);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.RBIT: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const val = this.cpu.getReg(decoded.rn);
        let r = 0n;
        for (let b = 0; b < bits; b++) {
          if ((val & (1n << BigInt(b))) !== 0n) {
            r |= (1n << BigInt(bits - 1 - b));
          }
        }
        this.cpu.setReg(decoded.rd, r);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.EXTR: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const rnVal = BigInt.asUintN(bits, this.cpu.getReg(decoded.rn));
        const rmVal = BigInt.asUintN(bits, this.cpu.getReg(decoded.rm));
        let res;
        if (decoded.isRegShift) { // RORV
          const amt = BigInt(Number(rmVal) & (bits - 1));
          res = (rnVal >> amt) | BigInt.asUintN(bits, rnVal << (BigInt(bits) - amt));
        } else {
          const lsb = BigInt(decoded.lsb & (bits - 1));
          const combined = (rnVal << BigInt(bits)) | rmVal;
          res = BigInt.asUintN(bits, combined >> lsb);
        }
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      // --- Exclusive Load / Store Atomics (Single-threaded User-space) ---
      case InstructionType.LDXR: {
        const addr = Number(this.cpu.getSPOrReg(decoded.rn));
        let val;
        if (decoded.bytes === 1) val = BigInt(this.memory.read8(addr));
        else if (decoded.bytes === 2) val = BigInt(this.memory.read16(addr));
        else if (decoded.bytes === 4) val = BigInt(this.memory.read32(addr));
        else if (decoded.bytes === 8) val = this.memory.read64(addr);
        this.cpu.setReg(decoded.rt, val);

        if (decoded.pair) {
          const addr2 = addr + decoded.bytes;
          let val2;
          if (decoded.bytes === 4) val2 = BigInt(this.memory.read32(addr2));
          else if (decoded.bytes === 8) val2 = this.memory.read64(addr2);
          this.cpu.setReg(decoded.rt2, val2);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STXR: {
        const addr = Number(this.cpu.getSPOrReg(decoded.rn));
        const val = this.cpu.getReg(decoded.rt);
        if (decoded.bytes === 1) this.memory.write8(addr, Number(val & 0xffn));
        else if (decoded.bytes === 2) this.memory.write16(addr, Number(val & 0xffffn));
        else if (decoded.bytes === 4) this.memory.write32(addr, Number(val & 0xffffffffn));
        else if (decoded.bytes === 8) this.memory.write64(addr, val);

        if (decoded.pair) {
          const addr2 = addr + decoded.bytes;
          const val2 = this.cpu.getReg(decoded.rt2);
          if (decoded.bytes === 4) this.memory.write32(addr2, Number(val2 & 0xffffffffn));
          else if (decoded.bytes === 8) this.memory.write64(addr2, val2);
        }
        if (decoded.exclusive) {
          this.cpu.setReg(decoded.rs, 0n); // 0 = exclusive store succeeded
        }
        this.cpu.pc += 4n;
        break;
      }

      // --- Syscalls ---
      case InstructionType.SVC: {
        const sysRes = this.handleSyscall(decoded.imm16);
        isYield = sysRes.yielded;
        this.cpu.pc += 4n;
        break;
      }

      // --- Floating-Point Scalar Arithmetic ---
      case InstructionType.FADD:
      case InstructionType.FSUB:
      case InstructionType.FMUL:
      case InstructionType.FDIV:
      case InstructionType.FNMUL:
      case InstructionType.FMAX:
      case InstructionType.FMIN: {
        const isD = decoded.isDouble;
        const v1 = isD ? this.cpu.getFRegDouble(decoded.rn) : this.cpu.getFRegSingle(decoded.rn);
        const v2 = isD ? this.cpu.getFRegDouble(decoded.rm) : this.cpu.getFRegSingle(decoded.rm);
        let res = 0;
        switch (decoded.type) {
          case InstructionType.FADD: res = v1 + v2; break;
          case InstructionType.FSUB: res = v1 - v2; break;
          case InstructionType.FMUL: res = v1 * v2; break;
          case InstructionType.FDIV: res = v1 / v2; break;
          case InstructionType.FNMUL: res = -(v1 * v2); break;
          case InstructionType.FMAX: res = Math.max(v1, v2); break;
          case InstructionType.FMIN: res = Math.min(v1, v2); break;
        }
        if (isD) this.cpu.setFRegDouble(decoded.rd, res);
        else this.cpu.setFRegSingle(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FNEG:
      case InstructionType.FABS:
      case InstructionType.FSQRT: {
        const isD = decoded.isDouble;
        const v = isD ? this.cpu.getFRegDouble(decoded.rn) : this.cpu.getFRegSingle(decoded.rn);
        let res = 0;
        if (decoded.type === InstructionType.FNEG) res = -v;
        else if (decoded.type === InstructionType.FABS) res = Math.abs(v);
        else if (decoded.type === InstructionType.FSQRT) res = Math.sqrt(v);
        if (isD) this.cpu.setFRegDouble(decoded.rd, res);
        else this.cpu.setFRegSingle(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FCMP: {
        const isD = decoded.isDouble;
        const v1 = isD ? this.cpu.getFRegDouble(decoded.rn) : this.cpu.getFRegSingle(decoded.rn);
        const v2 = decoded.isZero ? 0.0 : (isD ? this.cpu.getFRegDouble(decoded.rm) : this.cpu.getFRegSingle(decoded.rm));

        if (Number.isNaN(v1) || Number.isNaN(v2)) {
          this.cpu.flags.N = false;
          this.cpu.flags.Z = false;
          this.cpu.flags.C = false;
          this.cpu.flags.V = true; // Unordered
        } else if (v1 === v2) {
          this.cpu.flags.N = false;
          this.cpu.flags.Z = true;
          this.cpu.flags.C = true;
          this.cpu.flags.V = false;
        } else if (v1 < v2) {
          this.cpu.flags.N = true;
          this.cpu.flags.Z = false;
          this.cpu.flags.C = false;
          this.cpu.flags.V = false;
        } else {
          this.cpu.flags.N = false;
          this.cpu.flags.Z = false;
          this.cpu.flags.C = true;
          this.cpu.flags.V = false;
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FCVT: {
        // Precision conversion
        if (decoded.dstDouble) {
          // Single to double
          const s = this.cpu.getFRegSingle(decoded.rn);
          this.cpu.setFRegDouble(decoded.rd, s);
        } else {
          // Double to single
          const d = this.cpu.getFRegDouble(decoded.rn);
          this.cpu.setFRegSingle(decoded.rd, d);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SCVTF: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const rawInt = this.cpu.getReg(decoded.rn);
        const sInt = Number(BigInt.asIntN(bits, rawInt));
        if (decoded.isDouble) this.cpu.setFRegDouble(decoded.rd, sInt);
        else this.cpu.setFRegSingle(decoded.rd, sInt);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.UCVTF: {
        const bits = decoded.sf === 0 ? 32 : 64;
        const rawInt = this.cpu.getReg(decoded.rn);
        const uInt = Number(BigInt.asUintN(bits, rawInt));
        if (decoded.isDouble) this.cpu.setFRegDouble(decoded.rd, uInt);
        else this.cpu.setFRegSingle(decoded.rd, uInt);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FCVTZS: {
        const isD = decoded.isDouble;
        const v = isD ? this.cpu.getFRegDouble(decoded.rn) : this.cpu.getFRegSingle(decoded.rn);
        const bits = decoded.sf === 0 ? 32 : 64;
        let res = 0n;
        if (!Number.isNaN(v)) {
          const maxInt = (1n << BigInt(bits - 1)) - 1n;
          const minInt = -(1n << BigInt(bits - 1));
          if (!Number.isFinite(v)) {
            res = v > 0 ? maxInt : minInt;
          } else {
            const bigV = BigInt(Math.trunc(v));
            res = bigV > maxInt ? maxInt : (bigV < minInt ? minInt : bigV);
          }
        }
        this.cpu.setReg(decoded.rd, BigInt.asUintN(bits, res));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FCVTZU: {
        const isD = decoded.isDouble;
        const v = isD ? this.cpu.getFRegDouble(decoded.rn) : this.cpu.getFRegSingle(decoded.rn);
        const bits = decoded.sf === 0 ? 32 : 64;
        let res = 0n;
        if (!Number.isNaN(v) && v > 0) {
          const maxUint = (1n << BigInt(bits)) - 1n;
          if (!Number.isFinite(v)) {
            res = maxUint;
          } else {
            const bigV = BigInt(Math.trunc(v));
            res = bigV > maxUint ? maxUint : bigV;
          }
        }
        this.cpu.setReg(decoded.rd, BigInt.asUintN(bits, res));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FMOV: {
        if (decoded.isImm) {
          if (decoded.isDouble) this.cpu.setFRegDouble(decoded.rd, decoded.immValue);
          else this.cpu.setFRegSingle(decoded.rd, decoded.immValue);
        } else if (decoded.isFprToGpr) {
          if (decoded.sf === 1) {
            this.cpu.setReg(decoded.rd, this.cpu.getFRegBits64(decoded.rn));
          } else {
            this.cpu.setReg(decoded.rd, BigInt(this.cpu.getFRegBits32(decoded.rn)));
          }
        } else if (decoded.isGprToFpr) {
          if (decoded.sf === 1) {
            this.cpu.setFRegBits64(decoded.rd, this.cpu.getReg(decoded.rn));
          } else {
            this.cpu.setFRegBits32(decoded.rd, Number(this.cpu.getReg(decoded.rn) & 0xffffffffn));
          }
        } else {
          // Register to register
          if (decoded.isDouble) this.cpu.setFRegDouble(decoded.rd, this.cpu.getFRegDouble(decoded.rn));
          else this.cpu.setFRegSingle(decoded.rd, this.cpu.getFRegSingle(decoded.rn));
        }
        this.cpu.pc += 4n;
        break;
      }

      // --- Floating-Point & Vector Loads / Stores ---
      case InstructionType.LDR_FREG: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        if (decoded.isDouble) {
          this.cpu.setFRegBits64(decoded.rt, this.memory.read64(targetAddr));
        } else {
          this.cpu.setFRegBits32(decoded.rt, this.memory.read32(targetAddr));
        }
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STR_FREG: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        if (decoded.isDouble) {
          this.memory.write64(targetAddr, this.cpu.getFRegBits64(decoded.rt));
        } else {
          this.memory.write32(targetAddr, this.cpu.getFRegBits32(decoded.rt));
        }
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDR_VREG: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        const qBytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) qBytes[i] = this.memory.read8(targetAddr + i);
        this.cpu.setVRegBytes(decoded.rt, qBytes);
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STR_VREG: {
        const { baseAddr, targetAddr } = this.computeLoadStoreAddr(decoded);
        const bytes = this.cpu.getVRegBytes(decoded.rt);
        for (let i = 0; i < 16; i++) this.memory.write8(targetAddr + i, bytes[i]);
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDP_FREG: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        const scale = decoded.isDouble ? 8 : 4;
        if (decoded.isDouble) {
          this.cpu.setFRegBits64(decoded.rt1, this.memory.read64(targetAddr));
          this.cpu.setFRegBits64(decoded.rt2, this.memory.read64(targetAddr + scale));
        } else {
          this.cpu.setFRegBits32(decoded.rt1, this.memory.read32(targetAddr));
          this.cpu.setFRegBits32(decoded.rt2, this.memory.read32(targetAddr + scale));
        }
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STP_FREG: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        const scale = decoded.isDouble ? 8 : 4;
        if (decoded.isDouble) {
          this.memory.write64(targetAddr, this.cpu.getFRegBits64(decoded.rt1));
          this.memory.write64(targetAddr + scale, this.cpu.getFRegBits64(decoded.rt2));
        } else {
          this.memory.write32(targetAddr, this.cpu.getFRegBits32(decoded.rt1));
          this.memory.write32(targetAddr + scale, this.cpu.getFRegBits32(decoded.rt2));
        }
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDP_VREG: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        const q1 = new Uint8Array(16);
        const q2 = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
          q1[i] = this.memory.read8(targetAddr + i);
          q2[i] = this.memory.read8(targetAddr + 16 + i);
        }
        this.cpu.setVRegBytes(decoded.rt1, q1);
        this.cpu.setVRegBytes(decoded.rt2, q2);
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STP_VREG: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        const q1 = this.cpu.getVRegBytes(decoded.rt1);
        const q2 = this.cpu.getVRegBytes(decoded.rt2);
        for (let i = 0; i < 16; i++) {
          this.memory.write8(targetAddr + i, q1[i]);
          this.memory.write8(targetAddr + 16 + i, q2[i]);
        }
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      // --- NEON / Advanced SIMD Operations ---
      case InstructionType.FADD_VEC:
      case InstructionType.FSUB_VEC:
      case InstructionType.FMUL_VEC:
      case InstructionType.FDIV_VEC:
      case InstructionType.FMAX_VEC:
      case InstructionType.FMIN_VEC: {
        const lanes = decoded.lanes;
        if (decoded.isDouble) {
          const v1 = this.cpu.getVRegFloat64(decoded.rn, lanes);
          const v2 = this.cpu.getVRegFloat64(decoded.rm, lanes);
          const out = new Float64Array(lanes);
          for (let i = 0; i < lanes; i++) {
            switch (decoded.type) {
              case InstructionType.FADD_VEC: out[i] = v1[i] + v2[i]; break;
              case InstructionType.FSUB_VEC: out[i] = v1[i] - v2[i]; break;
              case InstructionType.FMUL_VEC: out[i] = v1[i] * v2[i]; break;
              case InstructionType.FDIV_VEC: out[i] = v1[i] / v2[i]; break;
              case InstructionType.FMAX_VEC: out[i] = Math.max(v1[i], v2[i]); break;
              case InstructionType.FMIN_VEC: out[i] = Math.min(v1[i], v2[i]); break;
            }
          }
          this.cpu.setVRegFloat64(decoded.rd, out, lanes);
        } else {
          const v1 = this.cpu.getVRegFloat32(decoded.rn, lanes);
          const v2 = this.cpu.getVRegFloat32(decoded.rm, lanes);
          const out = new Float32Array(lanes);
          for (let i = 0; i < lanes; i++) {
            switch (decoded.type) {
              case InstructionType.FADD_VEC: out[i] = v1[i] + v2[i]; break;
              case InstructionType.FSUB_VEC: out[i] = v1[i] - v2[i]; break;
              case InstructionType.FMUL_VEC: out[i] = v1[i] * v2[i]; break;
              case InstructionType.FDIV_VEC: out[i] = v1[i] / v2[i]; break;
              case InstructionType.FMAX_VEC: out[i] = Math.max(v1[i], v2[i]); break;
              case InstructionType.FMIN_VEC: out[i] = Math.min(v1[i], v2[i]); break;
            }
          }
          this.cpu.setVRegFloat32(decoded.rd, out, lanes);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FADDP_VEC: {
        const lanes = decoded.lanes;
        if (decoded.isDouble) {
          const v1 = this.cpu.getVRegFloat64(decoded.rn, lanes);
          const v2 = this.cpu.getVRegFloat64(decoded.rm, lanes);
          const out = new Float64Array(lanes);
          if (lanes === 2) {
            out[0] = v1[0] + v1[1];
            out[1] = v2[0] + v2[1];
          } else {
            out[0] = v1[0] + v2[0];
          }
          this.cpu.setVRegFloat64(decoded.rd, out, lanes);
        } else {
          const v1 = this.cpu.getVRegFloat32(decoded.rn, lanes);
          const v2 = this.cpu.getVRegFloat32(decoded.rm, lanes);
          const out = new Float32Array(lanes);
          if (lanes === 4) {
            out[0] = v1[0] + v1[1];
            out[1] = v1[2] + v1[3];
            out[2] = v2[0] + v2[1];
            out[3] = v2[2] + v2[3];
          } else {
            out[0] = v1[0] + v1[1];
            out[1] = v2[0] + v2[1];
          }
          this.cpu.setVRegFloat32(decoded.rd, out, lanes);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.FNEG_VEC:
      case InstructionType.FABS_VEC: {
        const lanes = decoded.lanes;
        if (decoded.isDouble) {
          const v = this.cpu.getVRegFloat64(decoded.rn, lanes);
          const out = new Float64Array(lanes);
          for (let i = 0; i < lanes; i++) {
            out[i] = (decoded.type === InstructionType.FNEG_VEC) ? -v[i] : Math.abs(v[i]);
          }
          this.cpu.setVRegFloat64(decoded.rd, out, lanes);
        } else {
          const v = this.cpu.getVRegFloat32(decoded.rn, lanes);
          const out = new Float32Array(lanes);
          for (let i = 0; i < lanes; i++) {
            out[i] = (decoded.type === InstructionType.FNEG_VEC) ? -v[i] : Math.abs(v[i]);
          }
          this.cpu.setVRegFloat32(decoded.rd, out, lanes);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ADD_VEC:
      case InstructionType.SUB_VEC:
      case InstructionType.MUL_VEC: {
        const lanes = decoded.lanes;
        if (decoded.size === 3) { // 64-bit int (1D / 2D)
          const v1 = this.cpu.getVRegUint64(decoded.rn, lanes);
          const v2 = this.cpu.getVRegUint64(decoded.rm, lanes);
          const out = new BigUint64Array(lanes);
          for (let i = 0; i < lanes; i++) {
            if (decoded.type === InstructionType.ADD_VEC) out[i] = BigInt.asUintN(64, v1[i] + v2[i]);
            else if (decoded.type === InstructionType.SUB_VEC) out[i] = BigInt.asUintN(64, v1[i] - v2[i]);
            else out[i] = BigInt.asUintN(64, v1[i] * v2[i]);
          }
          this.cpu.setVRegUint64(decoded.rd, out, lanes);
        } else if (decoded.size === 2) { // 32-bit int (2S / 4S)
          const v1 = this.cpu.getVRegInt32(decoded.rn, lanes);
          const v2 = this.cpu.getVRegInt32(decoded.rm, lanes);
          const out = new Int32Array(lanes);
          for (let i = 0; i < lanes; i++) {
            if (decoded.type === InstructionType.ADD_VEC) out[i] = v1[i] + v2[i];
            else if (decoded.type === InstructionType.SUB_VEC) out[i] = v1[i] - v2[i];
            else out[i] = Math.imul(v1[i], v2[i]);
          }
          this.cpu.setVRegInt32(decoded.rd, out, lanes);
        } else if (decoded.size === 1) { // 16-bit int (4H / 8H)
          const v1 = this.cpu.getVRegInt16(decoded.rn, lanes);
          const v2 = this.cpu.getVRegInt16(decoded.rm, lanes);
          const out = new Int16Array(lanes);
          for (let i = 0; i < lanes; i++) {
            if (decoded.type === InstructionType.ADD_VEC) out[i] = (v1[i] + v2[i]) & 0xffff;
            else if (decoded.type === InstructionType.SUB_VEC) out[i] = (v1[i] - v2[i]) & 0xffff;
            else out[i] = (v1[i] * v2[i]) & 0xffff;
          }
          this.cpu.setVRegInt16(decoded.rd, out, lanes);
        } else {
          // 8-bit byte (8B / 16B)
          const b1 = this.cpu.getVRegBytes(decoded.rn);
          const b2 = this.cpu.getVRegBytes(decoded.rm);
          const maxL = decoded.Q ? 16 : 8;
          const out = new Uint8Array(maxL);
          for (let i = 0; i < maxL; i++) {
            if (decoded.type === InstructionType.ADD_VEC) out[i] = (b1[i] + b2[i]) & 0xff;
            else if (decoded.type === InstructionType.SUB_VEC) out[i] = (b1[i] - b2[i]) & 0xff;
            else out[i] = (b1[i] * b2[i]) & 0xff;
          }
          this.cpu.setVRegBytes(decoded.rd, out);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ADDP_VEC: {
        const lanes = decoded.lanes;
        if (decoded.size === 3) {
          const v1 = this.cpu.getVRegUint64(decoded.rn, lanes);
          const v2 = this.cpu.getVRegUint64(decoded.rm, lanes);
          const out = new BigUint64Array(lanes);
          if (lanes === 2) {
            out[0] = BigInt.asUintN(64, v1[0] + v1[1]);
            out[1] = BigInt.asUintN(64, v2[0] + v2[1]);
          } else {
            out[0] = BigInt.asUintN(64, v1[0] + v2[0]);
          }
          this.cpu.setVRegUint64(decoded.rd, out, lanes);
        } else if (decoded.size === 2) {
          const v1 = this.cpu.getVRegInt32(decoded.rn, lanes);
          const v2 = this.cpu.getVRegInt32(decoded.rm, lanes);
          const out = new Int32Array(lanes);
          if (lanes === 4) {
            out[0] = v1[0] + v1[1];
            out[1] = v1[2] + v1[3];
            out[2] = v2[0] + v2[1];
            out[3] = v2[2] + v2[3];
          } else {
            out[0] = v1[0] + v1[1];
            out[1] = v2[0] + v2[1];
          }
          this.cpu.setVRegInt32(decoded.rd, out, lanes);
        } else if (decoded.size === 1) {
          const v1 = this.cpu.getVRegInt16(decoded.rn, lanes);
          const v2 = this.cpu.getVRegInt16(decoded.rm, lanes);
          const out = new Int16Array(lanes);
          const half = lanes >> 1;
          for (let i = 0; i < half; i++) {
            out[i] = (v1[i * 2] + v1[i * 2 + 1]) & 0xffff;
            out[half + i] = (v2[i * 2] + v2[i * 2 + 1]) & 0xffff;
          }
          this.cpu.setVRegInt16(decoded.rd, out, lanes);
        } else {
          const b1 = this.cpu.getVRegBytes(decoded.rn);
          const b2 = this.cpu.getVRegBytes(decoded.rm);
          const maxL = decoded.Q ? 16 : 8;
          const out = new Uint8Array(maxL);
          const half = maxL >> 1;
          for (let i = 0; i < half; i++) {
            out[i] = (b1[i * 2] + b1[i * 2 + 1]) & 0xff;
            out[half + i] = (b2[i * 2] + b2[i * 2 + 1]) & 0xff;
          }
          this.cpu.setVRegBytes(decoded.rd, out);
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.AND_VEC:
      case InstructionType.ORR_VEC:
      case InstructionType.EOR_VEC:
      case InstructionType.NOT_VEC: {
        const b1 = this.cpu.getVRegBytes(decoded.rn);
        const b2 = decoded.rm !== undefined ? this.cpu.getVRegBytes(decoded.rm) : null;
        const maxL = decoded.Q ? 16 : 8;
        const out = new Uint8Array(maxL);
        for (let i = 0; i < maxL; i++) {
          if (decoded.type === InstructionType.AND_VEC) out[i] = b1[i] & b2[i];
          else if (decoded.type === InstructionType.ORR_VEC) out[i] = b1[i] | b2[i];
          else if (decoded.type === InstructionType.EOR_VEC) out[i] = b1[i] ^ b2[i];
          else if (decoded.type === InstructionType.NOT_VEC) out[i] = ~b1[i] & 0xff;
        }
        this.cpu.setVRegBytes(decoded.rd, out);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.DUP_ELEM: {
        const val = this.cpu.getVRegLane(decoded.rn, decoded.elemSize, decoded.lane);
        const maxLanes = decoded.Q ? (16 >> decoded.elemSize) : (8 >> decoded.elemSize);
        for (let l = 0; l < maxLanes; l++) {
          this.cpu.setVRegLane(decoded.rd, decoded.elemSize, l, val);
        }
        if (!decoded.Q) {
          // Zero upper 64 bits
          this.cpu.vUint64[decoded.rd * 2 + 1] = 0n;
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.DUP_GEN: {
        const gprVal = this.cpu.getReg(decoded.rn);
        const maxLanes = decoded.Q ? (16 >> decoded.elemSize) : (8 >> decoded.elemSize);
        for (let l = 0; l < maxLanes; l++) {
          this.cpu.setVRegLane(decoded.rd, decoded.elemSize, l, gprVal);
        }
        if (!decoded.Q) {
          this.cpu.vUint64[decoded.rd * 2 + 1] = 0n;
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.INS_GEN: {
        const gprVal = this.cpu.getReg(decoded.rn);
        this.cpu.setVRegLane(decoded.rd, decoded.elemSize, decoded.lane, gprVal);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.INS_ELEM: {
        const elemVal = this.cpu.getVRegLane(decoded.rn, decoded.elemSize, decoded.srcLane);
        this.cpu.setVRegLane(decoded.rd, decoded.elemSize, decoded.dstLane, elemVal);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.UMOV_ELEM: {
        const laneVal = this.cpu.getVRegLane(decoded.rn, decoded.elemSize, decoded.lane);
        this.cpu.setReg(decoded.rd, BigInt(laneVal));
        this.cpu.pc += 4n;
        break;
      }

      default:
        throw new Error(`Unrecognized instruction 0x${rawInstr.toString(16)} at PC ${hexPC}`);
    }

    this.cycleCount++;

    const changedRegs = [];
    for (let i = 0; i < 31; i++) {
      if (this.cpu.x[i] !== prevRegs[i]) {
        changedRegs.push({ index: i, name: `X${i}`, val: this.cpu.x[i], prev: prevRegs[i] });
      }
    }
    if (this.cpu.sp !== prevSP) {
      changedRegs.push({ index: 31, name: "SP", val: this.cpu.sp, prev: prevSP });
    }
    const changedFRegs = [];
    for (let i = 0; i < 32; i++) {
      if (this.cpu.vUint64[i * 2] !== prevV64[i * 2] || this.cpu.vUint64[i * 2 + 1] !== prevV64[i * 2 + 1]) {
        changedFRegs.push(i);
      }
    }

    const nextPC = Number(this.cpu.pc);
    const stepResult = {
      cycle: this.cycleCount,
      pc: currentPC,
      nextPC,
      rawInstr,
      hexPC,
      hexInstr,
      decoded,
      disassembly: decoded.disassembly,
      flags: { ...this.cpu.flags },
      changedRegs,
      changedFRegs,
      changedMem: Array.from(this.memory.lastWritten),
      halted: this.cpu.halted,
      yielded: isYield,
      exitCode: this.cpu.exitCode,
      hitBreakpoint: this.breakpoints.has(nextPC)
    };

    if (this.onStep) {
      this.onStep(stepResult);
    }

    if (verbose) {
      console.log(`[Cycle ${this.cycleCount.toString().padStart(3, " ")}] ${hexPC}: ${hexInstr} | ${decoded.disassembly.padEnd(25, " ")} | ${this.cpu.dumpState()}`);
    }

    return stepResult;
  }

  enableJit(enabled = true) {
    this.jitEnabled = Boolean(enabled);
    return this.jitEnabled;
  }

  getJitStats() {
    const stats = this.jit ? this.jit.stats : { compilations: 0, blockExecutions: 0, jitCycles: 0, invalidations: 0 };
    const totalCycles = this.cycleCount;
    const jitCycles = stats.jitCycles;
    const jitPct = totalCycles > 0 ? ((jitCycles / totalCycles) * 100).toFixed(1) : "0.0";
    return {
      enabled: this.jitEnabled,
      hotThreshold: this.jit ? this.jit.hotThreshold : 5,
      compiledBlocks: this.jit ? this.jit.blockCache.size : 0,
      blockExecutions: stats.blockExecutions,
      jitCycles,
      totalCycles,
      jitPercentage: Number(jitPct),
      invalidations: stats.invalidations
    };
  }

  getJitBlocks() {
    if (!this.jit) return [];
    return Array.from(this.jit.blockCache.values()).map(b => ({
      startPC: b.startPC,
      hexStartPC: `0x${b.startPC.toString(16).padStart(8, "0")}`,
      endPC: b.endPC,
      hexEndPC: `0x${b.endPC.toString(16).padStart(8, "0")}`,
      instrCount: b.instrCount,
      execCount: b.execCount,
      disassembly: b.disassembly,
      source: b.source
    }));
  }

  runJit(maxCycles = 10000, stopOnYield = false) {
    while (!this.cpu.halted && this.cycleCount < maxCycles) {
      const curPC = Number(this.cpu.pc);
      if (this.breakpoints.has(curPC)) {
        break;
      }

      let block = this.jit.getBlock(curPC);
      if (!block) {
        if (this.jit.recordEntry(curPC)) {
          block = this.jit.compileBlock(curPC, this.memory, this.breakpoints);
        }
      }

      if (block) {
        this.lastYielded = false;
        const executed = block.fn(this.cpu, this.memory, this);
        if (executed === 0) {
          const res = this.step(false);
          if (res.hitBreakpoint || res.halted || (stopOnYield && res.yielded)) break;
          continue;
        }
        this.cycleCount += executed;
        this.jit.stats.blockExecutions++;
        this.jit.stats.jitCycles += executed;
        block.execCount++;
        if (this.cpu.halted || (stopOnYield && this.lastYielded)) break;
        const nextPC = Number(this.cpu.pc);
        if (this.breakpoints.has(nextPC)) break;
      } else {
        const res = this.step(false);
        if (res.hitBreakpoint || res.halted || (stopOnYield && res.yielded)) break;
      }
    }
    return this.cpu.exitCode;
  }

  run(maxCycles = 10000, verbose = true) {
    if (!verbose && !this.onStep && this.jitEnabled) {
      return this.runJit(maxCycles);
    }

    if (verbose) {
      console.log("==========================================================================================");
      console.log("                      Starting Mini-QEMU (ARM64 User-Space Mode)                          ");
      console.log("==========================================================================================");
    }

    while (!this.cpu.halted && this.cycleCount < maxCycles) {
      const res = this.step(verbose);
      if (res.hitBreakpoint) {
        if (verbose) {
          console.log(`[Mini-QEMU] Hit breakpoint at 0x${res.nextPC.toString(16).padStart(8, "0")}`);
        }
        break;
      }
    }

    if (verbose) {
      console.log("==========================================================================================");
      if (this.cpu.halted) {
        console.log(`Program terminated cleanly via Linux sys_exit (syscall 93).`);
        console.log(`>>> Exit Code (Result in X0): ${this.cpu.exitCode} <<<`);
      } else {
        console.log(`Execution reached cycle limit or breakpoint (${maxCycles}) without halting.`);
      }
      console.log(`Total Cycles Executed: ${this.cycleCount}`);
      console.log("==========================================================================================");
    }
    return this.cpu.exitCode;
  }

  // Inspect and parse dynamic heap chunk headers between heapStart and brk
  getHeapChunks() {
    const chunks = [];
    const heapStart = Number(this.heapStart);
    const brk = Number(this.brk);
    if (brk <= heapStart) return chunks;

    let addr = heapStart;
    const safetyLimit = 2000;
    let iterations = 0;

    while (addr < brk && iterations++ < safetyLimit) {
      const header = this.memory.read64(addr);
      if (header === 0n) {
        // Zero header: unallocated or unformatted remainder of the heap page
        const remSize = brk - addr;
        chunks.push({
          addr,
          size: remSize,
          isAllocated: false,
          payloadAddr: addr,
          payloadSize: remSize,
          isRemainder: true
        });
        break;
      }

      const isAllocated = (header & 1n) !== 0n;
      const chunkSize = Number(header & ~1n);

      // A valid boundary-tag chunk must be >= 16 bytes, 8-byte aligned, and fit within [addr, brk]
      if (chunkSize < 16 || (chunkSize & 7) !== 0 || (addr + chunkSize) > brk) {
        // Non-standard or raw bump-allocated heap memory (e.g. heap_demo.elf)
        const remSize = brk - addr;
        chunks.push({
          addr,
          size: remSize,
          isAllocated: true,
          payloadAddr: addr,
          payloadSize: remSize,
          isRaw: true
        });
        break;
      }

      chunks.push({
        addr,
        size: chunkSize,
        isAllocated,
        payloadAddr: addr + 8,
        payloadSize: Math.max(0, chunkSize - 8),
        isRemainder: false
      });

      addr += chunkSize;
    }

    return chunks;
  }

  // Aggregate dynamic memory statistics (heap, mmap regions, page allocation)
  getHeapStats() {
    const heapStart = Number(this.heapStart);
    const brk = Number(this.brk);
    const heapSize = Math.max(0, brk - heapStart);
    const chunks = this.getHeapChunks();

    let allocatedBytes = 0;
    let freeBytes = 0;
    let allocatedCount = 0;
    let freeCount = 0;

    for (const c of chunks) {
      if (c.isAllocated) {
        allocatedBytes += c.payloadSize;
        allocatedCount++;
      } else {
        freeBytes += c.size;
        freeCount++;
      }
    }

    return {
      heapStart,
      brk,
      heapSize,
      mmapCurrent: Number(this.mmapCurrent),
      mmapRegions: Array.from(this.mmapRegions.values()),
      pageCount: this.memory.getPageCount(),
      mappedBytes: this.memory.getMappedBytes(),
      chunks,
      allocatedBytes,
      freeBytes,
      allocatedCount,
      freeCount
    };
  }
}

// If executed directly in Node.js CLI, run target ELF file
if (typeof process !== "undefined" && process.argv && process.argv[1]?.endsWith("emulator.js")) {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet") || args.includes("-q");
  const targetFile = args.find(a => !a.startsWith("-")) || "bin/fib.elf";
  const emulator = new MiniQEMU();
  emulator.loadElf(targetFile);
  const exitCode = emulator.run(10000, !quiet);
  if (quiet) {
    console.log(`[Mini-QEMU] Completed "${targetFile}" in ${emulator.cycleCount} cycles -> Exit Code (X0): ${exitCode}`);
  }
}
