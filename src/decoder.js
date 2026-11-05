// decoder.js - ARM64 (AArch64) Instruction Decoder (75+ Integer, System, VFP Float & NEON SIMD Instructions)
// Converts raw 32-bit integers into structured instruction representations.

export const InstructionType = {
  // Data Processing - Immediate
  MOVZ: "MOVZ",
  MOVN: "MOVN",
  MOVK: "MOVK",         // Move wide with keep
  ADD_IMM: "ADD_IMM",
  SUB_IMM: "SUB_IMM",
  SUBS_IMM: "SUBS_IMM", // CMP imm is an alias of SUBS xzr, xn, #imm
  ADR: "ADR",           // Form PC-relative address
  ADRP: "ADRP",         // Form PC-relative 4KB page address

  // Data Processing - Register
  ADD_REG: "ADD_REG",
  SUB_REG: "SUB_REG",
  SUBS_REG: "SUBS_REG", // CMP reg is an alias of SUBS xzr, xn, xm
  AND_REG: "AND_REG",
  ORR_REG: "ORR_REG",   // MOV is an alias of ORR xd, xzr, xm
  EOR_REG: "EOR_REG",   // Exclusive OR (XOR)
  MVN_REG: "MVN_REG",   // Bitwise NOT (alias of ORN xd, xzr, xm)
  CSEL: "CSEL",         // Conditional Select
  CSINC: "CSINC",       // Conditional Select Increment (CSET)
  CSINV: "CSINV",       // Conditional Select Invert
  CSNEG: "CSNEG",       // Conditional Select Negate

  // Math (Multiply & Divide)
  MUL: "MUL",           // 64-bit multiply (MADD xd, xn, xm, xzr)
  MADD: "MADD",         // Multiply-Add (xd = xa + xn * xm)
  MSUB: "MSUB",         // Multiply-Subtract (xd = xa - xn * xm)
  SDIV: "SDIV",         // Signed 64-bit divide
  UDIV: "UDIV",         // Unsigned 64-bit divide

  // Shifts & Bitfields
  LSL: "LSL",           // Logical Shift Left
  LSR: "LSR",           // Logical Shift Right
  ASR: "ASR",           // Arithmetic Shift Right (preserves sign)
  UBFM: "UBFM",         // Unsigned Bitfield Move (LSL/LSR imm, UXTB, UXTH, UBFX)
  SBFM: "SBFM",         // Signed Bitfield Move (ASR imm, SXTB, SXTH, SXTW, SBFX)

  // Loads & Stores (Single)
  LDR_IMM: "LDR_IMM",     // Load 64-bit register
  STR_IMM: "STR_IMM",     // Store 64-bit register
  LDRB_IMM: "LDRB_IMM",   // Load 8-bit unsigned byte
  STRB_IMM: "STRB_IMM",   // Store 8-bit byte
  LDRSB_IMM: "LDRSB_IMM", // Load 8-bit signed byte (sign-extending)
  LDRH_IMM: "LDRH_IMM",   // Load 16-bit unsigned halfword
  STRH_IMM: "STRH_IMM",   // Store 16-bit halfword
  LDRSH_IMM: "LDRSH_IMM", // Load 16-bit signed halfword (sign-extending)
  LDRW_IMM: "LDRW_IMM",   // Load 32-bit unsigned word
  STRW_IMM: "STRW_IMM",   // Store 32-bit word
  LDRSW_IMM: "LDRSW_IMM", // Load 32-bit signed word (sign-extending to 64-bit)

  // Loads & Stores (Pair / Stack Frames)
  STP: "STP",           // Store Pair 64-bit
  LDP: "LDP",           // Load Pair 64-bit

  // Branches & Calls
  B_COND: "B_COND",     // Conditional relative branch
  CBZ: "CBZ",           // Compare and Branch on Zero
  CBNZ: "CBNZ",         // Compare and Branch on Non-Zero
  TBZ: "TBZ",           // Test Bit and Branch on Zero
  TBNZ: "TBNZ",         // Test Bit and Branch on Non-Zero
  B: "B",               // Unconditional relative branch
  BL: "BL",             // Branch with Link (Function call)
  BR: "BR",             // Branch to register (Indirect jump)
  BLR: "BLR",           // Branch with Link to register (Function pointer call)
  RET: "RET",           // Return from subroutine (default to X30 / LR)

  // System
  SVC: "SVC",           // Supervisor Call (Syscall trap)
  MRS: "MRS",           // Move System Register to general-purpose register (e.g. TPIDR_EL0)
  MSR: "MSR",           // Move general-purpose register to System Register (e.g. TPIDR_EL0)

  // System Hints & Barriers
  NOP: "NOP",
  YIELD: "YIELD",
  DMB: "DMB",
  DSB: "DSB",
  ISB: "ISB",

  // Bit Manipulation & Byte Reversal
  CLZ: "CLZ",
  REV: "REV",
  REV16: "REV16",
  REV32: "REV32",
  RBIT: "RBIT",
  EXTR: "EXTR",

  // Exclusive Atomics (Single-threaded user space)
  LDXR: "LDXR",
  STXR: "STXR",

  // --- Floating-Point (Scalar VFP) ---
  FADD: "FADD",         // Floating-point Add (Single/Double)
  FSUB: "FSUB",         // Floating-point Subtract
  FMUL: "FMUL",         // Floating-point Multiply
  FDIV: "FDIV",         // Floating-point Divide
  FNMUL: "FNMUL",       // Floating-point Negated Multiply
  FNEG: "FNEG",         // Floating-point Negate
  FABS: "FABS",         // Floating-point Absolute value
  FSQRT: "FSQRT",       // Floating-point Square Root
  FMAX: "FMAX",         // Floating-point Maximum
  FMIN: "FMIN",         // Floating-point Minimum
  FCMP: "FCMP",         // Floating-point Compare
  FCVT: "FCVT",         // Floating-point Precision Conversion (Single <-> Double)
  SCVTF: "SCVTF",       // Signed integer to Floating-point conversion
  UCVTF: "UCVTF",       // Unsigned integer to Floating-point conversion
  FCVTZS: "FCVTZS",     // Floating-point to Signed integer (truncate)
  FCVTZU: "FCVTZU",     // Floating-point to Unsigned integer (truncate)
  FMOV: "FMOV",         // Floating-point Move (reg, imm, or GPR <-> FPR bit-cast)

  // Floating-Point & Vector Loads and Stores
  LDR_FREG: "LDR_FREG", // Load FP single/double register (LDR Sn/Dn, [Xn])
  STR_FREG: "STR_FREG", // Store FP single/double register (STR Sn/Dn, [Xn])
  LDR_VREG: "LDR_VREG", // Load 128-bit vector register (LDR Qn, [Xn])
  STR_VREG: "STR_VREG", // Store 128-bit vector register (STR Qn, [Xn])
  LDP_FREG: "LDP_FREG", // Load Pair FP registers (LDP Dn, Dm, [Xn])
  STP_FREG: "STP_FREG", // Store Pair FP registers (STP Dn, Dm, [Xn])
  LDP_VREG: "LDP_VREG", // Load Pair 128-bit vector registers (LDP Qn, Qm, [Xn])
  STP_VREG: "STP_VREG", // Store Pair 128-bit vector registers (STP Qn, Qm, [Xn])

  // --- NEON / Advanced SIMD Instructions ---
  FADD_VEC: "FADD_VEC",   // Vector Floating-point Add
  FSUB_VEC: "FSUB_VEC",   // Vector Floating-point Subtract
  FMUL_VEC: "FMUL_VEC",   // Vector Floating-point Multiply
  FDIV_VEC: "FDIV_VEC",   // Vector Floating-point Divide
  FADDP_VEC: "FADDP_VEC", // Vector Floating-point Pairwise Add (Reduction)
  FMAX_VEC: "FMAX_VEC",   // Vector Floating-point Maximum
  FMIN_VEC: "FMIN_VEC",   // Vector Floating-point Minimum
  FNEG_VEC: "FNEG_VEC",   // Vector Floating-point Negate
  FABS_VEC: "FABS_VEC",   // Vector Floating-point Absolute value

  ADD_VEC: "ADD_VEC",     // Vector Integer Add
  SUB_VEC: "SUB_VEC",     // Vector Integer Subtract
  MUL_VEC: "MUL_VEC",     // Vector Integer Multiply
  ADDP_VEC: "ADDP_VEC",   // Vector Integer Pairwise Add
  AND_VEC: "AND_VEC",     // Vector Bitwise AND
  ORR_VEC: "ORR_VEC",     // Vector Bitwise OR
  EOR_VEC: "EOR_VEC",     // Vector Bitwise XOR
  NOT_VEC: "NOT_VEC",     // Vector Bitwise NOT (MVN)

  DUP_ELEM: "DUP_ELEM",   // DUP element to vector (dup vn.4s, vm.s[i])
  DUP_GEN: "DUP_GEN",     // DUP general register to vector (dup vn.4s, wn)
  INS_ELEM: "INS_ELEM",   // Insert element into vector
  INS_GEN: "INS_GEN",     // Insert general register into vector lane
  UMOV_ELEM: "UMOV_ELEM", // Extract vector lane to general register

  UNKNOWN: "UNKNOWN",
};

