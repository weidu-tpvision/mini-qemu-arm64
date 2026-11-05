// jit.js - Dynamic Just-In-Time (JIT) Compiler & Basic Block Execution Engine for ARM64
// Compiles hot ARM64 basic blocks into high-performance JavaScript functions on the fly.

import { Decoder, InstructionType, ConditionCode } from "./decoder.js";

/**
 * Condition Code evaluator string generator for JIT code emission.
 */
export function jitConditionExpr(cond) {
  switch (cond) {
    case ConditionCode.EQ: return "flags.Z";
    case ConditionCode.NE: return "!flags.Z";
    case ConditionCode.CS: return "flags.C";
    case ConditionCode.CC: return "!flags.C";
    case ConditionCode.MI: return "flags.N";
    case ConditionCode.PL: return "!flags.N";
    case ConditionCode.VS: return "flags.V";
    case ConditionCode.VC: return "!flags.V";
    case ConditionCode.HI: return "(flags.C && !flags.Z)";
    case ConditionCode.LS: return "(!flags.C || flags.Z)";
    case ConditionCode.GE: return "(flags.N === flags.V)";
    case ConditionCode.LT: return "(flags.N !== flags.V)";
    case ConditionCode.GT: return "(!flags.Z && (flags.N === flags.V))";
    case ConditionCode.LE: return "(flags.Z || (flags.N !== flags.V))";
    case ConditionCode.AL: return "true";
    default: return "true";
  }
}

/**
 * Checks whether an instruction type terminates a Basic Block.
 */
export function isBlockTerminator(type) {
  switch (type) {
    case InstructionType.B:
    case InstructionType.B_COND:
    case InstructionType.CBZ:
    case InstructionType.CBNZ:
    case InstructionType.TBZ:
    case InstructionType.TBNZ:
    case InstructionType.BL:
    case InstructionType.BR:
    case InstructionType.BLR:
    case InstructionType.RET:
    case InstructionType.SVC:
      return true;
    default:
      return false;
  }
}

export class JitCompiler {
  constructor(options = {}) {
    // Number of times a block must be entered before triggering JIT compilation
    this.hotThreshold = options.hotThreshold ?? 5;
    // Maximum number of instructions in a single compiled basic block
    this.maxBlockInstructions = options.maxBlockInstructions ?? 64;

    // Fast cache: startPC (Number) -> CompiledBlock
    this.blockCache = new Map();

    // Hotness profiling counters: startPC (Number) -> execution count
    this.hotCounters = new Map();

    // Statistics
    this.stats = {
      compilations: 0,
      blockExecutions: 0,
      jitCycles: 0,
      invalidations: 0,
      chainsFormed: 0,
      chainUnlinks: 0,
      chainExecutions: 0,
    };

    // Chain waiters: targetPC (Number) -> Set<CompiledBlock> waiting to link to target
    this.chainWaiters = new Map();
  }

  /**
   * Resets the JIT cache, chaining links, and hotness profiling counters.
   */
  reset() {
    this.clear();
    this.hotCounters.clear();
    this.stats.compilations = 0;
    this.stats.blockExecutions = 0;
    this.stats.jitCycles = 0;
    this.stats.invalidations = 0;
    this.stats.chainsFormed = 0;
    this.stats.chainUnlinks = 0;
    this.stats.chainExecutions = 0;
  }

  /**
   * Clears compiled block cache and unlinks all direct block chains, retaining hotness counters.
   */
  clear() {
    for (const block of this.blockCache.values()) {
      this.unlinkBlock(block);
    }
    this.blockCache.clear();
    this.chainWaiters.clear();
  }

  /**
   * Links a newly compiled block with any existing compiled successors and predecessors.
   */
  linkBlock(block) {
    // 1. Resolve outgoing links if target blocks are already compiled
    if (block.targetTakenPC !== null) {
      const target = this.blockCache.get(block.targetTakenPC);
      if (target) {
        block.linkTaken = target;
        target.incomingSources.add(block);
        this.stats.chainsFormed++;
      } else {
        if (!this.chainWaiters.has(block.targetTakenPC)) {
          this.chainWaiters.set(block.targetTakenPC, new Set());
        }
        this.chainWaiters.get(block.targetTakenPC).add(block);
      }
    }

    if (block.targetFallthroughPC !== null) {
      const target = this.blockCache.get(block.targetFallthroughPC);
      if (target) {
        block.linkFallthrough = target;
        target.incomingSources.add(block);
        this.stats.chainsFormed++;
      } else {
        if (!this.chainWaiters.has(block.targetFallthroughPC)) {
          this.chainWaiters.set(block.targetFallthroughPC, new Set());
        }
        this.chainWaiters.get(block.targetFallthroughPC).add(block);
      }
    }

    // 2. Check if any previously compiled blocks were waiting for this block's startPC
    if (this.chainWaiters.has(block.startPC)) {
      const waiters = this.chainWaiters.get(block.startPC);
      for (const srcBlock of waiters) {
        if (srcBlock.targetTakenPC === block.startPC) {
          srcBlock.linkTaken = block;
          block.incomingSources.add(srcBlock);
          this.stats.chainsFormed++;
        }
        if (srcBlock.targetFallthroughPC === block.startPC) {
          srcBlock.linkFallthrough = block;
          block.incomingSources.add(srcBlock);
          this.stats.chainsFormed++;
        }
      }
      this.chainWaiters.delete(block.startPC);
    }
  }

  /**
   * Unlinks all incoming and outgoing direct block links for a block being invalidated or removed.
   */
  unlinkBlock(block) {
    if (block.incomingSources) {
      for (const srcBlock of block.incomingSources) {
        if (srcBlock.linkTaken === block) {
          srcBlock.linkTaken = null;
          this.stats.chainUnlinks++;
        }
        if (srcBlock.linkFallthrough === block) {
          srcBlock.linkFallthrough = null;
          this.stats.chainUnlinks++;
        }
      }
      block.incomingSources.clear();
    }

    if (block.linkTaken) {
      block.linkTaken.incomingSources?.delete(block);
      block.linkTaken = null;
      this.stats.chainUnlinks++;
    }
    if (block.linkFallthrough) {
      block.linkFallthrough.incomingSources?.delete(block);
      block.linkFallthrough = null;
      this.stats.chainUnlinks++;
    }

    if (block.targetTakenPC !== null && this.chainWaiters.has(block.targetTakenPC)) {
      this.chainWaiters.get(block.targetTakenPC).delete(block);
    }
    if (block.targetFallthroughPC !== null && this.chainWaiters.has(block.targetFallthroughPC)) {
      this.chainWaiters.get(block.targetFallthroughPC).delete(block);
    }
  }

  /**
   * Invalidate any compiled blocks whose range [startPC, endPC) overlaps with [addr, addr + len).
   */
  invalidateRange(addr, len = 4) {
    const start = Number(addr);
    const end = start + Number(len);
    let count = 0;
    for (const [pc, block] of this.blockCache.entries()) {
      if (pc < end && block.endPC > start) {
        this.unlinkBlock(block);
        this.blockCache.delete(pc);
        count++;
      }
    }
    if (count > 0) {
      this.stats.invalidations += count;
    }
    return count;
  }

  /**
   * Extracts static branch target addresses from the terminating instruction of a basic block.
   */
  extractBlockTargets(instructions) {
    if (!instructions || instructions.length === 0) {
      return { targetTakenPC: null, targetFallthroughPC: null };
    }
    const last = instructions[instructions.length - 1];
    const d = last.decoded;
    switch (d.type) {
      case InstructionType.B:
        return { targetTakenPC: last.pc + d.offsetBytes, targetFallthroughPC: null };
      case InstructionType.B_COND:
      case InstructionType.CBZ:
      case InstructionType.CBNZ:
      case InstructionType.TBZ:
      case InstructionType.TBNZ:
        return { targetTakenPC: last.pc + d.offsetBytes, targetFallthroughPC: last.pc + 4 };
      case InstructionType.BL:
        return { targetTakenPC: last.pc + d.offsetBytes, targetFallthroughPC: null };
      default:
        if (!isBlockTerminator(d.type)) {
          return { targetTakenPC: null, targetFallthroughPC: last.pc + 4 };
        }
        return { targetTakenPC: null, targetFallthroughPC: null };
    }
  }

