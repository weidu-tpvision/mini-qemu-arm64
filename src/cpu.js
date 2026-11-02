// cpu.js - Virtual AArch64 (ARM64) CPU State

export class CPU {
  constructor(memory) {
    this.memory = memory;

    // 31 General-Purpose 64-bit registers: X0 to X30
    this.x = new BigUint64Array(31);

    // Stack Pointer (SP) - defaults to 7MB virtual stack address
    this.sp = 0x00700000n;

    // Program Counter (PC)
    this.pc = 0n;

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
}