export const ConditionCode = {
  EQ: 0b0000,
  NE: 0b0001,
  CS: 0b0010,
  CC: 0b0011,
  MI: 0b0100,
  PL: 0b0101,
  VS: 0b0110,
  VC: 0b0111,
  HI: 0b1000,
  LS: 0b1001,
  GE: 0b1010,
  LT: 0b1011,
  GT: 0b1100,
  LE: 0b1101,
  AL: 0b1110,
};

export const ConditionNames = {
  [ConditionCode.EQ]: "eq",
  [ConditionCode.NE]: "ne",
  [ConditionCode.CS]: "cs",
  [ConditionCode.CC]: "cc",
  [ConditionCode.MI]: "mi",
  [ConditionCode.PL]: "pl",
  [ConditionCode.VS]: "vs",
  [ConditionCode.VC]: "vc",
  [ConditionCode.HI]: "hi",
  [ConditionCode.LS]: "ls",
  [ConditionCode.GE]: "ge",
  [ConditionCode.LT]: "lt",
  [ConditionCode.GT]: "gt",
  [ConditionCode.LE]: "le",
  [ConditionCode.AL]: "al",
};

export class Decoder {
  static decode(instr) {
    const raw = instr >>> 0; // Ensure unsigned 32-bit integer

    const op0 = (raw >>> 25) & 0b1111;

    // 1. Data Processing -- Immediate (op0 matches 100x)
    if ((op0 & 0b1110) === 0b1000) {
      return this._decodeDataProcessingImmediate(raw);
    }

    // 2. Branches, Exception Generating and System (op0 matches 101x)
    if ((op0 & 0b1110) === 0b1010) {
      return this._decodeBranchesAndSystem(raw);
    }

    // 3. Data Processing -- Register (op0 matches x101)
    if ((op0 & 0b0111) === 0b0101) {
      return this._decodeDataProcessingRegister(raw);
    }

    // 4. Loads and Stores (op0 matches x1x0)
    if ((op0 & 0b0101) === 0b0100) {
      return this._decodeLoadsAndStores(raw);
    }

    // 5. Data Processing -- Scalar Floating-Point and Advanced SIMD (op0 matches x111)
    if ((op0 & 0b0111) === 0b0111) {
      return this._decodeFloatAndNeon(raw);
    }

    return {
      type: InstructionType.UNKNOWN,
      raw,
      disassembly: `unknown (0x${raw.toString(16).padStart(8, "0")})`,
    };
  }