  /**
   * Fast lookup for a compiled block at guest PC.
   */
  getBlock(pc) {
    return this.blockCache.get(Number(pc));
  }

  /**
   * Records an execution entry at `pc`. Returns true if hotness threshold has been reached.
   */
  recordEntry(pc) {
    const numPC = Number(pc);
    const count = (this.hotCounters.get(numPC) || 0) + 1;
    this.hotCounters.set(numPC, count);
    return count >= this.hotThreshold;
  }

  /**
   * Disassembles a Basic Block starting from `startPC` until a branch, call, return, svc,
   * or unknown instruction is encountered, or max instructions is reached.
   */
  discoverBlock(startPC, memory, breakpoints = null) {
    const instructions = [];
    let curPC = Number(startPC);

    for (let i = 0; i < this.maxBlockInstructions; i++) {
      if (i > 0 && breakpoints && breakpoints.has(curPC)) {
        break; // Stop right before the breakpoint
      }

      let raw;
      try {
        raw = memory.read32(curPC);
      } catch {
        break; // Unmapped or boundary address
      }
      if (raw === 0) break;

      const decoded = Decoder.decode(raw);
      if (decoded.type === InstructionType.UNKNOWN) break;

      instructions.push({ pc: curPC, raw, decoded });
      curPC += 4;

      if (isBlockTerminator(decoded.type)) {
        break;
      }
    }

    return instructions;
  }

  /**
   * Compiles a Basic Block starting at `startPC` into a specialized JavaScript function.
   */
  compileBlock(startPC, memory, breakpoints = null) {
    const numPC = Number(startPC);
    if (this.blockCache.has(numPC)) {
      return this.blockCache.get(numPC);
    }

    const instructions = this.discoverBlock(numPC, memory, breakpoints);
    if (instructions.length === 0) {
      return null;
    }

    const endPC = instructions[instructions.length - 1].pc + 4;
    const bodySource = this.emitBlockJs(instructions, numPC);

    let fn;
    try {
      // Create high-speed closure function
      // Parameters: (cpu, memory, emu, instructions)
      fn = new Function("cpu", "memory", "emu", "instructions", bodySource);
    } catch (err) {
      console.error(`[JIT] Failed to compile block at 0x${numPC.toString(16)}:`, err);
      return null;
    }

    const { targetTakenPC, targetFallthroughPC } = this.extractBlockTargets(instructions);

    const compiledBlock = {
      startPC: numPC,
      endPC,
      instrCount: instructions.length,
      instructions,
      disassembly: instructions.map(i => `0x${i.pc.toString(16).padStart(8, "0")}: ${i.decoded.disassembly}`),
      fn: (cpu, memory, emu) => fn(cpu, memory, emu, instructions),
      source: bodySource,
      execCount: 0,
      chainedTarget: null,
      targetTakenPC,
      targetFallthroughPC,
      linkTaken: null,
      linkFallthrough: null,
      incomingSources: new Set(),
    };

    this.linkBlock(compiledBlock);
    this.blockCache.set(numPC, compiledBlock);
    this.stats.compilations++;
    return compiledBlock;
  }

  /**
   * Emits JavaScript source code for the list of instructions in the basic block.
   */
  emitBlockJs(instructions, startPC) {
    const lines = [];
    lines.push(`"use strict";`);
    lines.push(`// JIT Block [0x${startPC.toString(16).padStart(8, "0")} - ${instructions.length} instrs]`);
    lines.push(`const x = cpu.x;`);
    lines.push(`const flags = cpu.flags;`);
    lines.push(`const vBuffer = cpu.vBuffer;`);
    lines.push(`const vUint64 = cpu.vUint64;`);
    lines.push(`const vFloat32 = cpu.vFloat32;`);
    lines.push(`const vFloat64 = cpu.vFloat64;`);
    lines.push(`const vUint32 = cpu.vUint32;`);
    lines.push(`const vInt32 = cpu.vInt32;`);
    lines.push(`const vUint16 = cpu.vUint16;`);
    lines.push(`const vInt16 = cpu.vInt16;`);
    lines.push(`const vBytes = cpu.vBytes;`);
    lines.push(``);

    const regExpr = (r) => (r === 31 ? "0n" : `x[${r}]`);
    const spOrReg = (r) => (r === 31 ? "cpu.sp" : `x[${r}]`);

    const shiftedRmExpr = (d) => {
      const bits = d.sf === 0 ? 32 : 64;
      const rmBase = `BigInt.asUintN(${bits}, ${regExpr(d.rm)})`;
      if (!d.imm6) return rmBase;
      const amt = d.imm6 & (d.sf === 0 ? 0x1f : 0x3f);
      if (!amt) return rmBase;
      if (d.shift === 0b00) return `BigInt.asUintN(${bits}, ${rmBase} << ${amt}n)`;
      if (d.shift === 0b01) return `BigInt.asUintN(${bits}, ${rmBase} >> ${amt}n)`;
      if (d.shift === 0b10) return `BigInt.asUintN(${bits}, BigInt.asIntN(${bits}, ${rmBase}) >> ${amt}n)`;
      return rmBase;
    };

    for (let idx = 0; idx < instructions.length; idx++) {
      const { pc, decoded } = instructions[idx];
      const isLast = (idx === instructions.length - 1);
      const hexPC = `0x${pc.toString(16).padStart(8, "0")}`;
      lines.push(`// ${hexPC}: ${decoded.disassembly}`);

      switch (decoded.type) {
        // --- Data Processing: Immediate ---
        case InstructionType.MOVZ:
        case InstructionType.MOVN:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, ${decoded.immValue}n);`);
          }
          break;

        case InstructionType.MOVK:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, (x[${decoded.rd}] & ~(0xffffn << ${decoded.shift}n)) | (${BigInt(decoded.imm16) << BigInt(decoded.shift)}n));`);
          }
          break;

