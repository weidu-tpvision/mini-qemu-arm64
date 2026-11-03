// cpu.js - Virtual AArch64 (ARM64) CPU State

export class CPU {
  constructor(memory) {
    this.memory = memory;

    // 31 General-Purpose 64-bit registers: X0 to X30
    this.x = new BigUint64Array(31);

    // 32 Floating-Point & NEON SIMD 128-bit Vector Registers: V0 to V31 (Q0 to Q31)
    // Backed by a 512-byte ArrayBuffer with aliased views for byte, half, single, double, and quad precision
    this.vBuffer = new ArrayBuffer(32 * 16);
    this.vBytes = new Uint8Array(this.vBuffer);
    this.vUint16 = new Uint16Array(this.vBuffer);
    this.vInt16 = new Int16Array(this.vBuffer);
    this.vUint32 = new Uint32Array(this.vBuffer);
    this.vInt32 = new Int32Array(this.vBuffer);
    this.vUint64 = new BigUint64Array(this.vBuffer);
    this.vFloat32 = new Float32Array(this.vBuffer);
    this.vFloat64 = new Float64Array(this.vBuffer);

    // Floating-Point Control & Status Registers (FPCR / FPSR)
    this.fpcr = 0;
    this.fpsr = 0;

    // Stack Pointer (SP) - defaults to 7MB virtual stack address
    this.sp = 0x00700000n;

    // Program Counter (PC)
    this.pc = 0n;

    // Thread Pointer System Register (TPIDR_EL0) used by musl/glibc for TLS & errno
    this.tpidr_el0 = 0n;
    this.sysRegs = new Map();

    // Condition Flags (PSTATE / NZCV)
    this.flags = {
      N: false, // Negative
      Z: false, // Zero
      C: false, // Carry
      V: false, // Overflow
    };

    // Execution control
    this.halted = false;
    this.exitCode = 0;
  }

  // Read register (31 is XZR: Zero Register, always returns 0)
  getReg(index) {
    if (index === 31) return 0n;
    if (index < 0 || index > 30) throw new Error(`Invalid register index: ${index}`);
    return this.x[index];
  }

  // Write register (31 is XZR: writes are discarded)
  setReg(index, value) {
    if (index === 31) return; // Discard writes to XZR
    if (index < 0 || index > 30) throw new Error(`Invalid register index: ${index}`);
    this.x[index] = BigInt.asUintN(64, BigInt(value));
  }

  // In load/store and stack instructions, register 31 refers to SP instead of XZR
  getSPOrReg(index) {
    return (index === 31) ? this.sp : this.getReg(index);
  }

  setSPOrReg(index, value) {
    if (index === 31) {
      this.sp = BigInt.asUintN(64, BigInt(value));
    } else {
      this.setReg(index, value);
    }
  }

  // --- Floating-Point Scalar Accessors ---
  // In ARM64, writing to an Sn register clears bits [127:32] of Vn.
  // Writing to a Dn register clears bits [127:64] of Vn.