  // --- 1. Data Processing Immediate ---
  static _decodeDataProcessingImmediate(raw) {
    const op1 = (raw >>> 23) & 0b111;

    // ADR: bits [31:24] & 0x9f = 0x10, ADRP: bits [31:24] & 0x9f = 0x90
    if (((raw >>> 24) & 0x9f) === 0x10 || ((raw >>> 24) & 0x9f) === 0x90) {
      const isPage = ((raw >>> 31) & 1) === 1;
      const immlo = (raw >>> 29) & 0x3;
      const immhi = (raw >>> 5) & 0x7ffff;
      const rd = raw & 0x1f;

      let imm21 = (immhi << 2) | immlo;
      if (imm21 & 0x100000) imm21 -= 0x200000;

      if (isPage) {
        return {
          type: InstructionType.ADRP,
          raw,
          rd,
          imm21,
          offsetBytes: imm21 * 4096,
          disassembly: `adrp x${rd}, [page ${imm21 >= 0 ? "+" : ""}${imm21 * 4096}B]`,
        };
      } else {
        return {
          type: InstructionType.ADR,
          raw,
          rd,
          imm21,
          offsetBytes: imm21,
          disassembly: `adr x${rd}, [offset ${imm21 >= 0 ? "+" : ""}${imm21}B]`,
        };
      }
    }

    // Move Wide Immediate (MOVZ / MOVN / MOVK): op1 == 101
    if (op1 === 0b101) {
      const sf = (raw >>> 31) & 1;
      const opc = (raw >>> 29) & 0x3; // 10 = MOVZ, 00 = MOVN, 11 = MOVK
      const hw = (raw >>> 21) & 0x3;
      const imm16 = (raw >>> 5) & 0xffff;
      const rd = raw & 0x1f;
      const shift = hw * 16;
      const regPrefix = sf ? "x" : "w";

      if (opc === 0b10) { // MOVZ
        const immValue = BigInt(imm16) << BigInt(shift);
        return {
          type: InstructionType.MOVZ,
          raw,
          sf,
          rd,
          imm16,
          shift,
          immValue,
          disassembly: `movz ${regPrefix}${rd}, #${imm16}${shift > 0 ? `, lsl #${shift}` : ""}`,
        };
      } else if (opc === 0b00) { // MOVN
        const base = BigInt(imm16) << BigInt(shift);
        const immValue = BigInt.asUintN(sf ? 64 : 32, ~base);
        return {
          type: InstructionType.MOVN,
          raw,
          sf,
          rd,
          imm16,
          shift,
          immValue,
          disassembly: `movn ${regPrefix}${rd}, #${imm16}${shift > 0 ? `, lsl #${shift}` : ""}`,
        };
      } else if (opc === 0b11) { // MOVK
        const immValue = BigInt(imm16) << BigInt(shift);
        return {
          type: InstructionType.MOVK,
          raw,
          sf,
          rd,
          imm16,
          shift,
          immValue,
          disassembly: `movk ${regPrefix}${rd}, #${imm16}${shift > 0 ? `, lsl #${shift}` : ""}`,
        };
      }
    }

    // Add/Subtract (immediate): op1 matches 010
    if (op1 === 0b010) {
      const sf = (raw >>> 31) & 1;
      const op = (raw >>> 30) & 1; // 0 = ADD, 1 = SUB
      const s = (raw >>> 29) & 1;  // 1 = set flags (SUBS)
      const shiftBit = (raw >>> 22) & 1;
      const imm12 = (raw >>> 10) & 0xfff;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;
      const shift = shiftBit ? 12 : 0;
      const immValue = BigInt(imm12) << BigInt(shift);

      let type = InstructionType.UNKNOWN;
      let mnemonic = "";

      if (op === 0 && s === 0) {
        type = InstructionType.ADD_IMM;
        mnemonic = "add";
      } else if (op === 1 && s === 0) {
        type = InstructionType.SUB_IMM;
        mnemonic = "sub";
      } else if (op === 1 && s === 1) {
        type = InstructionType.SUBS_IMM;
        mnemonic = (rd === 31) ? "cmp" : "subs";
      }

      const reg = sf ? "x" : "w";
      const spName = sf ? "sp" : "wsp";
      const rnName = (rn === 31) ? spName : `${reg}${rn}`;
      const rdName = (rd === 31 && s === 0) ? spName : `${reg}${rd}`;
      const disasm = (mnemonic === "cmp")
        ? `cmp ${rnName}, #${imm12}${shift > 0 ? `, lsl #${shift}` : ""}`
        : `${mnemonic} ${rdName}, ${rnName}, #${imm12}${shift > 0 ? `, lsl #${shift}` : ""}`;

      return {
        type,
        raw,
        sf,
        setFlags: s === 1,
        rd,
        rn,
        imm12,
        shift,
        immValue,
        disassembly: disasm,
      };
    }

    // Bitfield (SBFM / UBFM: immediate shifts LSL/LSR/ASR and UXTB/UXTH/SXTB/SXTH/SXTW): op1 == 110
    if (op1 === 0b110) {
      const sf = (raw >>> 31) & 1;
      const opc = (raw >>> 29) & 0b11; // 00 = SBFM, 10 = UBFM
      const immr = (raw >>> 16) & 0x3f;
      const imms = (raw >>> 10) & 0x3f;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;
      const reg = sf ? "x" : "w";
      const maxBit = sf ? 63 : 31;

      if (opc === 0b10) { // UBFM
        let disasm = `ubfm ${reg}${rd}, ${reg}${rn}, #${immr}, #${imms}`;
        if (imms === maxBit) {
          disasm = `lsr ${reg}${rd}, ${reg}${rn}, #${immr}`;
        } else if (imms + 1 === immr) {
          const shift = (maxBit + 1) - immr;
          disasm = `lsl ${reg}${rd}, ${reg}${rn}, #${shift}`;
        } else if (immr === 0 && imms === 7) {
          disasm = `uxtb w${rd}, w${rn}`;
        } else if (immr === 0 && imms === 15) {
          disasm = `uxth w${rd}, w${rn}`;
        }
        return {
          type: InstructionType.UBFM,
          raw,
          sf,
          rd,
          rn,
          immr,
          imms,
          disassembly: disasm,
        };
      } else if (opc === 0b00) { // SBFM
        let disasm = `sbfm ${reg}${rd}, ${reg}${rn}, #${immr}, #${imms}`;
        if (imms === maxBit) {
          disasm = `asr ${reg}${rd}, ${reg}${rn}, #${immr}`;
        } else if (immr === 0 && imms === 7) {
          disasm = `sxtb ${reg}${rd}, w${rn}`;
        } else if (immr === 0 && imms === 15) {
          disasm = `sxth ${reg}${rd}, w${rn}`;
        } else if (immr === 0 && imms === 31 && sf === 1) {
          disasm = `sxtw x${rd}, w${rn}`;
        }
        return {
          type: InstructionType.SBFM,
          raw,
          sf,
          rd,
          rn,
          immr,
          imms,
          disassembly: disasm,
        };
      }
    }

    // Extract (EXTR / ROR imm): op1 == 111
    if (op1 === 0b111 && ((raw >>> 29) & 0b11) === 0b00) {
      const sf = (raw >>> 31) & 1;
      const N = (raw >>> 22) & 1;
      const o0 = (raw >>> 21) & 1;
      const imms = (raw >>> 10) & 0x3f;
      if (o0 === 0 && N === sf && (sf === 1 || imms < 32)) {
        const rm = (raw >>> 16) & 0x1f;
        const rn = (raw >>> 5) & 0x1f;
        const rd = raw & 0x1f;
        const reg = sf ? "x" : "w";
        const lsb = imms;
        const disasm = (rn === rm)
          ? `ror ${reg}${rd}, ${reg}${rn}, #${lsb}`
          : `extr ${reg}${rd}, ${reg}${rn}, ${reg}${rm}, #${lsb}`;
        return {
          type: InstructionType.EXTR,
          raw,
          sf,
          rd,
          rn,
          rm,
          lsb,
          disassembly: disasm
        };
      }
    }

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown imm 0x${raw.toString(16)}` };
  }

  // --- 2. Branches, Exception Generating and System ---
  static _decodeBranchesAndSystem(raw) {
    // 1. Conditional Branch (B.cond): bits [31:24] = 0x54, bit[4] = 0
    if ((raw >>> 24) === 0x54 && ((raw & 0x10) === 0)) {
      let imm19 = (raw >>> 5) & 0x7ffff;
      if (imm19 & 0x40000) imm19 -= 0x80000;
      const offsetBytes = imm19 * 4;
      const cond = raw & 0x0f;
      const condName = ConditionNames[cond] || `cond_${cond}`;

      return {
        type: InstructionType.B_COND,
        raw,
        cond,
        condName,
        imm19,
        offsetBytes,
        disassembly: `b.${condName} [offset ${offsetBytes >= 0 ? "+" : ""}${offsetBytes}B]`,
      };
    }

    // 1b. Compare and Branch on Zero / Non-Zero (CBZ / CBNZ): bits [30:25] = 0b011010
    if (((raw >>> 25) & 0x3f) === 0b011010) {
      const sf = (raw >>> 31) & 1;
      const op = (raw >>> 24) & 1; // 0 = CBZ, 1 = CBNZ
      let imm19 = (raw >>> 5) & 0x7ffff;
      if (imm19 & 0x40000) imm19 -= 0x80000;
      const offsetBytes = imm19 * 4;
      const rt = raw & 0x1f;
      const regPrefix = sf ? "x" : "w";
      const mnem = op === 1 ? "cbnz" : "cbz";

      return {
        type: op === 1 ? InstructionType.CBNZ : InstructionType.CBZ,
        raw,
        sf,
        rt,
        imm19,
        offsetBytes,
        disassembly: `${mnem} ${regPrefix}${rt}, [offset ${offsetBytes >= 0 ? "+" : ""}${offsetBytes}B]`,
      };
    }

    // 1c. Test Bit and Branch on Zero / Non-Zero (TBZ / TBNZ): bits [30:25] = 0b011011
    if (((raw >>> 25) & 0x3f) === 0b011011) {
      const b5 = (raw >>> 31) & 1;
      const op = (raw >>> 24) & 1; // 0 = TBZ, 1 = TBNZ
      const b40 = (raw >>> 19) & 0x1f;
      const bitPos = (b5 << 5) | b40;
      let imm14 = (raw >>> 5) & 0x3fff;
      if (imm14 & 0x2000) imm14 -= 0x4000;
      const offsetBytes = imm14 * 4;
      const rt = raw & 0x1f;
      const regPrefix = b5 ? "x" : "w";
      const mnem = op === 1 ? "tbnz" : "tbz";

      return {
        type: op === 1 ? InstructionType.TBNZ : InstructionType.TBZ,
        raw,
        sf: b5,
        rt,
        bitPos,
        imm14,
        offsetBytes,
        disassembly: `${mnem} ${regPrefix}${rt}, #${bitPos}, [offset ${offsetBytes >= 0 ? "+" : ""}${offsetBytes}B]`,
      };
    }

    // 2. Unconditional Branch (B): bits [31:26] = 0b000101
    if ((raw >>> 26) === 0b000101) {
      let imm26 = raw & 0x3ffffff;
      if (imm26 & 0x2000000) imm26 -= 0x4000000;
      const offsetBytes = imm26 * 4;

      return {
        type: InstructionType.B,
        raw,
        imm26,
        offsetBytes,
        disassembly: `b [offset ${offsetBytes >= 0 ? "+" : ""}${offsetBytes}B]`,
      };
    }

    // 3. Branch with Link (BL): bits [31:26] = 0b100101 (Function call)
    if ((raw >>> 26) === 0b100101) {
      let imm26 = raw & 0x3ffffff;
      if (imm26 & 0x2000000) imm26 -= 0x4000000;
      const offsetBytes = imm26 * 4;

      return {
        type: InstructionType.BL,
        raw,
        imm26,
        offsetBytes,
        disassembly: `bl [offset ${offsetBytes >= 0 ? "+" : ""}${offsetBytes}B]`,
      };
    }

    // 4. Unconditional branch (register): BR, BLR, RET
    // Pattern: bits [31:25] = 1101011, bits [24:21] = 0000 (BR), 0001 (BLR), 0010 (RET)
    if ((raw >>> 25) === 0b1101011) {
      const opc = (raw >>> 21) & 0b1111;
      const rn = (raw >>> 5) & 0x1f;

      if (opc === 0b0000) { // BR Xn
        return { type: InstructionType.BR, raw, rn, disassembly: `br x${rn}` };
      } else if (opc === 0b0001) { // BLR Xn (call function pointer)
        return { type: InstructionType.BLR, raw, rn, disassembly: `blr x${rn}` };
      } else if (opc === 0b0010) { // RET Xn
        return { type: InstructionType.RET, raw, rn, disassembly: rn === 30 ? "ret" : `ret x${rn}` };
      }
    }

    // 5. Exception generation (SVC): bits [31:21] = 0b11010100000, bits [4:0] = 0b00001
    if ((raw >>> 21) === 0b11010100000 && (raw & 0x1f) === 0b00001) {
      const imm16 = (raw >>> 5) & 0xffff;
      return {
        type: InstructionType.SVC,
        raw,
        imm16,
        disassembly: `svc #${imm16}`,
      };
    }

    // 5b. System hints and barriers (NOP, YIELD, WFE, WFI, DMB, DSB, ISB, etc.)
    if (((raw >>> 16) & 0xffff) === 0xd503) {
      const crn = (raw >>> 12) & 0xf;
      const crm = (raw >>> 8) & 0xf;
      const op2 = (raw >>> 5) & 0x7;
      if (crn === 2) {
        const hintImm = (crm << 3) | op2;
        if (hintImm === 0) return { type: InstructionType.NOP, raw, disassembly: "nop" };
        if (hintImm === 1) return { type: InstructionType.YIELD, raw, disassembly: "yield" };
        if (hintImm === 2) return { type: InstructionType.NOP, raw, disassembly: "wfe" };
        if (hintImm === 3) return { type: InstructionType.NOP, raw, disassembly: "wfi" };
        if (hintImm === 4) return { type: InstructionType.NOP, raw, disassembly: "sev" };
        if (hintImm === 5) return { type: InstructionType.NOP, raw, disassembly: "sevl" };
        if (hintImm === 0x19) return { type: InstructionType.NOP, raw, disassembly: "paciasp" };
        if (hintImm === 0x1d) return { type: InstructionType.NOP, raw, disassembly: "autiasp" };
        if (hintImm === 0x1b) return { type: InstructionType.NOP, raw, disassembly: "pacibsp" };
        if (hintImm === 0x1f) return { type: InstructionType.NOP, raw, disassembly: "autibsp" };
        if (hintImm === 0x07) return { type: InstructionType.NOP, raw, disassembly: "xpaclri" };
        if (crm === 4) {
          const btiTargets = { 0b000: "", 0b010: " c", 0b100: " j", 0b110: " jc" };
          if (btiTargets[op2] !== undefined) {
            return { type: InstructionType.NOP, raw, disassembly: `bti${btiTargets[op2]}` };
          }
        }
        return { type: InstructionType.NOP, raw, disassembly: `hint #${hintImm}` };
      } else if (crn === 3) {
        if (op2 === 2) return { type: InstructionType.NOP, raw, disassembly: "clrex" };
        if (op2 === 6) return { type: InstructionType.ISB, raw, disassembly: "isb" };
        if (op2 === 7) return { type: InstructionType.NOP, raw, disassembly: "sb" };
        const barrierOptions = {
          15: "sy", 14: "st", 13: "ld",
          11: "ish", 10: "ishst", 9: "ishld",
          7: "nsh", 6: "nshst", 5: "nshld",
          3: "osh", 2: "oshst", 1: "oshld"
        };
        const opt = barrierOptions[crm] || `#${crm}`;
        if (op2 === 4) return { type: InstructionType.DSB, raw, disassembly: `dsb ${opt}` };
        if (op2 === 5) return { type: InstructionType.DMB, raw, disassembly: `dmb ${opt}` };
      }
      return { type: InstructionType.NOP, raw, disassembly: `sys_hint 0x${raw.toString(16)}` };
    }

    // 6. System Register Move (MRS / MSR): bits [31:22] = 0b1101010100 (0x354)
    if ((raw >>> 22) === 0b1101010100) {
      const lBit = (raw >>> 21) & 1; // 0 = MSR (write sysreg), 1 = MRS (read sysreg)
      const sysreg = (raw >>> 5) & 0xffff;
      const rt = raw & 0x1f;
      // TPIDR_EL0 encoding in bits [20:5]: op0=3, op1=3, CRn=13, CRm=0, op2=2 -> 0xde82
      const sysregName = sysreg === 0xde82 ? "tpidr_el0" : `sysreg_0x${sysreg.toString(16)}`;
      if (lBit === 1) {
        return {
          type: InstructionType.MRS,
          raw,
          rt,
          sysreg,
          sysregName,
          disassembly: `mrs x${rt}, ${sysregName}`,
        };
      } else {
        return {
          type: InstructionType.MSR,
          raw,
          rt,
          sysreg,
          sysregName,
          disassembly: `msr ${sysregName}, x${rt}`,
        };
      }
    }

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown branch/sys 0x${raw.toString(16)}` };
  }

  // --- 3. Data Processing Register ---
  static _decodeDataProcessingRegister(raw) {
    const sf = (raw >>> 31) & 1;
    const op = (raw >>> 30) & 1;
    const s = (raw >>> 29) & 1;

    // Multiply / Divide (3-source or 2-source data processing)
    // MADD / MSUB / MUL: bits [28:24] = 11011, bits [23:21] = 000
    if (((raw >>> 24) & 0b11111) === 0b11011) {
      const op31 = (raw >>> 21) & 0b111;
      const rm = (raw >>> 16) & 0x1f;
      const o0 = (raw >>> 15) & 1; // 0 = MADD/MUL, 1 = MSUB/MNEG
      const ra = (raw >>> 10) & 0x1f;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;
      const regPrefix = sf ? "x" : "w";

      if (op31 === 0b000) {
        if (o0 === 0 && ra === 31) { // MADD xd, xn, xm, xzr is MUL xd, xn, xm
          return {
            type: InstructionType.MUL,
            raw,
            sf,
            rd,
            rn,
            rm,
            ra: 31,
            disassembly: `mul ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}`,
          };
        } else if (o0 === 0) {
          return {
            type: InstructionType.MADD,
            raw,
            sf,
            rd,
            rn,
            rm,
            ra,
            disassembly: `madd ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}, ${regPrefix}${ra}`,
          };
        } else {
          const disasm = ra === 31
            ? `mneg ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}`
            : `msub ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}, ${regPrefix}${ra}`;
          return {
            type: InstructionType.MSUB,
            raw,
            sf,
            rd,
            rn,
            rm,
            ra,
            disassembly: disasm,
          };
        }
      }
    }

    // Divide / Shifts (2-source) and Bit reversal / CLZ (1-source): bits [28:21] = 0b11010110
    if (((raw >>> 21) & 0xff) === 0b11010110) {
      const rm = (raw >>> 16) & 0x1f;
      const opcode = (raw >>> 10) & 0b111111;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;
      const regPrefix = sf ? "x" : "w";

      if (op === 1 && s === 0 && rm === 0) { // 1-source operations: RBIT, REV16, REV, REV32, CLZ (opcode2 == 0)
        if (opcode === 0b000000) {
          return { type: InstructionType.RBIT, raw, sf, rd, rn, disassembly: `rbit ${regPrefix}${rd}, ${regPrefix}${rn}` };
        } else if (opcode === 0b000001) {
          return { type: InstructionType.REV16, raw, sf, rd, rn, disassembly: `rev16 ${regPrefix}${rd}, ${regPrefix}${rn}` };
        } else if (opcode === 0b000010) {
          const type = sf ? InstructionType.REV32 : InstructionType.REV;
          const name = sf ? "rev32" : "rev";
          return { type, raw, sf, rd, rn, disassembly: `${name} ${regPrefix}${rd}, ${regPrefix}${rn}` };
        } else if (opcode === 0b000011 && sf === 1) {
          return { type: InstructionType.REV, raw, sf, rd, rn, disassembly: `rev x${rd}, x${rn}` };
        } else if (opcode === 0b000100) {
          return { type: InstructionType.CLZ, raw, sf, rd, rn, disassembly: `clz ${regPrefix}${rd}, ${regPrefix}${rn}` };
        }
        return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown data-proc 1-src 0x${raw.toString(16)}` };
      } else if (op === 1) {
        return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown data-proc 1-src 0x${raw.toString(16)}` };
      }

      if (op === 0 && s === 0) {
        if (opcode === 0b000010) { // UDIV
          return { type: InstructionType.UDIV, raw, sf, rd, rn, rm, disassembly: `udiv ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}` };
        } else if (opcode === 0b000011) { // SDIV
          return { type: InstructionType.SDIV, raw, sf, rd, rn, rm, disassembly: `sdiv ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}` };
        } else if (opcode === 0b001000) { // LSLV
          return { type: InstructionType.LSL, raw, sf, rd, rn, rm, isRegShift: true, disassembly: `lsl ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}` };
        } else if (opcode === 0b001001) { // LSRV
          return { type: InstructionType.LSR, raw, sf, rd, rn, rm, isRegShift: true, disassembly: `lsr ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}` };
        } else if (opcode === 0b001010) { // ASRV
          return { type: InstructionType.ASR, raw, sf, rd, rn, rm, isRegShift: true, disassembly: `asr ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}` };
        } else if (opcode === 0b001011) { // RORV
          return { type: InstructionType.EXTR, raw, sf, rd, rn, rm, isRegShift: true, disassembly: `ror ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}` };
        }
      }
    }

    // Conditional Select: bits [30:21] = 00 11010100 (0x0d4)
    if (((raw >>> 21) & 0x3ff) === 0x0d4) {
      const rm = (raw >>> 16) & 0x1f;
      const cond = (raw >>> 12) & 0xf;
      const op2 = (raw >>> 10) & 0x3;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;

      let type = InstructionType.CSEL;
      let name = "csel";
      if (op2 === 0b01) { type = InstructionType.CSINC; name = "csinc"; }
      else if (op2 === 0b10) { type = InstructionType.CSINV; name = "csinv"; }
      else if (op2 === 0b11) { type = InstructionType.CSNEG; name = "csneg"; }

      const condName = ConditionNames[cond] || `cond_${cond}`;
      const regPrefix = sf ? "x" : "w";
      let disasm = `${name} ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}, ${condName}`;

      // CSET alias: csinc xd, xzr, xzr, invert(cond)
      if (type === InstructionType.CSINC && rn === 31 && rm === 31) {
        const invCondName = ConditionNames[cond ^ 1] || `cond_${cond ^ 1}`;
        disasm = `cset ${regPrefix}${rd}, ${invCondName}`;
      }

      return {
        type,
        raw,
        sf,
        rd,
        rn,
        rm,
        cond,
        condName,
        op2,
        disassembly: disasm,
      };
    }

    // Add / Subtract (shifted register): bits [28:24] = 01011
    if (((raw >>> 24) & 0b11111) === 0b01011) {
      const shift = (raw >>> 22) & 0b11;
      const rm = (raw >>> 16) & 0x1f;
      const imm6 = (raw >>> 10) & 0x3f;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;
      const regPrefix = sf ? "x" : "w";
      const shiftName = shift === 0b01 ? "lsr" : shift === 0b10 ? "asr" : "lsl";
      const shiftSuffix = imm6 > 0 ? `, ${shiftName} #${imm6}` : "";

      if (op === 0 && s === 0) {
        return {
          type: InstructionType.ADD_REG,
          raw,
          sf,
          rd,
          rn,
          rm,
          shift,
          imm6,
          disassembly: `add ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}${shiftSuffix}`,
        };
      } else if (op === 1 && s === 0) {
        return {
          type: InstructionType.SUB_REG,
          raw,
          sf,
          rd,
          rn,
          rm,
          shift,
          imm6,
          disassembly: `sub ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}${shiftSuffix}`,
        };
      } else if (op === 1 && s === 1) { // SUBS / CMP register
        const mnemonic = (rd === 31) ? "cmp" : "subs";
        const disasm = (rd === 31)
          ? `cmp ${regPrefix}${rn}, ${regPrefix}${rm}${shiftSuffix}`
          : `subs ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}${shiftSuffix}`;
        return {
          type: InstructionType.SUBS_REG,
          raw,
          sf,
          rd,
          rn,
          rm,
          shift,
          imm6,
          disassembly: disasm,
        };
      }
    }

    // Logical (shifted register): bits [28:24] = 01010
    if (((raw >>> 24) & 0b11111) === 0b01010) {
      const shift = (raw >>> 22) & 0b11;
      const rm = (raw >>> 16) & 0x1f;
      const imm6 = (raw >>> 10) & 0x3f;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;
      const nBit = (raw >>> 21) & 1; // 1 for NOT (ORN, EON, BIC)
      const regPrefix = sf ? "x" : "w";
      const shiftName = shift === 0b01 ? "lsr" : shift === 0b10 ? "asr" : "lsl";
      const shiftSuffix = imm6 > 0 ? `, ${shiftName} #${imm6}` : "";

      // AND: op == 0, s == 0, N == 0
      if (op === 0 && s === 0 && nBit === 0) {
        return { type: InstructionType.AND_REG, raw, sf, rd, rn, rm, shift, imm6, disassembly: `and ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}${shiftSuffix}` };
      }

      // ORR / MOV: op == 0, s == 1, N == 0
      if (op === 0 && s === 1 && nBit === 0) {
        const isMov = (rn === 31 && imm6 === 0 && shift === 0);
        return {
          type: InstructionType.ORR_REG,
          raw,
          sf,
          rd,
          rn,
          rm,
          shift,
          imm6,
          disassembly: isMov ? `mov ${regPrefix}${rd}, ${regPrefix}${rm}` : `orr ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}${shiftSuffix}`,
        };
      }

      // MVN (ORN xd, xzr, xm): op == 0, s == 1, N == 1
      if (op === 0 && s === 1 && nBit === 1 && rn === 31) {
        return { type: InstructionType.MVN_REG, raw, sf, rd, rm, shift, imm6, disassembly: `mvn ${regPrefix}${rd}, ${regPrefix}${rm}${shiftSuffix}` };
      }

      // EOR (XOR): op == 1, s == 0, N == 0
      if (op === 1 && s === 0 && nBit === 0) {
        return { type: InstructionType.EOR_REG, raw, sf, rd, rn, rm, shift, imm6, disassembly: `eor ${regPrefix}${rd}, ${regPrefix}${rn}, ${regPrefix}${rm}${shiftSuffix}` };
      }
    }

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown reg 0x${raw.toString(16)}` };
  }

  // --- 4. Loads and Stores ---
  static _decodeLoadsAndStores(raw) {
    const isVec = ((raw >>> 26) & 1) === 1;

    // 4.0 Load / Store Exclusive & Ordered: bits [29:24] = 001000
    if (!isVec && ((raw >>> 24) & 0x3f) === 0b001000) {
      const size = (raw >>> 30) & 0b11;
      const o2 = (raw >>> 23) & 1;
      const lBit = (raw >>> 22) & 1;
      const o1 = (raw >>> 21) & 1;
      const rs = (raw >>> 16) & 0x1f;
      const o0 = (raw >>> 15) & 1;
      const rt2 = (raw >>> 10) & 0x1f;
      const rn = (raw >>> 5) & 0x1f;
      const rt = raw & 0x1f;

      const baseName = rn === 31 ? "sp" : `x${rn}`;

      // o2=0, o1=0: exclusive single: LDXR/LDAXR (L=1) and STXR/STLXR (L=0)
      if (o2 === 0 && o1 === 0) {
        const bytes = 1 << size;
        const sf = size === 3 ? 1 : 0;
        const regPrefix = sf ? "x" : "w";
        const suffix = size === 0 ? "b" : (size === 1 ? "h" : "");
        if (lBit === 1) {
          const mnemonic = (o0 === 1 ? "ldaxr" : "ldxr") + suffix;
          return {
            type: InstructionType.LDXR,
            raw,
            sf,
            size,
            bytes,
            exclusive: true,
            pair: false,
            rt,
            rn,
            disassembly: `${mnemonic} ${regPrefix}${rt}, [${baseName}]`
          };
        } else {
          const mnemonic = (o0 === 1 ? "stlxr" : "stxr") + suffix;
          return {
            type: InstructionType.STXR,
            raw,
            sf,
            size,
            bytes,
            exclusive: true,
            pair: false,
            rs,
            rt,
            rn,
            disassembly: `${mnemonic} w${rs}, ${regPrefix}${rt}, [${baseName}]`
          };
        }
      }

      // o2=0, o1=1: LDXP/STXP pair (size >= 2)
      if (o2 === 0 && o1 === 1) {
        if (size < 2) {
          return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown casp 0x${raw.toString(16)}` };
        }
        const bytes = size === 3 ? 8 : 4;
        const sf = size === 3 ? 1 : 0;
        const regPrefix = sf ? "x" : "w";
        if (lBit === 1) {
          const mnemonic = o0 === 1 ? "ldaxp" : "ldxp";
          return {
            type: InstructionType.LDXR,
            raw,
            sf,
            size,
            bytes,
            exclusive: true,
            pair: true,
            rt,
            rt2,
            rn,
            disassembly: `${mnemonic} ${regPrefix}${rt}, ${regPrefix}${rt2}, [${baseName}]`
          };
        } else {
          const mnemonic = o0 === 1 ? "stlxp" : "stxp";
          return {
            type: InstructionType.STXR,
            raw,
            sf,
            size,
            bytes,
            exclusive: true,
            pair: true,
            rs,
            rt,
            rt2,
            rn,
            disassembly: `${mnemonic} w${rs}, ${regPrefix}${rt}, ${regPrefix}${rt2}, [${baseName}]`
          };
        }
      }

      // o2=1, o1=0: LDAR/LDLAR (L=1) and STLR/STLLR (L=0)
      if (o2 === 1 && o1 === 0) {
        const bytes = 1 << size;
        const sf = size === 3 ? 1 : 0;
        const regPrefix = sf ? "x" : "w";
        const suffix = size === 0 ? "b" : (size === 1 ? "h" : "");
        if (lBit === 1) {
          const mnemonic = "ldar" + suffix;
          return {
            type: InstructionType.LDXR,
            raw,
            sf,
            size,
            bytes,
            exclusive: false,
            pair: false,
            rt,
            rn,
            disassembly: `${mnemonic} ${regPrefix}${rt}, [${baseName}]`
          };
        } else {
          const mnemonic = "stlr" + suffix;
          return {
            type: InstructionType.STXR,
            raw,
            sf,
            size,
            bytes,
            exclusive: false,
            pair: false,
            rs,
            rt,
            rn,
            disassembly: `${mnemonic} ${regPrefix}${rt}, [${baseName}]`
          };
        }
      }

      // o2=1, o1=1: CAS family (LSE) => UNKNOWN
      if (o2 === 1 && o1 === 1) {
        return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown cas 0x${raw.toString(16)}` };
      }
    }

    // 4.1 Load / Store Pair (STP / LDP): bits [29:27] = 101
    // Addressing modes in bits [24:23]: 01 = Post-index, 10 = Signed offset, 11 = Pre-index
    if (((raw >>> 27) & 0b111) === 0b101) {
      const opc = (raw >>> 30) & 0b11;
      const addrMode = (raw >>> 23) & 0b11;
      const lBit = (raw >>> 22) & 1; // 0 = Store (STP), 1 = Load (LDP)
      let imm7 = (raw >>> 15) & 0x7f;
      if (imm7 & 0x40) imm7 -= 0x80; // sign extend 7 bits
      const sf = (opc >>> 1) & 1; // For GPR STP/LDP: opc=00 is 32-bit (w), opc=10 is 64-bit (x)
      const scale = isVec ? (opc === 0b10 ? 16 : opc === 0b01 ? 8 : 4) : (sf ? 8 : 4);
      const offsetBytes = imm7 * scale;
      const rt2 = (raw >>> 10) & 0x1f;
      const rn = (raw >>> 5) & 0x1f;
      const rt1 = raw & 0x1f;

      const preIndex = (addrMode === 0b11);
      const postIndex = (addrMode === 0b01);
      const baseName = (rn === 31) ? "sp" : `x${rn}`;

      let addrStr = `[${baseName}${offsetBytes !== 0 ? `, #${offsetBytes}` : ""}]`;
      if (preIndex) {
        addrStr = `[${baseName}, #${offsetBytes}]!`;
      } else if (postIndex) {
        addrStr = `[${baseName}], #${offsetBytes}`;
      }

      if (isVec) {
        const prefix = (opc === 0b10) ? "q" : (opc === 0b01) ? "d" : "s";
        const isQuad = (opc === 0b10);
        const type = lBit === 1
          ? (isQuad ? InstructionType.LDP_VREG : InstructionType.LDP_FREG)
          : (isQuad ? InstructionType.STP_VREG : InstructionType.STP_FREG);
        const mnem = lBit === 1 ? "ldp" : "stp";
        return {
          type,
          raw,
          opc,
          rt1,
          rt2,
          rn,
          offsetBytes,
          preIndex,
          postIndex,
          isVector: true,
          isDouble: opc === 0b01,
          isSingle: opc === 0b00,
          isQuad,
          disassembly: `${mnem} ${prefix}${rt1}, ${prefix}${rt2}, ${addrStr}`,
        };
      }

      const type = (lBit === 1) ? InstructionType.LDP : InstructionType.STP;
      const mnem = (lBit === 1) ? "ldp" : "stp";
      const gprPrefix = sf ? "x" : "w";

      return {
        type,
        raw,
        opc,
        sf,
        rt1,
        rt2,
        rn,
        offsetBytes,
        preIndex,
        postIndex,
        disassembly: `${mnem} ${gprPrefix}${rt1}, ${gprPrefix}${rt2}, ${addrStr}`,
      };
    }

    // 4.2 Load / Store Register (Single: Unsigned immediate, Unscaled LDUR/STUR, Pre/Post-index, and Register Offset)
    const size = (raw >>> 30) & 0b11;
    const opc = (raw >>> 22) & 0b11;
    const isUnsignedImm = ((raw >>> 24) & 1) === 1;
    const rn = (raw >>> 5) & 0x1f;
    const rt = raw & 0x1f;
    const baseName = (rn === 31) ? "sp" : `x${rn}`;

    let offsetBytes = 0;
    let preIndex = false;
    let postIndex = false;
    let unscaled = false;
    let isRegOffset = false;
    let rm = 0;
    let option = 0;
    let regShift = 0;
    let addrStr = "";

    const scale = isVec && size === 0b00 && (opc & 2) === 2 ? 4 : size;

    if (isUnsignedImm) {
      const imm12 = (raw >>> 10) & 0xfff;
      offsetBytes = imm12 << scale;
      addrStr = `[${baseName}${offsetBytes !== 0 ? `, #${offsetBytes}` : ""}]`;
    } else if (((raw >>> 21) & 1) === 0) {
      let imm9 = (raw >>> 12) & 0x1ff;
      if (imm9 & 0x100) imm9 -= 0x200; // sign-extend 9-bit byte offset
      offsetBytes = imm9;
      const addrMode = (raw >>> 10) & 0b11;
      if (addrMode === 0b00) {
        unscaled = true;
        addrStr = `[${baseName}${offsetBytes !== 0 ? `, #${offsetBytes}` : ""}]`;
      } else if (addrMode === 0b01) {
        postIndex = true;
        addrStr = `[${baseName}], #${offsetBytes}`;
      } else if (addrMode === 0b11) {
        preIndex = true;
        addrStr = `[${baseName}, #${offsetBytes}]!`;
      } else {
        return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown ldr/str 0x${raw.toString(16)}` };
      }
    } else if (((raw >>> 21) & 1) === 1 && ((raw >>> 10) & 0b11) === 0b10) {
      // Register Offset: [Xn, Rm{, extend {#amount}}]
      isRegOffset = true;
      rm = (raw >>> 16) & 0x1f;
      option = (raw >>> 13) & 0b111; // 010=uxtw, 011=lsl, 110=sxtw, 111=sxtx
      const sBit = (raw >>> 12) & 1;
      regShift = sBit ? scale : 0;
      const rmIs32 = (option === 0b010 || option === 0b110);
      const rmName = `${rmIs32 ? "w" : "x"}${rm}`;
      let extStr = "";
      if (option === 0b010) extStr = `, uxtw${regShift ? ` #${regShift}` : ""}`;
      else if (option === 0b110) extStr = `, sxtw${regShift ? ` #${regShift}` : ""}`;
      else if (option === 0b111) extStr = `, sxtx${regShift ? ` #${regShift}` : ""}`;
      else if (regShift > 0) extStr = `, lsl #${regShift}`;
      addrStr = `[${baseName}, ${rmName}${extStr}]`;
    } else {
      return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown ldr/str 0x${raw.toString(16)}` };
    }

    const commonProps = { raw, rt, rn, offsetBytes, preIndex, postIndex, unscaled, isRegOffset, rm, option, regShift };

    // Floating-Point and SIMD Single Load/Store
    if (isVec) {
      // 128-bit Vector (Q): size = 00, opc = 10 (STR) or 11 (LDR)
      if (size === 0b00 && (opc & 2) === 2) {
        const isLoad = (opc & 1) === 1;
        const type = isLoad ? InstructionType.LDR_VREG : InstructionType.STR_VREG;
        const mnem = unscaled ? (isLoad ? "ldur" : "stur") : (isLoad ? "ldr" : "str");
        return { type, ...commonProps, isVector: true, isQuad: true, disassembly: `${mnem} q${rt}, ${addrStr}` };
      }
      // 64-bit Double (D): size = 11
      if (size === 0b11) {
        const isLoad = opc === 0b01;
        const type = isLoad ? InstructionType.LDR_FREG : InstructionType.STR_FREG;
        const mnem = unscaled ? (isLoad ? "ldur" : "stur") : (isLoad ? "ldr" : "str");
        return { type, ...commonProps, isVector: true, isDouble: true, disassembly: `${mnem} d${rt}, ${addrStr}` };
      }
      // 32-bit Single (S): size = 10
      if (size === 0b10) {
        const isLoad = opc === 0b01;
        const type = isLoad ? InstructionType.LDR_FREG : InstructionType.STR_FREG;
        const mnem = unscaled ? (isLoad ? "ldur" : "stur") : (isLoad ? "ldr" : "str");
        return { type, ...commonProps, isVector: true, isSingle: true, disassembly: `${mnem} s${rt}, ${addrStr}` };
      }
    }

    // 64-bit: size = 11
    if (size === 0b11) {
      const mnemPrefix = unscaled ? (opc === 0b00 ? "stur" : "ldur") : (opc === 0b00 ? "str" : "ldr");
      if (opc === 0b00) {
        return { type: InstructionType.STR_IMM, ...commonProps, disassembly: `${mnemPrefix} x${rt}, ${addrStr}` };
      } else if (opc === 0b01) {
        return { type: InstructionType.LDR_IMM, ...commonProps, disassembly: `${mnemPrefix} x${rt}, ${addrStr}` };
      }
    }

    // 32-bit: size = 10 (opc=00 STRW, opc=01 LDRW, opc=10 LDRSW 64-bit sign-extended)
    if (size === 0b10) {
      if (opc === 0b00) {
        const mnem = unscaled ? "stur" : "str";
        return { type: InstructionType.STRW_IMM, ...commonProps, disassembly: `${mnem} w${rt}, ${addrStr}` };
      } else if (opc === 0b01) {
        const mnem = unscaled ? "ldur" : "ldr";
        return { type: InstructionType.LDRW_IMM, ...commonProps, disassembly: `${mnem} w${rt}, ${addrStr}` };
      } else if (opc === 0b10) {
        const mnem = unscaled ? "ldursw" : "ldrsw";
        return { type: InstructionType.LDRSW_IMM, ...commonProps, sf: 1, disassembly: `${mnem} x${rt}, ${addrStr}` };
      }
    }

    // 16-bit Halfword: size = 01 (opc=00 STRH, opc=01 LDRH, opc=10 LDRSH x, opc=11 LDRSH w)
    if (size === 0b01) {
      if (opc === 0b00) {
        const mnem = unscaled ? "sturh" : "strh";
        return { type: InstructionType.STRH_IMM, ...commonProps, disassembly: `${mnem} w${rt}, ${addrStr}` };
      } else if (opc === 0b01) {
        const mnem = unscaled ? "ldurh" : "ldrh";
        return { type: InstructionType.LDRH_IMM, ...commonProps, disassembly: `${mnem} w${rt}, ${addrStr}` };
      } else if (opc === 0b10 || opc === 0b11) {
        const sf = (opc === 0b10) ? 1 : 0;
        const mnem = unscaled ? "ldursh" : "ldrsh";
        return { type: InstructionType.LDRSH_IMM, ...commonProps, sf, disassembly: `${mnem} ${sf ? "x" : "w"}${rt}, ${addrStr}` };
      }
    }

    // 8-bit Byte: size = 00 (opc=00 STRB, opc=01 LDRB, opc=10 LDRSB x, opc=11 LDRSB w)
    if (size === 0b00) {
      if (opc === 0b00) {
        const mnem = unscaled ? "sturb" : "strb";
        return { type: InstructionType.STRB_IMM, ...commonProps, disassembly: `${mnem} w${rt}, ${addrStr}` };
      } else if (opc === 0b01) {
        const mnem = unscaled ? "ldurb" : "ldrb";
        return { type: InstructionType.LDRB_IMM, ...commonProps, disassembly: `${mnem} w${rt}, ${addrStr}` };
      } else if (opc === 0b10 || opc === 0b11) {
        const sf = (opc === 0b10) ? 1 : 0;
        const mnem = unscaled ? "ldursb" : "ldrsb";
        return { type: InstructionType.LDRSB_IMM, ...commonProps, sf, disassembly: `${mnem} ${sf ? "x" : "w"}${rt}, ${addrStr}` };
      }
    }

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown ldr/str 0x${raw.toString(16)}` };
  }

  // --- 5. Data Processing -- Scalar Floating-Point and Advanced SIMD ---
  static _decodeFloatAndNeon(raw) {
    const rd = raw & 0x1f;
    const rn = (raw >>> 5) & 0x1f;
    const rm = (raw >>> 16) & 0x1f;

    // 5.1 Scalar Floating-Point: bit 28 is 1 ((raw & 0x5f000000) === 0x1e000000)
    if ((raw & 0x5f000000) === 0x1e000000) {
      const ftype = (raw >>> 22) & 0b11; // 0=single (s), 1=double (d)
      const p = (ftype === 0) ? "s" : (ftype === 1) ? "d" : "h";
      const isDouble = (ftype === 1);
      const b15_10 = (raw >>> 10) & 0x3f;
      const b11_10 = (raw >>> 10) & 0x3;

      // (a) FP 2-source: bits [11:10] == 10
      if (b11_10 === 0b10) {
        const opcode = (raw >>> 12) & 0xf;
        let type = InstructionType.UNKNOWN;
        let mnem = "";

        if (opcode === 0b0000) { type = InstructionType.FMUL; mnem = "fmul"; }
        else if (opcode === 0b0001) { type = InstructionType.FDIV; mnem = "fdiv"; }
        else if (opcode === 0b0010) { type = InstructionType.FADD; mnem = "fadd"; }
        else if (opcode === 0b0011) { type = InstructionType.FSUB; mnem = "fsub"; }
        else if (opcode === 0b0100) { type = InstructionType.FMAX; mnem = "fmax"; }
        else if (opcode === 0b0101) { type = InstructionType.FMIN; mnem = "fmin"; }
        else if (opcode === 0b1000) { type = InstructionType.FNMUL; mnem = "fnmul"; }

        if (type !== InstructionType.UNKNOWN) {
          return { type, raw, ftype, isDouble, rd, rn, rm, disassembly: `${mnem} ${p}${rd}, ${p}${rn}, ${p}${rm}` };
        }
      }

      // (b) FP Compare: bits [15:10] == 001000 (0x08)
      if (b15_10 === 0x08) {
        const isZero = ((raw >>> 3) & 1) === 1;
        const disassembly = isZero ? `fcmp ${p}${rn}, #0.0` : `fcmp ${p}${rn}, ${p}${rm}`;
        return { type: InstructionType.FCMP, raw, ftype, isDouble, isZero, rn, rm, disassembly };
      }

      // (c) Conversions between Float and Integer & Bitwise FMOV GPR <-> FPR: bits [15:10] == 000000
      if (b15_10 === 0x00) {
        const sf = (raw >>> 31) & 1;
        const opcode = (raw >>> 16) & 0x1f;
        const gprPrefix = sf ? "x" : "w";

        if (opcode === 0b00000 || opcode === 0b11000) { // FCVTZS
          return { type: InstructionType.FCVTZS, raw, sf, ftype, isDouble, rd, rn, disassembly: `fcvtzs ${gprPrefix}${rd}, ${p}${rn}` };
        }
        if (opcode === 0b00001 || opcode === 0b11001) { // FCVTZU
          return { type: InstructionType.FCVTZU, raw, sf, ftype, isDouble, rd, rn, disassembly: `fcvtzu ${gprPrefix}${rd}, ${p}${rn}` };
        }
        if (opcode === 0b00010) { // SCVTF
          return { type: InstructionType.SCVTF, raw, sf, ftype, isDouble, rd, rn, disassembly: `scvtf ${p}${rd}, ${gprPrefix}${rn}` };
        }
        if (opcode === 0b00011) { // UCVTF
          return { type: InstructionType.UCVTF, raw, sf, ftype, isDouble, rd, rn, disassembly: `ucvtf ${p}${rd}, ${gprPrefix}${rn}` };
        }
        if (opcode === 0b00110) { // FMOV (FPR to GPR)
          return { type: InstructionType.FMOV, raw, sf, ftype, isDouble, isFprToGpr: true, rd, rn, disassembly: `fmov ${gprPrefix}${rd}, ${p}${rn}` };
        }
        if (opcode === 0b00111) { // FMOV (GPR to FPR)
          return { type: InstructionType.FMOV, raw, sf, ftype, isDouble, isGprToFpr: true, rd, rn, disassembly: `fmov ${p}${rd}, ${gprPrefix}${rn}` };
        }
      }

      // (d) FP 1-source: bits [14:10] == 10000 (0x10)
      if ((raw & 0x5f207c00) === 0x1e204000) {
        const opcode = (raw >>> 15) & 0x3f;
        if (opcode === 0b000000) {
          return { type: InstructionType.FMOV, raw, ftype, isDouble, rd, rn, disassembly: `fmov ${p}${rd}, ${p}${rn}` };
        }
        if (opcode === 0b000001) {
          return { type: InstructionType.FABS, raw, ftype, isDouble, rd, rn, disassembly: `fabs ${p}${rd}, ${p}${rn}` };
        }
        if (opcode === 0b000010) {
          return { type: InstructionType.FNEG, raw, ftype, isDouble, rd, rn, disassembly: `fneg ${p}${rd}, ${p}${rn}` };
        }
        if (opcode === 0b000011) {
          return { type: InstructionType.FSQRT, raw, ftype, isDouble, rd, rn, disassembly: `fsqrt ${p}${rd}, ${p}${rn}` };
        }
        if (opcode === 0b000100 || opcode === 0b000101) {
          // FCVT: precision conversion
          const dstDouble = (opcode === 0b000101) ? (ftype === 0) : !isDouble;
          const dstP = dstDouble ? "d" : "s";
          const srcP = isDouble ? "d" : "s";
          return { type: InstructionType.FCVT, raw, ftype, isDouble, dstDouble, rd, rn, disassembly: `fcvt ${dstP}${rd}, ${srcP}${rn}` };
        }
      }

      // (e) FP Immediate: bits [12:10] == 100 (0x04)
      if ((raw & 0x5f201fe0) === 0x1e201000 || b15_10 === 0x04) {
        const imm8 = (raw >>> 13) & 0xff;
        const sign = (imm8 >> 7) & 1;
        const exp = ((imm8 >> 4) & 7) ^ 4;
        const mant = imm8 & 0xf;
        const immValue = (sign ? -1 : 1) * (1 + mant / 16) * Math.pow(2, exp - 3);
        return { type: InstructionType.FMOV, raw, ftype, isDouble, isImm: true, immValue, rd, disassembly: `fmov ${p}${rd}, #${immValue}` };
      }
    }

    // 5.2 NEON / Advanced SIMD (bit 28 is 0)
    const Q = (raw >>> 30) & 1;
    const U = (raw >>> 29) & 1;
    const size = (raw >>> 22) & 0b11;
    const lanes = Q ? (size === 0 ? 16 : size === 1 ? 8 : size === 2 ? 4 : 2)
                    : (size === 0 ? 8 : size === 1 ? 4 : size === 2 ? 2 : 1);
    const elemStr = size === 0 ? "b" : size === 1 ? "h" : size === 2 ? "s" : "d";
    const arrStr = `${lanes}${elemStr}`;

    // (a) Advanced SIMD Copy / Splat (DUP, INS, UMOV): bits [23:21] == 000, bit 15 == 0, bit 10 == 1
    if ((raw & 0x9fe08400) === 0x0e000400) {
      const imm5 = (raw >>> 16) & 0x1f;
      const op = (raw >>> 29) & 1;
      let elemSize = -1;
      let lane = 0;

      if (imm5 & 1) { elemSize = 0; lane = imm5 >> 1; }
      else if (imm5 & 2) { elemSize = 1; lane = imm5 >> 2; }
      else if (imm5 & 4) { elemSize = 2; lane = imm5 >> 3; }
      else if (imm5 & 8) { elemSize = 3; lane = imm5 >> 4; }

      if (elemSize >= 0) {
        const subOp = (raw >>> 11) & 0xf;
        const eStr = elemSize === 0 ? "b" : elemSize === 1 ? "h" : elemSize === 2 ? "s" : "d";
        const lCount = Q ? (elemSize === 0 ? 16 : elemSize === 1 ? 8 : elemSize === 2 ? 4 : 2)
                         : (elemSize === 0 ? 8 : elemSize === 1 ? 4 : elemSize === 2 ? 2 : 1);
        const aStr = `${lCount}${eStr}`;

        // INS element to element: op == 1 && Q == 1
        if (op === 1 && Q === 1) {
          const srcLane = subOp >> elemSize;
          return { type: InstructionType.INS_ELEM, raw, elemSize, dstLane: lane, srcLane, rd, rn, disassembly: `ins v${rd}.${eStr}[${lane}], v${rn}.${eStr}[${srcLane}]` };
        }
        // DUP element: subOp == 0000
        if (subOp === 0b0000 && op === 0) {
          return { type: InstructionType.DUP_ELEM, raw, Q, elemSize, lane, rd, rn, disassembly: `dup v${rd}.${aStr}, v${rn}.${eStr}[${lane}]` };
        }
        // DUP general register: subOp == 0001
        if (subOp === 0b0001 && op === 0) {
          const gpr = (elemSize === 3) ? `x${rn}` : `w${rn}`;
          return { type: InstructionType.DUP_GEN, raw, Q, elemSize, rd, rn, disassembly: `dup v${rd}.${aStr}, ${gpr}` };
        }
        // INS general register into lane: subOp == 0011 && op == 0
        if (subOp === 0b0011 && op === 0) {
          const gpr = (elemSize === 3) ? `x${rn}` : `w${rn}`;
          return { type: InstructionType.INS_GEN, raw, elemSize, lane, rd, rn, disassembly: `ins v${rd}.${eStr}[${lane}], ${gpr}` };
        }
        // UMOV (extract vector lane to general register): subOp == 0111 && op == 0
        if (subOp === 0b0111 && op === 0) {
          const gpr = (elemSize === 3) ? `x${rd}` : `w${rd}`;
          return { type: InstructionType.UMOV_ELEM, raw, elemSize, lane, rd, rn, disassembly: `umov ${gpr}, v${rn}.${eStr}[${lane}]` };
        }
      }
    }

    // (b) NEON 2-register Misc (Float Neg, Float Abs, Bitwise NOT)
    const fSize = (raw >>> 22) & 1; // 0 = Single (S), 1 = Double (D)
    const floatLanes = Q ? (fSize === 0 ? 4 : 2) : (fSize === 0 ? 2 : 1);
    const floatArr = `${floatLanes}${fSize === 0 ? "s" : "d"}`;
    const byteArr = Q ? "16b" : "8b";

    if ((raw & 0xbfbffc00) === 0x2ea0f800) {
      return { type: InstructionType.FNEG_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, disassembly: `fneg v${rd}.${floatArr}, v${rn}.${floatArr}` };
    }
    if ((raw & 0xbfbffc00) === 0x0ea0f800) {
      return { type: InstructionType.FABS_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, disassembly: `fabs v${rd}.${floatArr}, v${rn}.${floatArr}` };
    }
    if ((raw & 0xbfbffc00) === 0x2e205800) {
      return { type: InstructionType.NOT_VEC, raw, Q, rd, rn, disassembly: `mvn v${rd}.${byteArr}, v${rn}.${byteArr}` };
    }

    // (c) NEON 3-same Vector Floating-Point (mask 0xbfa0fc00 checks bit 23 op and ignores bit 22 sz)
    if ((raw & 0xbfa0fc00) === 0x0e20d400) {
      return { type: InstructionType.FADD_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, rm, disassembly: `fadd v${rd}.${floatArr}, v${rn}.${floatArr}, v${rm}.${floatArr}` };
    }
    if ((raw & 0xbfa0fc00) === 0x0ea0d400) {
      return { type: InstructionType.FSUB_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, rm, disassembly: `fsub v${rd}.${floatArr}, v${rn}.${floatArr}, v${rm}.${floatArr}` };
    }
    if ((raw & 0xbfa0fc00) === 0x2e20dc00) {
      return { type: InstructionType.FMUL_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, rm, disassembly: `fmul v${rd}.${floatArr}, v${rn}.${floatArr}, v${rm}.${floatArr}` };
    }
    if ((raw & 0xbfa0fc00) === 0x2ea0fc00) {
      return { type: InstructionType.FDIV_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, rm, disassembly: `fdiv v${rd}.${floatArr}, v${rn}.${floatArr}, v${rm}.${floatArr}` };
    }
    if ((raw & 0xbfa0fc00) === 0x2e20d400) {
      return { type: InstructionType.FADDP_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, rm, disassembly: `faddp v${rd}.${floatArr}, v${rn}.${floatArr}, v${rm}.${floatArr}` };
    }
    if ((raw & 0xbfa0fc00) === 0x0e20f400) {
      return { type: InstructionType.FMAX_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, rm, disassembly: `fmax v${rd}.${floatArr}, v${rn}.${floatArr}, v${rm}.${floatArr}` };
    }
    if ((raw & 0xbfa0fc00) === 0x0ea0f400) {
      return { type: InstructionType.FMIN_VEC, raw, Q, size: fSize, isDouble: fSize === 1, lanes: floatLanes, rd, rn, rm, disassembly: `fmin v${rd}.${floatArr}, v${rn}.${floatArr}, v${rm}.${floatArr}` };
    }

    // (d) NEON 3-same Vector Integer Arithmetic & Logic
    if ((raw & 0xbf20fc00) === 0x0e208400) {
      return { type: InstructionType.ADD_VEC, raw, Q, size, lanes, rd, rn, rm, disassembly: `add v${rd}.${arrStr}, v${rn}.${arrStr}, v${rm}.${arrStr}` };
    }
    if ((raw & 0xbf20fc00) === 0x2e208400) {
      return { type: InstructionType.SUB_VEC, raw, Q, size, lanes, rd, rn, rm, disassembly: `sub v${rd}.${arrStr}, v${rn}.${arrStr}, v${rm}.${arrStr}` };
    }
    if ((raw & 0xbf20fc00) === 0x0e209c00) {
      return { type: InstructionType.MUL_VEC, raw, Q, size, lanes, rd, rn, rm, disassembly: `mul v${rd}.${arrStr}, v${rn}.${arrStr}, v${rm}.${arrStr}` };
    }
    if ((raw & 0xbf20fc00) === 0x0e20b400) {
      return { type: InstructionType.ADDP_VEC, raw, Q, size, lanes, rd, rn, rm, disassembly: `addp v${rd}.${arrStr}, v${rn}.${arrStr}, v${rm}.${arrStr}` };
    }
    if ((raw & 0xbfe0fc00) === 0x0e201c00) {
      return { type: InstructionType.AND_VEC, raw, Q, rd, rn, rm, disassembly: `and v${rd}.${byteArr}, v${rn}.${byteArr}, v${rm}.${byteArr}` };
    }
    if ((raw & 0xbfe0fc00) === 0x0ea01c00) {
      return { type: InstructionType.ORR_VEC, raw, Q, rd, rn, rm, disassembly: `orr v${rd}.${byteArr}, v${rn}.${byteArr}, v${rm}.${byteArr}` };
    }
    if ((raw & 0xbfe0fc00) === 0x2e201c00) {
      return { type: InstructionType.EOR_VEC, raw, Q, rd, rn, rm, disassembly: `eor v${rd}.${byteArr}, v${rn}.${byteArr}, v${rm}.${byteArr}` };
    }
    if ((raw & 0xbfe0fc00) === 0x2ea01c00) {
      return { type: InstructionType.NOT_VEC, raw, Q, rd, rn, disassembly: `mvn v${rd}.${byteArr}, v${rn}.${byteArr}` };
    }

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown fp/neon 0x${raw.toString(16)}` };
  }
}