        case InstructionType.ADR:
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = 0x${(pc + decoded.offsetBytes).toString(16)}n;`);
          }
          break;

        case InstructionType.ADRP: {
          const pageBase = (pc & ~0xfff) + Number(decoded.offsetBytes);
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = 0x${pageBase.toString(16)}n;`);
          }
          break;
        }

        case InstructionType.ADD_IMM: {
          const bits = decoded.sf === 0 ? 32 : 64;
          if (decoded.rd === 31) {
            lines.push(`cpu.sp = BigInt.asUintN(64, ${spOrReg(decoded.rn)} + 0x${decoded.immValue.toString(16)}n);`);
          } else {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, BigInt.asUintN(${bits}, ${spOrReg(decoded.rn)}) + 0x${decoded.immValue.toString(16)}n);`);
          }
          break;
        }

        case InstructionType.SUB_IMM: {
          const bits = decoded.sf === 0 ? 32 : 64;
          if (decoded.rd === 31) {
            lines.push(`cpu.sp = BigInt.asUintN(64, ${spOrReg(decoded.rn)} - 0x${decoded.immValue.toString(16)}n);`);
          } else {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, BigInt.asUintN(${bits}, ${spOrReg(decoded.rn)}) - 0x${decoded.immValue.toString(16)}n);`);
          }
          break;
        }

        case InstructionType.SUBS_IMM: {
          lines.push(`{`);
          const bits = decoded.sf === 0 ? 32 : 64;
          const signBit = bits === 32 ? "0x80000000n" : "0x8000000000000000n";
          const minInt = bits === 32 ? "-0x80000000n" : "-0x8000000000000000n";
          const maxInt = bits === 32 ? "0x7fffffffn" : "0x7fffffffffffffffn";
          lines.push(`  const a = BigInt.asUintN(${bits}, ${spOrReg(decoded.rn)});`);
          lines.push(`  const b = BigInt.asUintN(${bits}, 0x${decoded.immValue.toString(16)}n);`);
          lines.push(`  const diff = a - b;`);
          lines.push(`  const res = BigInt.asUintN(${bits}, diff);`);
          if (decoded.rd !== 31) {
            lines.push(`  x[${decoded.rd}] = res;`);
          }
          lines.push(`  flags.Z = (res === 0n);`);
          lines.push(`  flags.N = ((res & ${signBit}) !== 0n);`);
          lines.push(`  flags.C = (a >= b);`);
          lines.push(`  const sA = BigInt.asIntN(${bits}, a);`);
          lines.push(`  const sB = BigInt.asIntN(${bits}, b);`);
          lines.push(`  const sDiff = sA - sB;`);
          lines.push(`  flags.V = (sDiff < ${minInt} || sDiff > ${maxInt});`);
          lines.push(`}`);
          break;
        }

        // --- Data Processing: Register ---
        case InstructionType.ADD_REG: {
          const bits = decoded.sf === 0 ? 32 : 64;
          const rnExpr = `BigInt.asUintN(${bits}, ${regExpr(decoded.rn)})`;
          const rmExpr = shiftedRmExpr(decoded);
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, ${rnExpr} + ${rmExpr});`);
          }
          break;
        }

        case InstructionType.SUB_REG: {
          const bits = decoded.sf === 0 ? 32 : 64;
          const rnExpr = `BigInt.asUintN(${bits}, ${regExpr(decoded.rn)})`;
          const rmExpr = shiftedRmExpr(decoded);
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, ${rnExpr} - ${rmExpr});`);
          }
          break;
        }

        case InstructionType.SUBS_REG: {
          lines.push(`{`);
          const bits = decoded.sf === 0 ? 32 : 64;
          const signBit = bits === 32 ? "0x80000000n" : "0x8000000000000000n";
          const minInt = bits === 32 ? "-0x80000000n" : "-0x8000000000000000n";
          const maxInt = bits === 32 ? "0x7fffffffn" : "0x7fffffffffffffffn";
          const rnExpr = `BigInt.asUintN(${bits}, ${regExpr(decoded.rn)})`;
          const rmExpr = shiftedRmExpr(decoded);
          lines.push(`  const a = ${rnExpr};`);
          lines.push(`  const b = ${rmExpr};`);
          lines.push(`  const diff = a - b;`);
          lines.push(`  const res = BigInt.asUintN(${bits}, diff);`);
          if (decoded.rd !== 31) {
            lines.push(`  x[${decoded.rd}] = res;`);
          }
          lines.push(`  flags.Z = (res === 0n);`);
          lines.push(`  flags.N = ((res & ${signBit}) !== 0n);`);
          lines.push(`  flags.C = (a >= b);`);
          lines.push(`  const sA = BigInt.asIntN(${bits}, a);`);
          lines.push(`  const sB = BigInt.asIntN(${bits}, b);`);
          lines.push(`  const sDiff = sA - sB;`);
          lines.push(`  flags.V = (sDiff < ${minInt} || sDiff > ${maxInt});`);
          lines.push(`}`);
          break;
        }

        case InstructionType.AND_REG: {
          const bits = decoded.sf === 0 ? 32 : 64;
          const rnExpr = `BigInt.asUintN(${bits}, ${regExpr(decoded.rn)})`;
          const rmExpr = shiftedRmExpr(decoded);
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, ${rnExpr} & ${rmExpr});`);
          }
          break;
        }

        case InstructionType.ORR_REG: {
          const bits = decoded.sf === 0 ? 32 : 64;
          const rnExpr = `BigInt.asUintN(${bits}, ${regExpr(decoded.rn)})`;
          const rmExpr = shiftedRmExpr(decoded);
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, ${rnExpr} | ${rmExpr});`);
          }
          break;
        }

        case InstructionType.EOR_REG: {
          const bits = decoded.sf === 0 ? 32 : 64;
          const rnExpr = `BigInt.asUintN(${bits}, ${regExpr(decoded.rn)})`;
          const rmExpr = shiftedRmExpr(decoded);
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, ${rnExpr} ^ ${rmExpr});`);
          }
          break;
        }

        case InstructionType.MVN_REG: {
          const bits = decoded.sf === 0 ? 32 : 64;
          const rmExpr = shiftedRmExpr(decoded);
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, ~${rmExpr});`);
          }
          break;
        }

        // --- Math & Division ---
        case InstructionType.MUL:
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${decoded.sf === 0 ? 32 : 64}, ${regExpr(decoded.rn)} * ${regExpr(decoded.rm)});`);
          }
          break;

        case InstructionType.MADD:
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${decoded.sf === 0 ? 32 : 64}, ${regExpr(decoded.ra)} + (${regExpr(decoded.rn)} * ${regExpr(decoded.rm)}));`);
          }
          break;

        case InstructionType.MSUB:
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${decoded.sf === 0 ? 32 : 64}, ${regExpr(decoded.ra)} - (${regExpr(decoded.rn)} * ${regExpr(decoded.rm)}));`);
          }
          break;

        case InstructionType.UDIV:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`{ const a = BigInt.asUintN(${bits}, ${regExpr(decoded.rn)}); const d = BigInt.asUintN(${bits}, ${regExpr(decoded.rm)}); x[${decoded.rd}] = d === 0n ? 0n : BigInt.asUintN(${bits}, a / d); }`);
          }
          break;

        case InstructionType.SDIV:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`{ const d = BigInt.asIntN(${bits}, ${regExpr(decoded.rm)}); x[${decoded.rd}] = d === 0n ? 0n : BigInt.asUintN(${bits}, BigInt.asIntN(${bits}, ${regExpr(decoded.rn)}) / d); }`);
          }
          break;

        // --- Shifts & Bitfield Moves ---
        case InstructionType.LSL:
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${decoded.sf === 0 ? 32 : 64}, ${regExpr(decoded.rn)} << (${regExpr(decoded.rm)} & ${decoded.sf === 0 ? 31 : 63}n));`);
          }
          break;

        case InstructionType.LSR:
          if (decoded.rd !== 31) {
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${decoded.sf === 0 ? 32 : 64}, ${regExpr(decoded.rn)}) >> (${regExpr(decoded.rm)} & ${decoded.sf === 0 ? 31 : 63}n);`);
          }
          break;

        case InstructionType.ASR:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, BigInt.asIntN(${bits}, ${regExpr(decoded.rn)}) >> (${regExpr(decoded.rm)} & ${decoded.sf === 0 ? 31 : 63}n));`);
          }
          break;

        case InstructionType.UBFM:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, emu.applyUBFM(${regExpr(decoded.rn)}, ${decoded.immr}, ${decoded.imms}, ${bits}));`);
          }
          break;

        case InstructionType.SBFM:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = BigInt.asUintN(${bits}, emu.applySBFM(${regExpr(decoded.rn)}, ${decoded.immr}, ${decoded.imms}, ${bits}));`);
          }
          break;

        // --- Conditionals ---
        case InstructionType.CSEL:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = ${jitConditionExpr(decoded.cond)} ? BigInt.asUintN(${bits}, ${regExpr(decoded.rn)}) : BigInt.asUintN(${bits}, ${regExpr(decoded.rm)});`);
          }
          break;

        case InstructionType.CSINC:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = ${jitConditionExpr(decoded.cond)} ? BigInt.asUintN(${bits}, ${regExpr(decoded.rn)}) : BigInt.asUintN(${bits}, ${regExpr(decoded.rm)} + 1n);`);
          }
          break;

        case InstructionType.CSINV:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = ${jitConditionExpr(decoded.cond)} ? BigInt.asUintN(${bits}, ${regExpr(decoded.rn)}) : BigInt.asUintN(${bits}, ~${regExpr(decoded.rm)});`);
          }
          break;

        case InstructionType.CSNEG:
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`x[${decoded.rd}] = ${jitConditionExpr(decoded.cond)} ? BigInt.asUintN(${bits}, ${regExpr(decoded.rn)}) : BigInt.asUintN(${bits}, -${regExpr(decoded.rm)});`);
          }
          break;

        // --- Loads and Stores (Single) ---
        case InstructionType.LDR_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.rt !== 31) {
            lines.push(`  x[${decoded.rt}] = memory.read64(addr);`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STR_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          lines.push(`  memory.write64(addr, ${regExpr(decoded.rt)});`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDRW_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.rt !== 31) {
            lines.push(`  x[${decoded.rt}] = BigInt(memory.read32(addr) >>> 0);`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STRW_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          lines.push(`  memory.write32(addr, Number(${regExpr(decoded.rt)} & 0xffffffffn));`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDRSW_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.rt !== 31) {
            lines.push(`  x[${decoded.rt}] = BigInt.asUintN(64, BigInt(memory.read32(addr) | 0));`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDRH_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.rt !== 31) {
            lines.push(`  x[${decoded.rt}] = BigInt(memory.read16(addr) & 0xffff);`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STRH_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          lines.push(`  memory.write16(addr, Number(${regExpr(decoded.rt)} & 0xffffn));`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDRSH_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.rt !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`  const h = memory.read16(addr);`);
            lines.push(`  const sh = (h & 0x8000) ? (h | ~0xffff) : h;`);
            lines.push(`  x[${decoded.rt}] = BigInt.asUintN(${bits}, BigInt(sh));`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDRB_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.rt !== 31) {
            lines.push(`  x[${decoded.rt}] = BigInt(memory.read8(addr));`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STRB_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          lines.push(`  memory.write8(addr, Number(${regExpr(decoded.rt)} & 0xffn));`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDRSB_IMM: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.rt !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`  const b = memory.read8(addr);`);
            lines.push(`  const sb = (b & 0x80) ? (b | ~0xff) : b;`);
            lines.push(`  x[${decoded.rt}] = BigInt.asUintN(${bits}, BigInt(sb));`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        // --- Loads and Stores (Pair / Stack Frames) ---
        case InstructionType.STP: {
          lines.push(`{`);
          lines.push(`  const base = Number(${spOrReg(decoded.rn)});`);
          lines.push(`  const target = ${decoded.postIndex ? "base" : `base + ${decoded.offsetBytes}`};`);
          if (decoded.sf === 0) {
            lines.push(`  memory.write32(target, Number(${regExpr(decoded.rt1)} & 0xffffffffn));`);
            lines.push(`  memory.write32(target + 4, Number(${regExpr(decoded.rt2)} & 0xffffffffn));`);
          } else {
            lines.push(`  memory.write64(target, ${regExpr(decoded.rt1)});`);
            lines.push(`  memory.write64(target + 8, ${regExpr(decoded.rt2)});`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(base + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDP: {
          lines.push(`{`);
          lines.push(`  const base = Number(${spOrReg(decoded.rn)});`);
          lines.push(`  const target = ${decoded.postIndex ? "base" : `base + ${decoded.offsetBytes}`};`);
          if (decoded.sf === 0) {
            if (decoded.rt1 !== 31) lines.push(`  x[${decoded.rt1}] = BigInt(memory.read32(target) >>> 0);`);
            if (decoded.rt2 !== 31) lines.push(`  x[${decoded.rt2}] = BigInt(memory.read32(target + 4) >>> 0);`);
          } else {
            if (decoded.rt1 !== 31) lines.push(`  x[${decoded.rt1}] = memory.read64(target);`);
            if (decoded.rt2 !== 31) lines.push(`  x[${decoded.rt2}] = memory.read64(target + 8);`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(base + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        // --- Floating-Point Scalar Loads and Stores ---
        case InstructionType.LDR_FREG: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.isDouble) {
            lines.push(`  vFloat64[${decoded.rt} * 2] = memory.readFloat64(addr);`);
            lines.push(`  vUint64[${decoded.rt} * 2 + 1] = 0n;`);
          } else {
            lines.push(`  vFloat32[${decoded.rt} * 4] = memory.readFloat32(addr);`);
            lines.push(`  vUint32[${decoded.rt} * 4 + 1] = 0;`);
            lines.push(`  vUint64[${decoded.rt} * 2 + 1] = 0n;`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STR_FREG: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          if (decoded.isDouble) {
            lines.push(`  memory.writeFloat64(addr, vFloat64[${decoded.rt} * 2]);`);
          } else {
            lines.push(`  memory.writeFloat32(addr, vFloat32[${decoded.rt} * 4]);`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDR_VREG: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          lines.push(`  const baseIdx = ${decoded.rt} * 16;`);
          lines.push(`  for (let i = 0; i < 16; i++) vBytes[baseIdx + i] = memory.read8(addr + i);`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STR_VREG: {
          lines.push(`{`);
          if (decoded.isRegOffset) {
            lines.push(`  const { baseAddr, targetAddr } = emu.computeLoadStoreAddr(instructions[${idx}].decoded);`);
            lines.push(`  const addr = targetAddr;`);
          } else {
            lines.push(`  const baseAddr = Number(${spOrReg(decoded.rn)});`);
            lines.push(`  const targetAddr = ${decoded.postIndex ? "baseAddr" : `baseAddr + ${decoded.offsetBytes}`};`);
            lines.push(`  const addr = targetAddr;`);
          }
          lines.push(`  const baseIdx = ${decoded.rt} * 16;`);
          lines.push(`  for (let i = 0; i < 16; i++) memory.write8(addr + i, vBytes[baseIdx + i]);`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(baseAddr + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STP_FREG: {
          lines.push(`{`);
          lines.push(`  const base = Number(${spOrReg(decoded.rn)});`);
          lines.push(`  const target = ${decoded.postIndex ? "base" : `base + ${decoded.offsetBytes}`};`);
          if (decoded.isDouble) {
            lines.push(`  memory.writeFloat64(target, vFloat64[${decoded.rt1} * 2]);`);
            lines.push(`  memory.writeFloat64(target + 8, vFloat64[${decoded.rt2} * 2]);`);
          } else {
            lines.push(`  memory.writeFloat32(target, vFloat32[${decoded.rt1} * 4]);`);
            lines.push(`  memory.writeFloat32(target + 4, vFloat32[${decoded.rt2} * 4]);`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(base + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDP_FREG: {
          lines.push(`{`);
          lines.push(`  const base = Number(${spOrReg(decoded.rn)});`);
          lines.push(`  const target = ${decoded.postIndex ? "base" : `base + ${decoded.offsetBytes}`};`);
          if (decoded.isDouble) {
            lines.push(`  vFloat64[${decoded.rt1} * 2] = memory.readFloat64(target);`);
            lines.push(`  vUint64[${decoded.rt1} * 2 + 1] = 0n;`);
            lines.push(`  vFloat64[${decoded.rt2} * 2] = memory.readFloat64(target + 8);`);
            lines.push(`  vUint64[${decoded.rt2} * 2 + 1] = 0n;`);
          } else {
            lines.push(`  vFloat32[${decoded.rt1} * 4] = memory.readFloat32(target);`);
            lines.push(`  vUint32[${decoded.rt1} * 4 + 1] = 0;`);
            lines.push(`  vUint64[${decoded.rt1} * 2 + 1] = 0n;`);
            lines.push(`  vFloat32[${decoded.rt2} * 4] = memory.readFloat32(target + 4);`);
            lines.push(`  vUint32[${decoded.rt2} * 4 + 1] = 0;`);
            lines.push(`  vUint64[${decoded.rt2} * 2 + 1] = 0n;`);
          }
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(base + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STP_VREG: {
          lines.push(`{`);
          lines.push(`  const base = Number(${spOrReg(decoded.rn)});`);
          lines.push(`  const target = ${decoded.postIndex ? "base" : `base + ${decoded.offsetBytes}`};`);
          lines.push(`  const b1 = ${decoded.rt1} * 16, b2 = ${decoded.rt2} * 16;`);
          lines.push(`  for (let i = 0; i < 16; i++) { memory.write8(target + i, vBytes[b1 + i]); memory.write8(target + 16 + i, vBytes[b2 + i]); }`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(base + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.LDP_VREG: {
          lines.push(`{`);
          lines.push(`  const base = Number(${spOrReg(decoded.rn)});`);
          lines.push(`  const target = ${decoded.postIndex ? "base" : `base + ${decoded.offsetBytes}`};`);
          lines.push(`  const b1 = ${decoded.rt1} * 16, b2 = ${decoded.rt2} * 16;`);
          lines.push(`  for (let i = 0; i < 16; i++) { vBytes[b1 + i] = memory.read8(target + i); vBytes[b2 + i] = memory.read8(target + 16 + i); }`);
          if (decoded.preIndex || decoded.postIndex) {
            lines.push(`  ${spOrReg(decoded.rn)} = BigInt.asUintN(64, BigInt(base + ${decoded.offsetBytes}));`);
          }
          lines.push(`}`);
          break;
        }

        // --- Scalar Floating-Point Arithmetic ---
        case InstructionType.FADD:
        case InstructionType.FSUB:
        case InstructionType.FMUL:
        case InstructionType.FDIV:
        case InstructionType.FNMUL:
        case InstructionType.FMAX:
        case InstructionType.FMIN: {
          const isD = decoded.isDouble;
          const vArr = isD ? "vFloat64" : "vFloat32";
          const scale = isD ? 2 : 4;
          const a = `${vArr}[${decoded.rn} * ${scale}]`;
          const b = `${vArr}[${decoded.rm} * ${scale}]`;
          let opExpr = "";
          switch (decoded.type) {
            case InstructionType.FADD: opExpr = `${a} + ${b}`; break;
            case InstructionType.FSUB: opExpr = `${a} - ${b}`; break;
            case InstructionType.FMUL: opExpr = `${a} * ${b}`; break;
            case InstructionType.FDIV: opExpr = `${a} / ${b}`; break;
            case InstructionType.FNMUL: opExpr = `-(${a} * ${b})`; break;
            case InstructionType.FMAX: opExpr = `Math.max(${a}, ${b})`; break;
            case InstructionType.FMIN: opExpr = `Math.min(${a}, ${b})`; break;
          }
          lines.push(`${vArr}[${decoded.rd} * ${scale}] = ${opExpr};`);
          if (isD) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          } else {
            lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.FNEG:
        case InstructionType.FABS:
        case InstructionType.FSQRT: {
          const isD = decoded.isDouble;
          const vArr = isD ? "vFloat64" : "vFloat32";
          const scale = isD ? 2 : 4;
          const a = `${vArr}[${decoded.rn} * ${scale}]`;
          let opExpr = "";
          if (decoded.type === InstructionType.FNEG) opExpr = `-${a}`;
          else if (decoded.type === InstructionType.FABS) opExpr = `Math.abs(${a})`;
          else if (decoded.type === InstructionType.FSQRT) opExpr = `Math.sqrt(${a})`;

          lines.push(`${vArr}[${decoded.rd} * ${scale}] = ${opExpr};`);
          if (isD) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          } else {
            lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.FCMP: {
          const isD = decoded.isDouble;
          const vArr = isD ? "vFloat64" : "vFloat32";
          const scale = isD ? 2 : 4;
          const v1 = `${vArr}[${decoded.rn} * ${scale}]`;
          const v2 = decoded.isZero ? "0.0" : `${vArr}[${decoded.rm} * ${scale}]`;
          lines.push(`{`);
          lines.push(`  const a = ${v1}, b = ${v2};`);
          lines.push(`  if (Number.isNaN(a) || Number.isNaN(b)) { flags.N = false; flags.Z = false; flags.C = false; flags.V = true; }`);
          lines.push(`  else if (a === b) { flags.N = false; flags.Z = true; flags.C = true; flags.V = false; }`);
          lines.push(`  else if (a < b) { flags.N = true; flags.Z = false; flags.C = false; flags.V = false; }`);
          lines.push(`  else { flags.N = false; flags.Z = false; flags.C = true; flags.V = false; }`);
          lines.push(`}`);
          break;
        }

        case InstructionType.FCVT: {
          if (decoded.dstDouble) {
            lines.push(`vFloat64[${decoded.rd} * 2] = vFloat32[${decoded.rn} * 4];`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          } else {
            lines.push(`vFloat32[${decoded.rd} * 4] = vFloat64[${decoded.rn} * 2];`);
            lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.SCVTF: {
          const intVal = decoded.sf === 0 ? `Number(BigInt.asIntN(32, ${regExpr(decoded.rn)}))` : `Number(BigInt.asIntN(64, ${regExpr(decoded.rn)}))`;
          if (decoded.isDouble) {
            lines.push(`vFloat64[${decoded.rd} * 2] = ${intVal};`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          } else {
            lines.push(`vFloat32[${decoded.rd} * 4] = ${intVal};`);
            lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.UCVTF: {
          const uintVal = decoded.sf === 0 ? `Number(BigInt.asUintN(32, ${regExpr(decoded.rn)}))` : `Number(BigInt.asUintN(64, ${regExpr(decoded.rn)}))`;
          if (decoded.isDouble) {
            lines.push(`vFloat64[${decoded.rd} * 2] = ${uintVal};`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          } else {
            lines.push(`vFloat32[${decoded.rd} * 4] = ${uintVal};`);
            lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.FCVTZS: {
          const fVal = decoded.isDouble ? `vFloat64[${decoded.rn} * 2]` : `vFloat32[${decoded.rn} * 4]`;
          const bits = decoded.sf === 0 ? 32 : 64;
          const maxInt = bits === 32 ? "0x7fffffffn" : "0x7fffffffffffffffn";
          const minInt = bits === 32 ? "-0x80000000n" : "-0x8000000000000000n";
          if (decoded.rd !== 31) {
            lines.push(`{ const f = ${fVal}; let res = 0n; if (!Number.isNaN(f)) { if (f >= Number(${maxInt})) res = ${maxInt}; else if (f <= Number(${minInt})) res = ${minInt}; else res = BigInt(Math.trunc(f)); } x[${decoded.rd}] = BigInt.asUintN(${bits}, res); }`);
          }
          break;
        }

        case InstructionType.FCVTZU: {
          const fVal = decoded.isDouble ? `vFloat64[${decoded.rn} * 2]` : `vFloat32[${decoded.rn} * 4]`;
          const bits = decoded.sf === 0 ? 32 : 64;
          const maxUint = bits === 32 ? "0xffffffffn" : "0xffffffffffffffffn";
          if (decoded.rd !== 31) {
            lines.push(`{ const f = ${fVal}; let res = 0n; if (!Number.isNaN(f) && f > 0) { if (f >= Number(${maxUint})) res = ${maxUint}; else res = BigInt(Math.trunc(f)); } x[${decoded.rd}] = BigInt.asUintN(${bits}, res); }`);
          }
          break;
        }

        case InstructionType.FMOV: {
          if (decoded.isImm) {
            if (decoded.isDouble) {
              lines.push(`vFloat64[${decoded.rd} * 2] = ${decoded.immValue};`);
              lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
            } else {
              lines.push(`vFloat32[${decoded.rd} * 4] = ${decoded.immValue};`);
              lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
              lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
            }
          } else if (decoded.isGprToFpr) {
            if (decoded.isDouble) {
              lines.push(`vUint64[${decoded.rd} * 2] = ${regExpr(decoded.rn)};`);
              lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
            } else {
              lines.push(`vUint32[${decoded.rd} * 4] = Number(${regExpr(decoded.rn)} & 0xffffffffn) >>> 0;`);
              lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
              lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
            }
          } else if (decoded.isFprToGpr) {
            if (decoded.rd !== 31) {
              if (decoded.isDouble) {
                lines.push(`x[${decoded.rd}] = vUint64[${decoded.rn} * 2];`);
              } else {
                lines.push(`x[${decoded.rd}] = BigInt(vUint32[${decoded.rn} * 4] >>> 0);`);
              }
            }
          } else {
            if (decoded.isDouble) {
              lines.push(`vFloat64[${decoded.rd} * 2] = vFloat64[${decoded.rn} * 2];`);
              lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
            } else {
              lines.push(`vFloat32[${decoded.rd} * 4] = vFloat32[${decoded.rn} * 4];`);
              lines.push(`vUint32[${decoded.rd} * 4 + 1] = 0;`);
              lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
            }
          }
          break;
        }

        // --- NEON Vector Instructions ---
        case InstructionType.FNEG_VEC:
        case InstructionType.FABS_VEC: {
          const lanes = decoded.lanes;
          const isD = decoded.isDouble;
          const vArr = isD ? "vFloat64" : "vFloat32";
          const scale = isD ? 2 : 4;
          for (let l = 0; l < lanes; l++) {
            const a = `${vArr}[${decoded.rn} * ${scale} + ${l}]`;
            const op = decoded.type === InstructionType.FNEG_VEC ? `-${a}` : `Math.abs(${a})`;
            lines.push(`${vArr}[${decoded.rd} * ${scale} + ${l}] = ${op};`);
          }
          if (!decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.FADD_VEC:
        case InstructionType.FSUB_VEC:
        case InstructionType.FMUL_VEC:
        case InstructionType.FDIV_VEC:
        case InstructionType.FMAX_VEC:
        case InstructionType.FMIN_VEC: {
          const lanes = decoded.lanes;
          const isD = decoded.isDouble;
          const vArr = isD ? "vFloat64" : "vFloat32";
          const scale = isD ? 2 : 4;
          for (let l = 0; l < lanes; l++) {
            const a = `${vArr}[${decoded.rn} * ${scale} + ${l}]`;
            const b = `${vArr}[${decoded.rm} * ${scale} + ${l}]`;
            let op = "";
            switch (decoded.type) {
              case InstructionType.FADD_VEC: op = `${a} + ${b}`; break;
              case InstructionType.FSUB_VEC: op = `${a} - ${b}`; break;
              case InstructionType.FMUL_VEC: op = `${a} * ${b}`; break;
              case InstructionType.FDIV_VEC: op = `${a} / ${b}`; break;
              case InstructionType.FMAX_VEC: op = `Math.max(${a}, ${b})`; break;
              case InstructionType.FMIN_VEC: op = `Math.min(${a}, ${b})`; break;
            }
            lines.push(`${vArr}[${decoded.rd} * ${scale} + ${l}] = ${op};`);
          }
          if (!decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.FADDP_VEC: {
          if (decoded.isDouble) {
            lines.push(`{`);
            lines.push(`  const a0 = vFloat64[${decoded.rn} * 2], a1 = vFloat64[${decoded.rn} * 2 + 1];`);
            lines.push(`  const b0 = vFloat64[${decoded.rm} * 2], b1 = vFloat64[${decoded.rm} * 2 + 1];`);
            lines.push(`  vFloat64[${decoded.rd} * 2] = a0 + a1;`);
            lines.push(`  vFloat64[${decoded.rd} * 2 + 1] = b0 + b1;`);
            lines.push(`}`);
          } else if (decoded.Q) {
            lines.push(`{`);
            lines.push(`  const p0 = vFloat32[${decoded.rn} * 4] + vFloat32[${decoded.rn} * 4 + 1];`);
            lines.push(`  const p1 = vFloat32[${decoded.rn} * 4 + 2] + vFloat32[${decoded.rn} * 4 + 3];`);
            lines.push(`  const p2 = vFloat32[${decoded.rm} * 4] + vFloat32[${decoded.rm} * 4 + 1];`);
            lines.push(`  const p3 = vFloat32[${decoded.rm} * 4 + 2] + vFloat32[${decoded.rm} * 4 + 3];`);
            lines.push(`  vFloat32[${decoded.rd} * 4] = p0; vFloat32[${decoded.rd} * 4 + 1] = p1;`);
            lines.push(`  vFloat32[${decoded.rd} * 4 + 2] = p2; vFloat32[${decoded.rd} * 4 + 3] = p3;`);
            lines.push(`}`);
          } else {
            lines.push(`{`);
            lines.push(`  const p0 = vFloat32[${decoded.rn} * 4] + vFloat32[${decoded.rn} * 4 + 1];`);
            lines.push(`  const p1 = vFloat32[${decoded.rm} * 4] + vFloat32[${decoded.rm} * 4 + 1];`);
            lines.push(`  vFloat32[${decoded.rd} * 4] = p0;`);
            lines.push(`  vFloat32[${decoded.rd} * 4 + 1] = p1;`);
            lines.push(`  vUint64[${decoded.rd} * 2 + 1] = 0n;`);
            lines.push(`}`);
          }
          break;
        }

        case InstructionType.ADD_VEC:
        case InstructionType.SUB_VEC:
        case InstructionType.MUL_VEC: {
          const elemSize = decoded.size ?? decoded.elemSize;
          const maxLanes = decoded.lanes;
          const arr = elemSize === 0 ? "vBytes" : elemSize === 1 ? "vUint16" : elemSize === 2 ? "vUint32" : "vUint64";
          const scale = 16 >> elemSize;
          for (let l = 0; l < maxLanes; l++) {
            const a = `${arr}[${decoded.rn} * ${scale} + ${l}]`;
            const b = `${arr}[${decoded.rm} * ${scale} + ${l}]`;
            let op = "";
            if (elemSize === 3) {
              if (decoded.type === InstructionType.ADD_VEC) op = `BigInt.asUintN(64, ${a} + ${b})`;
              else if (decoded.type === InstructionType.SUB_VEC) op = `BigInt.asUintN(64, ${a} - ${b})`;
              else op = `BigInt.asUintN(64, ${a} * ${b})`;
            } else {
              if (decoded.type === InstructionType.ADD_VEC) op = `(${a} + ${b})`;
              else if (decoded.type === InstructionType.SUB_VEC) op = `(${a} - ${b})`;
              else op = `(${a} * ${b})`;
            }
            lines.push(`${arr}[${decoded.rd} * ${scale} + ${l}] = ${op};`);
          }
          if (!decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.ADDP_VEC: {
          const elemSize = decoded.size ?? decoded.elemSize;
          const maxLanes = decoded.lanes;
          const half = maxLanes >> 1;
          const arr = elemSize === 0 ? "vBytes" : elemSize === 1 ? "vUint16" : elemSize === 2 ? "vUint32" : "vUint64";
          const scale = 16 >> elemSize;
          lines.push(`{`);
          for (let i = 0; i < half; i++) {
            const a0 = `${arr}[${decoded.rn} * ${scale} + ${i * 2}]`;
            const a1 = `${arr}[${decoded.rn} * ${scale} + ${i * 2 + 1}]`;
            const b0 = `${arr}[${decoded.rm} * ${scale} + ${i * 2}]`;
            const b1 = `${arr}[${decoded.rm} * ${scale} + ${i * 2 + 1}]`;
            lines.push(`  const r${i} = ${elemSize === 3 ? `BigInt.asUintN(64, ${a0} + ${a1})` : `(${a0} + ${a1})`};`);
            lines.push(`  const r${half + i} = ${elemSize === 3 ? `BigInt.asUintN(64, ${b0} + ${b1})` : `(${b0} + ${b1})`};`);
          }
          for (let l = 0; l < maxLanes; l++) {
            lines.push(`  ${arr}[${decoded.rd} * ${scale} + ${l}] = r${l};`);
          }
          if (!decoded.Q) {
            lines.push(`  vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.AND_VEC:
          lines.push(`vUint64[${decoded.rd} * 2] = vUint64[${decoded.rn} * 2] & vUint64[${decoded.rm} * 2];`);
          if (decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = vUint64[${decoded.rn} * 2 + 1] & vUint64[${decoded.rm} * 2 + 1];`);
          } else {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;

        case InstructionType.ORR_VEC:
          lines.push(`vUint64[${decoded.rd} * 2] = vUint64[${decoded.rn} * 2] | vUint64[${decoded.rm} * 2];`);
          if (decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = vUint64[${decoded.rn} * 2 + 1] | vUint64[${decoded.rm} * 2 + 1];`);
          } else {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;

        case InstructionType.EOR_VEC:
          lines.push(`vUint64[${decoded.rd} * 2] = vUint64[${decoded.rn} * 2] ^ vUint64[${decoded.rm} * 2];`);
          if (decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = vUint64[${decoded.rn} * 2 + 1] ^ vUint64[${decoded.rm} * 2 + 1];`);
          } else {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;

        case InstructionType.NOT_VEC:
          lines.push(`vUint64[${decoded.rd} * 2] = ~vUint64[${decoded.rn} * 2];`);
          if (decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = ~vUint64[${decoded.rn} * 2 + 1];`);
          } else {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;

        case InstructionType.DUP_GEN: {
          const elemSize = decoded.size ?? decoded.elemSize;
          const arr = elemSize === 0 ? "vBytes" : elemSize === 1 ? "vUint16" : elemSize === 2 ? "vUint32" : "vUint64";
          const scale = 16 >> elemSize;
          const maxLanes = decoded.Q ? scale : (scale >> 1);
          const valExpr = elemSize === 3 ? regExpr(decoded.rn) : `Number(${regExpr(decoded.rn)} & 0xffffffffn)`;
          for (let l = 0; l < maxLanes; l++) {
            lines.push(`${arr}[${decoded.rd} * ${scale} + ${l}] = ${valExpr};`);
          }
          if (!decoded.Q) {
            lines.push(`vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          break;
        }

        case InstructionType.DUP_ELEM: {
          const elemSize = decoded.size ?? decoded.elemSize;
          const arr = elemSize === 0 ? "vBytes" : elemSize === 1 ? "vUint16" : elemSize === 2 ? "vUint32" : "vUint64";
          const scale = 16 >> elemSize;
          const maxLanes = decoded.Q ? scale : (scale >> 1);
          const lane = decoded.lane ?? decoded.index ?? 0;
          lines.push(`{`);
          lines.push(`  const elem = ${arr}[${decoded.rn} * ${scale} + ${lane}];`);
          for (let l = 0; l < maxLanes; l++) {
            lines.push(`  ${arr}[${decoded.rd} * ${scale} + ${l}] = elem;`);
          }
          if (!decoded.Q) {
            lines.push(`  vUint64[${decoded.rd} * 2 + 1] = 0n;`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.INS_GEN: {
          const elemSize = decoded.size ?? decoded.elemSize;
          const arr = elemSize === 0 ? "vBytes" : elemSize === 1 ? "vUint16" : elemSize === 2 ? "vUint32" : "vUint64";
          const scale = 16 >> elemSize;
          const valExpr = elemSize === 3 ? regExpr(decoded.rn) : `Number(${regExpr(decoded.rn)} & 0xffffffffn)`;
          lines.push(`${arr}[${decoded.rd} * ${scale} + ${decoded.lane}] = ${valExpr};`);
          break;
        }

        case InstructionType.INS_ELEM: {
          const elemSize = decoded.size ?? decoded.elemSize;
          const arr = elemSize === 0 ? "vBytes" : elemSize === 1 ? "vUint16" : elemSize === 2 ? "vUint32" : "vUint64";
          const scale = 16 >> elemSize;
          lines.push(`${arr}[${decoded.rd} * ${scale} + ${decoded.dstLane}] = ${arr}[${decoded.rn} * ${scale} + ${decoded.srcLane}];`);
          break;
        }

        case InstructionType.UMOV_ELEM: {
          if (decoded.rd !== 31) {
            const elemSize = decoded.size ?? decoded.elemSize;
            const arr = elemSize === 0 ? "vBytes" : elemSize === 1 ? "vUint16" : elemSize === 2 ? "vUint32" : "vUint64";
            const scale = 16 >> elemSize;
            lines.push(`x[${decoded.rd}] = BigInt(${arr}[${decoded.rn} * ${scale} + ${decoded.lane}]);`);
          }
          break;
        }

        // --- System & Control ---
        case InstructionType.MRS:
          if (decoded.rt !== 31) {
            if (decoded.sysreg === 0xde82) {
              lines.push(`x[${decoded.rt}] = cpu.tpidr_el0;`);
            } else {
              lines.push(`x[${decoded.rt}] = cpu.sysRegs.get(${decoded.sysreg}) || 0n;`);
            }
          }
          break;

        case InstructionType.MSR:
          if (decoded.sysreg === 0xde82) {
            lines.push(`cpu.tpidr_el0 = ${regExpr(decoded.rt)};`);
          } else {
            lines.push(`cpu.sysRegs.set(${decoded.sysreg}, ${regExpr(decoded.rt)});`);
          }
          break;

        case InstructionType.NOP:
        case InstructionType.DMB:
        case InstructionType.DSB:
        case InstructionType.ISB:
          lines.push(`// nop / barrier`);
          break;

        case InstructionType.YIELD:
          lines.push(`// yield`);
          break;

        case InstructionType.CLZ: {
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            if (decoded.sf === 0) {
              lines.push(`x[${decoded.rd}] = BigInt(Math.clz32(Number(${regExpr(decoded.rn)} & 0xffffffffn)));`);
            } else {
              lines.push(`{`);
              lines.push(`  const val = ${regExpr(decoded.rn)};`);
              lines.push(`  const hi = Number((val >> 32n) & 0xffffffffn);`);
              lines.push(`  const lo = Number(val & 0xffffffffn);`);
              lines.push(`  x[${decoded.rd}] = BigInt(hi !== 0 ? Math.clz32(hi) : (32 + Math.clz32(lo)));`);
              lines.push(`}`);
            }
          }
          break;
        }

        case InstructionType.REV: {
          if (decoded.rd !== 31) {
            if (decoded.sf === 0) {
              lines.push(`{`);
              lines.push(`  const v = Number(${regExpr(decoded.rn)} & 0xffffffffn);`);
              lines.push(`  const r = ((v & 0xff) << 24) | (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | ((v >>> 24) & 0xff);`);
              lines.push(`  x[${decoded.rd}] = BigInt(r >>> 0);`);
              lines.push(`}`);
            } else {
              lines.push(`{`);
              lines.push(`  const val = ${regExpr(decoded.rn)};`);
              lines.push(`  let r = 0n;`);
              lines.push(`  for (let b = 0n; b < 8n; b++) r = (r << 8n) | ((val >> (b * 8n)) & 0xffn);`);
              lines.push(`  x[${decoded.rd}] = r;`);
              lines.push(`}`);
            }
          }
          break;
        }

        case InstructionType.REV16: {
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`{`);
            lines.push(`  const val = ${regExpr(decoded.rn)};`);
            lines.push(`  let r = 0n;`);
            lines.push(`  for (let h = 0; h < ${bits / 16}; h++) {`);
            lines.push(`    const shift = BigInt(h * 16);`);
            lines.push(`    const hw = Number((val >> shift) & 0xffffn);`);
            lines.push(`    const swapped = ((hw & 0xff) << 8) | ((hw >> 8) & 0xff);`);
            lines.push(`    r |= (BigInt(swapped) << shift);`);
            lines.push(`  }`);
            lines.push(`  x[${decoded.rd}] = r;`);
            lines.push(`}`);
          }
          break;
        }

        case InstructionType.REV32: {
          if (decoded.rd !== 31) {
            lines.push(`{`);
            lines.push(`  const val = ${regExpr(decoded.rn)};`);
            lines.push(`  const lo = Number(val & 0xffffffffn);`);
            lines.push(`  const hi = Number((val >> 32n) & 0xffffffffn);`);
            lines.push(`  const sw = v => ((v & 0xff) << 24) | (((v >> 8) & 0xff) << 16) | (((v >> 16) & 0xff) << 8) | ((v >>> 24) & 0xff);`);
            lines.push(`  x[${decoded.rd}] = (BigInt(sw(hi) >>> 0) << 32n) | BigInt(sw(lo) >>> 0);`);
            lines.push(`}`);
          }
          break;
        }

        case InstructionType.RBIT: {
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            lines.push(`{`);
            lines.push(`  const val = ${regExpr(decoded.rn)};`);
            lines.push(`  let r = 0n;`);
            lines.push(`  for (let b = 0; b < ${bits}; b++) {`);
            lines.push(`    if ((val & (1n << BigInt(b))) !== 0n) r |= (1n << BigInt(${bits} - 1 - b));`);
            lines.push(`  }`);
            lines.push(`  x[${decoded.rd}] = r;`);
            lines.push(`}`);
          }
          break;
        }

        case InstructionType.EXTR: {
          if (decoded.rd !== 31) {
            const bits = decoded.sf === 0 ? 32 : 64;
            if (decoded.isRegShift) {
              lines.push(`{`);
              lines.push(`  const rn = BigInt.asUintN(${bits}, ${regExpr(decoded.rn)});`);
              lines.push(`  const amt = BigInt(Number(${regExpr(decoded.rm)}) & (${bits} - 1));`);
              lines.push(`  x[${decoded.rd}] = (rn >> amt) | BigInt.asUintN(${bits}, rn << (BigInt(${bits}) - amt));`);
              lines.push(`}`);
            } else {
              lines.push(`{`);
              lines.push(`  const rn = BigInt.asUintN(${bits}, ${regExpr(decoded.rn)});`);
              lines.push(`  const rm = BigInt.asUintN(${bits}, ${regExpr(decoded.rm)});`);
              lines.push(`  const combined = (rn << BigInt(${bits})) | rm;`);
              lines.push(`  x[${decoded.rd}] = BigInt.asUintN(${bits}, combined >> ${BigInt(decoded.lsb & (bits - 1))}n);`);
              lines.push(`}`);
            }
          }
          break;
        }

        case InstructionType.LDXR: {
          lines.push(`{`);
          lines.push(`  const addr = Number(${spOrReg(decoded.rn)});`);
          const readExpr = (offset = 0) => {
            const addrExpr = offset === 0 ? `addr` : `addr + ${offset}`;
            if (decoded.bytes === 1) return `BigInt(memory.read8(${addrExpr}))`;
            if (decoded.bytes === 2) return `BigInt(memory.read16(${addrExpr}))`;
            if (decoded.bytes === 4) return `BigInt(memory.read32(${addrExpr}))`;
            if (decoded.bytes === 8) return `memory.read64(${addrExpr})`;
          };
          if (decoded.rt !== 31) {
            lines.push(`  x[${decoded.rt}] = ${readExpr(0)};`);
          }
          if (decoded.pair && decoded.rt2 !== 31) {
            lines.push(`  x[${decoded.rt2}] = ${readExpr(decoded.bytes)};`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.STXR: {
          lines.push(`{`);
          lines.push(`  const addr = Number(${spOrReg(decoded.rn)});`);
          const writeStmt = (reg, offset = 0) => {
            const addrExpr = offset === 0 ? `addr` : `addr + ${offset}`;
            if (decoded.bytes === 1) return `memory.write8(${addrExpr}, Number(${regExpr(reg)} & 0xffn));`;
            if (decoded.bytes === 2) return `memory.write16(${addrExpr}, Number(${regExpr(reg)} & 0xffffn));`;
            if (decoded.bytes === 4) return `memory.write32(${addrExpr}, Number(${regExpr(reg)} & 0xffffffffn));`;
            if (decoded.bytes === 8) return `memory.write64(${addrExpr}, ${regExpr(reg)});`;
          };
          lines.push(`  ${writeStmt(decoded.rt, 0)}`);
          if (decoded.pair) {
            lines.push(`  ${writeStmt(decoded.rt2, decoded.bytes)}`);
          }
          if (decoded.exclusive && decoded.rs !== 31) {
            lines.push(`  x[${decoded.rs}] = 0n;`);
          }
          lines.push(`}`);
          break;
        }

        case InstructionType.SVC:
          lines.push(`cpu.pc = 0x${pc.toString(16)}n;`);
          lines.push(`emu.handleSyscall(${decoded.imm16});`);
          lines.push(`cpu.pc = 0x${(pc + 4).toString(16)}n;`);
          lines.push(`return ${idx + 1};`);
          break;

        // --- Terminal Branch Instructions ---
        case InstructionType.B: {
          const targetPC = pc + decoded.offsetBytes;
          lines.push(`cpu.pc = 0x${targetPC.toString(16)}n;`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.B_COND: {
          const targetPC = pc + decoded.offsetBytes;
          const fallthroughPC = pc + 4;
          lines.push(`if (${jitConditionExpr(decoded.cond)}) {`);
          lines.push(`  cpu.pc = 0x${targetPC.toString(16)}n;`);
          lines.push(`} else {`);
          lines.push(`  cpu.pc = 0x${fallthroughPC.toString(16)}n;`);
          lines.push(`}`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.CBZ: {
          const targetPC = pc + decoded.offsetBytes;
          const fallthroughPC = pc + 4;
          const bits = decoded.sf === 0 ? 32 : 64;
          lines.push(`if (BigInt.asUintN(${bits}, ${regExpr(decoded.rt)}) === 0n) {`);
          lines.push(`  cpu.pc = 0x${targetPC.toString(16)}n;`);
          lines.push(`} else {`);
          lines.push(`  cpu.pc = 0x${fallthroughPC.toString(16)}n;`);
          lines.push(`}`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.CBNZ: {
          const targetPC = pc + decoded.offsetBytes;
          const fallthroughPC = pc + 4;
          const bits = decoded.sf === 0 ? 32 : 64;
          lines.push(`if (BigInt.asUintN(${bits}, ${regExpr(decoded.rt)}) !== 0n) {`);
          lines.push(`  cpu.pc = 0x${targetPC.toString(16)}n;`);
          lines.push(`} else {`);
          lines.push(`  cpu.pc = 0x${fallthroughPC.toString(16)}n;`);
          lines.push(`}`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.TBZ: {
          const targetPC = pc + decoded.offsetBytes;
          const fallthroughPC = pc + 4;
          lines.push(`if ((${regExpr(decoded.rt)} & (1n << ${decoded.bitPos}n)) === 0n) {`);
          lines.push(`  cpu.pc = 0x${targetPC.toString(16)}n;`);
          lines.push(`} else {`);
          lines.push(`  cpu.pc = 0x${fallthroughPC.toString(16)}n;`);
          lines.push(`}`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.TBNZ: {
          const targetPC = pc + decoded.offsetBytes;
          const fallthroughPC = pc + 4;
          lines.push(`if ((${regExpr(decoded.rt)} & (1n << ${decoded.bitPos}n)) !== 0n) {`);
          lines.push(`  cpu.pc = 0x${targetPC.toString(16)}n;`);
          lines.push(`} else {`);
          lines.push(`  cpu.pc = 0x${fallthroughPC.toString(16)}n;`);
          lines.push(`}`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.BL: {
          const targetPC = pc + decoded.offsetBytes;
          const retPC = pc + 4;
          lines.push(`x[30] = 0x${retPC.toString(16)}n; // LR = return address`);
          lines.push(`cpu.pc = 0x${targetPC.toString(16)}n;`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.BR:
          lines.push(`cpu.pc = ${regExpr(decoded.rn)};`);
          lines.push(`return ${idx + 1};`);
          break;

        case InstructionType.BLR: {
          const retPC = pc + 4;
          lines.push(`x[30] = 0x${retPC.toString(16)}n; // LR`);
          lines.push(`cpu.pc = ${regExpr(decoded.rn)};`);
          lines.push(`return ${idx + 1};`);
          break;
        }

        case InstructionType.RET:
          lines.push(`cpu.pc = ${regExpr(decoded.rn)};`);
          lines.push(`return ${idx + 1};`);
          break;

        default:
          // Unhandled or exotic instruction: update PC to current instruction and return
          lines.push(`cpu.pc = 0x${pc.toString(16)}n;`);
          lines.push(`return ${idx};`);
          break;
      }

      // If straight-line block reaches the end without a terminal branch:
      if (isLast && !isBlockTerminator(decoded.type)) {
        lines.push(`cpu.pc = 0x${(pc + 4).toString(16)}n;`);
        lines.push(`return ${instructions.length};`);
      }
    }

    return lines.join("\n");
  }
}