  getFRegSingle(index) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    return this.vFloat32[index * 4];
  }

  setFRegSingle(index, value) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    const u32Idx = index * 4;
    this.vFloat32[u32Idx] = Number(value);
    // Clear upper 96 bits of Vn (words 1, 2, 3)
    this.vUint32[u32Idx + 1] = 0;
    this.vUint32[u32Idx + 2] = 0;
    this.vUint32[u32Idx + 3] = 0;
  }

  getFRegDouble(index) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    return this.vFloat64[index * 2];
  }

  setFRegDouble(index, value) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    const u64Idx = index * 2;
    this.vFloat64[u64Idx] = Number(value);
    // Clear upper 64 bits of Vn
    this.vUint64[u64Idx + 1] = 0n;
  }

  getFRegBits32(index) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    return this.vUint32[index * 4];
  }

  setFRegBits32(index, uint32) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    const u32Idx = index * 4;
    this.vUint32[u32Idx] = uint32 >>> 0;
    this.vUint32[u32Idx + 1] = 0;
    this.vUint32[u32Idx + 2] = 0;
    this.vUint32[u32Idx + 3] = 0;
  }

  getFRegBits64(index) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    return this.vUint64[index * 2];
  }

  setFRegBits64(index, uint64) {
    if (index < 0 || index > 31) throw new Error(`Invalid FP register index: ${index}`);
    const u64Idx = index * 2;
    this.vUint64[u64Idx] = BigInt.asUintN(64, BigInt(uint64));
    this.vUint64[u64Idx + 1] = 0n;
  }

  // --- NEON / Advanced SIMD Vector Accessors ---

  getVRegBytes(index) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    return this.vBytes.subarray(index * 16, (index + 1) * 16);
  }

  setVRegBytes(index, srcBytes) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const offset = index * 16;
    const len = Math.min(16, srcBytes.length);
    for (let i = 0; i < len; i++) {
      this.vBytes[offset + i] = srcBytes[i];
    }
    // Zero remaining upper bytes (e.g. 64-bit 8B vector writes zero bits [127:64])
    for (let i = len; i < 16; i++) {
      this.vBytes[offset + i] = 0;
    }
  }

  getVRegInt16(index, lanes = 8) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 8;
    return this.vInt16.subarray(base, base + lanes);
  }

  setVRegInt16(index, values, lanes = 8) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 8;
    for (let i = 0; i < lanes; i++) {
      this.vInt16[base + i] = values[i] | 0;
    }
    if (lanes === 4) {
      this.vUint64[index * 2 + 1] = 0n;
    }
  }

  getVRegFloat32(index, lanes = 4) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 4;
    return this.vFloat32.subarray(base, base + lanes);
  }

  setVRegFloat32(index, values, lanes = 4) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 4;
    for (let i = 0; i < lanes; i++) {
      this.vFloat32[base + i] = values[i] !== undefined ? Number(values[i]) : 0;
    }
    if (lanes === 2) {
      // 64-bit vector (2S): zero upper 64 bits
      this.vUint64[index * 2 + 1] = 0n;
    }
  }

  getVRegFloat64(index, lanes = 2) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 2;
    return this.vFloat64.subarray(base, base + lanes);
  }

  setVRegFloat64(index, values, lanes = 2) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 2;
    for (let i = 0; i < lanes; i++) {
      this.vFloat64[base + i] = values[i] !== undefined ? Number(values[i]) : 0;
    }
    if (lanes === 1) {
      this.vUint64[index * 2 + 1] = 0n;
    }
  }

  getVRegUint32(index, lanes = 4) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 4;
    return this.vUint32.subarray(base, base + lanes);
  }

  setVRegUint32(index, values, lanes = 4) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 4;
    for (let i = 0; i < lanes; i++) {
      this.vUint32[base + i] = values[i] >>> 0;
    }
    if (lanes === 2) {
      this.vUint64[index * 2 + 1] = 0n;
    }
  }

  getVRegInt32(index, lanes = 4) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 4;
    return this.vInt32.subarray(base, base + lanes);
  }

  setVRegInt32(index, values, lanes = 4) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 4;
    for (let i = 0; i < lanes; i++) {
      this.vInt32[base + i] = values[i] | 0;
    }
    if (lanes === 2) {
      this.vUint64[index * 2 + 1] = 0n;
    }
  }

  getVRegUint64(index, lanes = 2) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 2;
    return this.vUint64.subarray(base, base + lanes);
  }

  setVRegUint64(index, values, lanes = 2) {
    if (index < 0 || index > 31) throw new Error(`Invalid vector register index: ${index}`);
    const base = index * 2;
    for (let i = 0; i < lanes; i++) {
      this.vUint64[base + i] = BigInt.asUintN(64, BigInt(values[i] || 0n));
    }
    if (lanes === 1) {
      this.vUint64[index * 2 + 1] = 0n;
    }
  }

  // Lane extract / insert
  getVRegLane(index, size, lane) {
    // size: 0=B(8), 1=H(16), 2=S(32), 3=D(64)
    if (size === 0) return this.vBytes[index * 16 + lane];
    if (size === 1) return this.vUint16[index * 8 + lane];
    if (size === 2) return this.vUint32[index * 4 + lane];
    if (size === 3) return this.vUint64[index * 2 + lane];
    return 0;
  }

  setVRegLane(index, size, lane, val) {
    if (size === 0) this.vBytes[index * 16 + lane] = Number(val) & 0xff;
    else if (size === 1) this.vUint16[index * 8 + lane] = Number(val) & 0xffff;
    else if (size === 2) this.vUint32[index * 4 + lane] = Number(val) >>> 0;
    else if (size === 3) this.vUint64[index * 2 + lane] = BigInt.asUintN(64, BigInt(val));
  }

  // Pretty-print CPU state for debugging
  dumpState() {
    const pcHex = `0x${this.pc.toString(16).padStart(8, "0")}`;
    const x0 = `X0: ${this.getReg(0).toString().padStart(4, " ")}`;
    const x1 = `X1: ${this.getReg(1).toString().padStart(4, " ")}`;
    const x2 = `X2: ${this.getReg(2).toString().padStart(4, " ")}`;
    const x3 = `X3: ${this.getReg(3).toString().padStart(4, " ")}`;
    const lr = `LR(X30): 0x${this.getReg(30).toString(16).padStart(4, "0")}`;
    const flags = `[N:${this.flags.N ? 1 : 0} Z:${this.flags.Z ? 1 : 0} C:${this.flags.C ? 1 : 0} V:${this.flags.V ? 1 : 0}]`;
    return `PC=${pcHex} | ${x0} ${x1} ${x2} ${x3} ${lr} | Flags: ${flags}`;
  }

  // Reset all registers, flags, and CPU state
  reset() {
    this.x.fill(0n);
    new Uint8Array(this.vBuffer).fill(0);
    this.fpcr = 0;
    this.fpsr = 0;
    this.sp = 0x00700000n;
    this.pc = 0n;
    this.tpidr_el0 = 0n;
    this.sysRegs.clear();
    this.flags.N = false;
    this.flags.Z = false;
    this.flags.C = false;
    this.flags.V = false;
    this.halted = false;
    this.exitCode = 0;
  }

  // Snapshot full CPU state for UI rendering
  getSnapshot() {
    const regs = [];
    for (let i = 0; i < 31; i++) {
      regs.push(this.x[i]);
    }
    const fregs = [];
    for (let i = 0; i < 32; i++) {
      fregs.push({
        d: this.getFRegDouble(i),
        s: this.getFRegSingle(i),
        bits64: this.getFRegBits64(i),
        f32x4: Array.from(this.getVRegFloat32(i, 4)),
        f64x2: Array.from(this.getVRegFloat64(i, 2)),
        u32x4: Array.from(this.getVRegUint32(i, 4)),
        u64x2: Array.from(this.getVRegUint64(i, 2))
      });
    }
    return {
      regs,
      fregs,
      fpcr: this.fpcr,
      fpsr: this.fpsr,
      sp: this.sp,
      pc: this.pc,
      tpidr_el0: this.tpidr_el0,
      flags: { ...this.flags },
      halted: this.halted,
      exitCode: this.exitCode
    };
  }
}
