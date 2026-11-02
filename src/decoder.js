// decoder.js - ARM64 (AArch64) Instruction Decoder (~32 Base Integer Instructions)
// Converts raw 32-bit integers into structured instruction representations.

export const InstructionType = {
  // Data Processing - Immediate
  MOVZ: "MOVZ",
  MOVN: "MOVN",
  ADD_IMM: "ADD_IMM",
  SUB_IMM: "SUB_IMM",
  SUBS_IMM: "SUBS_IMM", // CMP imm is an alias of SUBS xzr, xn, #imm
  ADR: "ADR",           // Form PC-relative address

  // Data Processing - Register
  ADD_REG: "ADD_REG",
  SUB_REG: "SUB_REG",
  SUBS_REG: "SUBS_REG", // CMP reg is an alias of SUBS xzr, xn, xm
  AND_REG: "AND_REG",
  ORR_REG: "ORR_REG",   // MOV is an alias of ORR xd, xzr, xm
  EOR_REG: "EOR_REG",   // Exclusive OR (XOR)
  MVN_REG: "MVN_REG",   // Bitwise NOT (alias of ORN xd, xzr, xm)

  // Math (Multiply & Divide)
  MUL: "MUL",           // 64-bit multiply (MADD xd, xn, xm, xzr)
  SDIV: "SDIV",         // Signed 64-bit divide
  UDIV: "UDIV",         // Unsigned 64-bit divide

  // Shifts
  LSL: "LSL",           // Logical Shift Left
  LSR: "LSR",           // Logical Shift Right
  ASR: "ASR",           // Arithmetic Shift Right (preserves sign)

  // Loads & Stores (Single)
  LDR_IMM: "LDR_IMM",   // Load 64-bit register
  STR_IMM: "STR_IMM",   // Store 64-bit register
  LDRB_IMM: "LDRB_IMM", // Load 8-bit byte
  STRB_IMM: "STRB_IMM", // Store 8-bit byte
  LDRW_IMM: "LDRW_IMM", // Load 32-bit word
  STRW_IMM: "STRW_IMM", // Store 32-bit word

  // Loads & Stores (Pair / Stack Frames)
  STP: "STP",           // Store Pair 64-bit
  LDP: "LDP",           // Load Pair 64-bit

  // Branches & Calls
  B_COND: "B_COND",     // Conditional relative branch
  B: "B",               // Unconditional relative branch
  BL: "BL",             // Branch with Link (Function call)
  BR: "BR",             // Branch to register (Indirect jump)
  BLR: "BLR",           // Branch with Link to register (Function pointer call)
  RET: "RET",           // Return from subroutine (default to X30 / LR)

  // System
  SVC: "SVC",           // Supervisor Call (Syscall trap)

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

    return {
      type: InstructionType.UNKNOWN,
      raw,
      disassembly: `unknown (0x${raw.toString(16).padStart(8, "0")})`,
    };
  }

  // --- 1. Data Processing Immediate ---
  static _decodeDataProcessingImmediate(raw) {
    const op1 = (raw >>> 23) & 0b111;

    // ADR: bits [31:24] = 0x10
    if (((raw >>> 24) & 0x9f) === 0x10) {
      const immlo = (raw >>> 29) & 0x3;
      const immhi = (raw >>> 5) & 0x7ffff;
      const rd = raw & 0x1f;

      let imm21 = (immhi << 2) | immlo;
      if (imm21 & 0x100000) imm21 -= 0x200000;

      return {
        type: InstructionType.ADR,
        raw,
        rd,
        offsetBytes: imm21,
        disassembly: `adr x${rd}, [offset ${imm21 >= 0 ? "+" : ""}${imm21}B]`,
      };
    }

    // Move Wide Immediate (MOVZ / MOVN): op1 == 101
    if (op1 === 0b101) {
      const sf = (raw >>> 31) & 1;
      const opc = (raw >>> 29) & 0x3; // 10 = MOVZ, 00 = MOVN
      const hw = (raw >>> 21) & 0x3;
      const imm16 = (raw >>> 5) & 0xffff;
      const rd = raw & 0x1f;
      const shift = hw * 16;

      if (opc === 0b10) { // MOVZ
        const immValue = BigInt(imm16) << BigInt(shift);
        return {
          type: InstructionType.MOVZ,
          raw,
          rd,
          imm16,
          shift,
          immValue,
          disassembly: `movz x${rd}, #${imm16}${shift > 0 ? `, lsl #${shift}` : ""}`,
        };
      } else if (opc === 0b00) { // MOVN
        const base = BigInt(imm16) << BigInt(shift);
        const immValue = BigInt.asUintN(sf ? 64 : 32, ~base);
        return {
          type: InstructionType.MOVN,
          raw,
          rd,
          imm16,
          shift,
          immValue,
          disassembly: `movn x${rd}, #${imm16}${shift > 0 ? `, lsl #${shift}` : ""}`,
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

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown branch/sys 0x${raw.toString(16)}` };
  }

  // --- 3. Data Processing Register ---
  static _decodeDataProcessingRegister(raw) {
    const sf = (raw >>> 31) & 1;
    const op = (raw >>> 30) & 1;
    const s = (raw >>> 29) & 1;

    // Multiply / Divide (3-source or 2-source data processing)
    // MADD/MUL: bits [28:24] = 11011, bits [23:21] = 000
    if (((raw >>> 24) & 0b11111) === 0b11011) {
      const op31 = (raw >>> 21) & 0b111;
      const rm = (raw >>> 16) & 0x1f;
      const ra = (raw >>> 10) & 0x1f;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;

      if (op31 === 0b000 && ra === 31) { // MADD xd, xn, xm, xzr is MUL xd, xn, xm
        return {
          type: InstructionType.MUL,
          raw,
          rd,
          rn,
          rm,
          disassembly: `mul x${rd}, x${rn}, x${rm}`,
        };
      }
    }

    // Divide (SDIV / UDIV): bits [28:21] = 0b11010110, bits [15:10] = 00001x
    if (((raw >>> 21) & 0xff) === 0b11010110) {
      const rm = (raw >>> 16) & 0x1f;
      const opcode = (raw >>> 10) & 0b111111;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;

      if (opcode === 0b000010) { // UDIV
        return { type: InstructionType.UDIV, raw, rd, rn, rm, disassembly: `udiv x${rd}, x${rn}, x${rm}` };
      } else if (opcode === 0b000011) { // SDIV
        return { type: InstructionType.SDIV, raw, rd, rn, rm, disassembly: `sdiv x${rd}, x${rn}, x${rm}` };
      } else if (opcode === 0b001000) { // LSLV
        return { type: InstructionType.LSL, raw, rd, rn, rm, isRegShift: true, disassembly: `lsl x${rd}, x${rn}, x${rm}` };
      } else if (opcode === 0b001001) { // LSRV
        return { type: InstructionType.LSR, raw, rd, rn, rm, isRegShift: true, disassembly: `lsr x${rd}, x${rn}, x${rm}` };
      } else if (opcode === 0b001010) { // ASRV
        return { type: InstructionType.ASR, raw, rd, rn, rm, isRegShift: true, disassembly: `asr x${rd}, x${rn}, x${rm}` };
      }
    }

    // Add / Subtract (shifted register): bits [28:24] = 01011
    if (((raw >>> 24) & 0b11111) === 0b01011) {
      const shift = (raw >>> 22) & 0b11;
      const rm = (raw >>> 16) & 0x1f;
      const imm6 = (raw >>> 10) & 0x3f;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;

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
          disassembly: `add x${rd}, x${rn}, x${rm}${imm6 > 0 ? `, lsl #${imm6}` : ""}`,
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
          disassembly: `sub x${rd}, x${rn}, x${rm}${imm6 > 0 ? `, lsl #${imm6}` : ""}`,
        };
      } else if (op === 1 && s === 1) { // SUBS / CMP register
        const mnemonic = (rd === 31) ? "cmp" : "subs";
        const disasm = (rd === 31)
          ? `cmp x${rn}, x${rm}${imm6 > 0 ? `, lsl #${imm6}` : ""}`
          : `subs x${rd}, x${rn}, x${rm}${imm6 > 0 ? `, lsl #${imm6}` : ""}`;
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
      const rm = (raw >>> 16) & 0x1f;
      const imm6 = (raw >>> 10) & 0x3f;
      const rn = (raw >>> 5) & 0x1f;
      const rd = raw & 0x1f;
      const nBit = (raw >>> 21) & 1; // 1 for NOT (ORN, EON, BIC)

      // AND: op == 0, s == 0, N == 0
      if (op === 0 && s === 0 && nBit === 0) {
        return { type: InstructionType.AND_REG, raw, rd, rn, rm, disassembly: `and x${rd}, x${rn}, x${rm}` };
      }

      // ORR / MOV: op == 0, s == 1, N == 0
      if (op === 0 && s === 1 && nBit === 0) {
        const isMov = (rn === 31);
        return {
          type: InstructionType.ORR_REG,
          raw,
          rd,
          rn,
          rm,
          disassembly: isMov ? `mov x${rd}, x${rm}` : `orr x${rd}, x${rn}, x${rm}`,
        };
      }

      // MVN (ORN xd, xzr, xm): op == 0, s == 1, N == 1
      if (op === 0 && s === 1 && nBit === 1 && rn === 31) {
        return { type: InstructionType.MVN_REG, raw, rd, rm, disassembly: `mvn x${rd}, x${rm}` };
      }

      // EOR (XOR): op == 1, s == 0, N == 0
      if (op === 1 && s === 0 && nBit === 0) {
        return { type: InstructionType.EOR_REG, raw, rd, rn, rm, disassembly: `eor x${rd}, x${rn}, x${rm}` };
      }
    }

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown reg 0x${raw.toString(16)}` };
  }

  // --- 4. Loads and Stores ---
  static _decodeLoadsAndStores(raw) {
    // 4.1 Load / Store Pair (STP / LDP): bits [29:27] = 101
    // Addressing modes in bits [24:23]: 01 = Post-index, 10 = Signed offset, 11 = Pre-index
    if (((raw >>> 27) & 0b111) === 0b101) {
      const opc = (raw >>> 30) & 0b11;
      const addrMode = (raw >>> 23) & 0b11;
      const lBit = (raw >>> 22) & 1; // 0 = Store (STP), 1 = Load (LDP)
      let imm7 = (raw >>> 15) & 0x7f;
      if (imm7 & 0x40) imm7 -= 0x80; // sign extend 7 bits
      const offsetBytes = imm7 * 8; // 64-bit scaled by 8
      const rt2 = (raw >>> 10) & 0x1f;
      const rn = (raw >>> 5) & 0x1f;
      const rt1 = raw & 0x1f;

      const preIndex = (addrMode === 0b11);
      const postIndex = (addrMode === 0b01);
      const baseName = (rn === 31) ? "sp" : `x${rn}`;

      const type = (lBit === 1) ? InstructionType.LDP : InstructionType.STP;
      const mnem = (lBit === 1) ? "ldp" : "stp";

      let addrStr = `[${baseName}${offsetBytes !== 0 ? `, #${offsetBytes}` : ""}]`;
      if (preIndex) {
        addrStr = `[${baseName}, #${offsetBytes}]!`;
      } else if (postIndex) {
        addrStr = `[${baseName}], #${offsetBytes}`;
      }

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
        disassembly: `${mnem} x${rt1}, x${rt2}, ${addrStr}`,
      };
    }

    // 4.2 Load / Store Register (Unsigned immediate offset)
    const size = (raw >>> 30) & 0b11;
    const opc = (raw >>> 22) & 0b11;
    const imm12 = (raw >>> 10) & 0xfff;
    const rn = (raw >>> 5) & 0x1f;
    const rt = raw & 0x1f;
    const baseName = (rn === 31) ? "sp" : `x${rn}`;

    // 64-bit: size = 11, scale = 8
    if (size === 0b11) {
      const offsetBytes = imm12 * 8;
      if (opc === 0b00) { // STR 64-bit
        return { type: InstructionType.STR_IMM, raw, rt, rn, offsetBytes, disassembly: `str x${rt}, [${baseName}${offsetBytes > 0 ? `, #${offsetBytes}` : ""}]` };
      } else if (opc === 0b01) { // LDR 64-bit
        return { type: InstructionType.LDR_IMM, raw, rt, rn, offsetBytes, disassembly: `ldr x${rt}, [${baseName}${offsetBytes > 0 ? `, #${offsetBytes}` : ""}]` };
      }
    }

    // 32-bit: size = 10, scale = 4
    if (size === 0b10) {
      const offsetBytes = imm12 * 4;
      if (opc === 0b00) { // STRW 32-bit
        return { type: InstructionType.STRW_IMM, raw, rt, rn, offsetBytes, disassembly: `str w${rt}, [${baseName}${offsetBytes > 0 ? `, #${offsetBytes}` : ""}]` };
      } else if (opc === 0b01) { // LDRW 32-bit
        return { type: InstructionType.LDRW_IMM, raw, rt, rn, offsetBytes, disassembly: `ldr w${rt}, [${baseName}${offsetBytes > 0 ? `, #${offsetBytes}` : ""}]` };
      }
    }

    // 8-bit Byte: size = 00, scale = 1
    if (size === 0b00) {
      const offsetBytes = imm12;
      if (opc === 0b00) { // STRB 8-bit
        return { type: InstructionType.STRB_IMM, raw, rt, rn, offsetBytes, disassembly: `strb w${rt}, [${baseName}${offsetBytes > 0 ? `, #${offsetBytes}` : ""}]` };
      } else if (opc === 0b01) { // LDRB 8-bit
        return { type: InstructionType.LDRB_IMM, raw, rt, rn, offsetBytes, disassembly: `ldrb w${rt}, [${baseName}${offsetBytes > 0 ? `, #${offsetBytes}` : ""}]` };
      }
    }

    return { type: InstructionType.UNKNOWN, raw, disassembly: `unknown ldr/str 0x${raw.toString(16)}` };
  }
}
