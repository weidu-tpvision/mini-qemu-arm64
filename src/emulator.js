// emulator.js - Mini-QEMU ARM64 User-Space Emulator (32+ Core Instructions)
import { Memory } from "./memory.js";
import { CPU } from "./cpu.js";
import { Decoder, InstructionType, ConditionCode } from "./decoder.js";
import { ElfLoader } from "./elf_loader.js";

export class MiniQEMU {
  constructor() {
    this.memory = new Memory();
    this.cpu = new CPU(this.memory);
    this.cycleCount = 0;
    this.breakpoints = new Set();
    this.onWrite = null;
    this.onStep = null;
    this.onHalt = null;
    this.loadedSource = null;
    this.entryPoint = 0n;
  }

  addBreakpoint(addr) {
    this.breakpoints.add(Number(addr));
  }

  removeBreakpoint(addr) {
    this.breakpoints.delete(Number(addr));
  }

  toggleBreakpoint(addr) {
    const a = Number(addr);
    if (this.breakpoints.has(a)) {
      this.breakpoints.delete(a);
      return false;
    } else {
      this.breakpoints.add(a);
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
    this.memory.clear();
    this.cpu.reset();
    this.cycleCount = 0;
    this.loadedSource = { source: filePathOrBuffer, name };
    const entryPoint = ElfLoader.load(filePathOrBuffer, this.memory);
    this.entryPoint = entryPoint;
    this.cpu.pc = entryPoint;
    return entryPoint;
  }

  reset() {
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
    this.memory.loadProgram(loadAddress, instructions);
    this.cpu.pc = BigInt(loadAddress);
  }

  // Apply ARM64 barrel shifter (00=LSL, 01=LSR, 10=ASR)
  applyShift(value, shiftType = 0, amount = 0) {
    if (!amount) return value;
    const amt = BigInt(amount & 0x3f);
    if (shiftType === 0b00) return BigInt.asUintN(64, value << amt); // LSL
    if (shiftType === 0b01) return BigInt.asUintN(64, value >> amt); // LSR
    if (shiftType === 0b10) return BigInt.asUintN(64, BigInt.asIntN(64, value) >> amt); // ASR
    return value;
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
    const prevSP = this.cpu.sp;
    this.memory.lastWritten.clear();

    // 1. FETCH
    const rawInstr = this.memory.read32(currentPC);
    const hexPC = `0x${currentPC.toString(16).padStart(8, "0")}`;
    const hexInstr = `0x${rawInstr.toString(16).padStart(8, "0")}`;

    // 2. DECODE
    const decoded = Decoder.decode(rawInstr);

    // 3. EXECUTE
    switch (decoded.type) {
      // --- Immediates ---
      case InstructionType.ADR: {
        const targetAddr = currentPC + decoded.offsetBytes;
        this.cpu.setReg(decoded.rd, BigInt(targetAddr));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MOVZ:
      case InstructionType.MOVN: {
        this.cpu.setReg(decoded.rd, decoded.immValue);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ADD_IMM: {
        const sum = this.cpu.getSPOrReg(decoded.rn) + decoded.immValue;
        this.cpu.setSPOrReg(decoded.rd, sum);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUB_IMM: {
        const diff = this.cpu.getSPOrReg(decoded.rn) - decoded.immValue;
        this.cpu.setSPOrReg(decoded.rd, diff);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUBS_IMM: {
        const op1 = this.cpu.getSPOrReg(decoded.rn);
        const op2 = decoded.immValue;
        const result = BigInt.asUintN(64, op1 - op2);

        this.cpu.setReg(decoded.rd, result);

        this.cpu.flags.Z = (result === 0n);
        this.cpu.flags.N = ((result & (1n << 63n)) !== 0n);
        this.cpu.flags.C = (op1 >= op2);
        const s_op1 = BigInt.asIntN(64, op1);
        const s_op2 = BigInt.asIntN(64, op2);
        const s_res = BigInt.asIntN(64, result);
        this.cpu.flags.V = ((s_op1 ^ s_op2) < 0n) && ((s_op1 ^ s_res) < 0n);

        this.cpu.pc += 4n;
        break;
      }

      // --- Register Arithmetic & Logic ---
      case InstructionType.ADD_REG: {
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6);
        const sum = this.cpu.getReg(decoded.rn) + op2;
        this.cpu.setReg(decoded.rd, sum);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUB_REG: {
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6);
        const diff = this.cpu.getReg(decoded.rn) - op2;
        this.cpu.setReg(decoded.rd, diff);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SUBS_REG: {
        const op1 = this.cpu.getReg(decoded.rn);
        const op2 = this.applyShift(this.cpu.getReg(decoded.rm), decoded.shift, decoded.imm6);
        const result = BigInt.asUintN(64, op1 - op2);

        this.cpu.setReg(decoded.rd, result);

        this.cpu.flags.Z = (result === 0n);
        this.cpu.flags.N = ((result & (1n << 63n)) !== 0n);
        this.cpu.flags.C = (op1 >= op2);
        const s_op1 = BigInt.asIntN(64, op1);
        const s_op2 = BigInt.asIntN(64, op2);
        const s_res = BigInt.asIntN(64, result);
        this.cpu.flags.V = ((s_op1 ^ s_op2) < 0n) && ((s_op1 ^ s_res) < 0n);

        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.AND_REG: {
        const res = this.cpu.getReg(decoded.rn) & this.cpu.getReg(decoded.rm);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ORR_REG: {
        const res = this.cpu.getReg(decoded.rn) | this.cpu.getReg(decoded.rm);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.EOR_REG: {
        const res = this.cpu.getReg(decoded.rn) ^ this.cpu.getReg(decoded.rm);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.MVN_REG: {
        const res = BigInt.asUintN(64, ~this.cpu.getReg(decoded.rm));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      // --- Math: Multiply & Divide ---
      case InstructionType.MUL: {
        const res = BigInt.asUintN(64, this.cpu.getReg(decoded.rn) * this.cpu.getReg(decoded.rm));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.UDIV: {
        const divisor = this.cpu.getReg(decoded.rm);
        const res = (divisor === 0n) ? 0n : (this.cpu.getReg(decoded.rn) / divisor);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.SDIV: {
        const s_op1 = BigInt.asIntN(64, this.cpu.getReg(decoded.rn));
        const s_op2 = BigInt.asIntN(64, this.cpu.getReg(decoded.rm));
        const res = (s_op2 === 0n) ? 0n : BigInt.asUintN(64, s_op1 / s_op2);
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      // --- Bit Shifts ---
      case InstructionType.LSL: {
        const shift = Number(this.cpu.getReg(decoded.rm) & 0x3fn);
        const res = BigInt.asUintN(64, this.cpu.getReg(decoded.rn) << BigInt(shift));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LSR: {
        const shift = Number(this.cpu.getReg(decoded.rm) & 0x3fn);
        const res = BigInt.asUintN(64, this.cpu.getReg(decoded.rn) >> BigInt(shift));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.ASR: {
        const shift = Number(this.cpu.getReg(decoded.rm) & 0x3fn);
        const s_val = BigInt.asIntN(64, this.cpu.getReg(decoded.rn));
        const res = BigInt.asUintN(64, s_val >> BigInt(shift));
        this.cpu.setReg(decoded.rd, res);
        this.cpu.pc += 4n;
        break;
      }

      // --- Single Load/Store ---
      case InstructionType.STR_IMM: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = baseAddr + decoded.offsetBytes;
        this.memory.write64(targetAddr, this.cpu.getReg(decoded.rt));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDR_IMM: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = baseAddr + decoded.offsetBytes;
        this.cpu.setReg(decoded.rt, this.memory.read64(targetAddr));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STRW_IMM: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = baseAddr + decoded.offsetBytes;
        this.memory.write32(targetAddr, Number(this.cpu.getReg(decoded.rt) & 0xffffffffn));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRW_IMM: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = baseAddr + decoded.offsetBytes;
        this.cpu.setReg(decoded.rt, BigInt(this.memory.read32(targetAddr)));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.STRB_IMM: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = baseAddr + decoded.offsetBytes;
        this.memory.write8(targetAddr, Number(this.cpu.getReg(decoded.rt) & 0xffn));
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDRB_IMM: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = baseAddr + decoded.offsetBytes;
        this.cpu.setReg(decoded.rt, BigInt(this.memory.read8(targetAddr)));
        this.cpu.pc += 4n;
        break;
      }

      // --- Pair Load/Store (Stack Frames) ---
      case InstructionType.STP: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        this.memory.write64(targetAddr, this.cpu.getReg(decoded.rt1));
        this.memory.write64(targetAddr + 8, this.cpu.getReg(decoded.rt2));
        if (decoded.preIndex || decoded.postIndex) {
          this.cpu.setSPOrReg(decoded.rn, BigInt(baseAddr + decoded.offsetBytes));
        }
        this.cpu.pc += 4n;
        break;
      }

      case InstructionType.LDP: {
        const baseAddr = Number(this.cpu.getSPOrReg(decoded.rn));
        const targetAddr = decoded.postIndex ? baseAddr : (baseAddr + decoded.offsetBytes);
        this.cpu.setReg(decoded.rt1, this.memory.read64(targetAddr));
        this.cpu.setReg(decoded.rt2, this.memory.read64(targetAddr + 8));
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

      // --- Syscalls ---
      case InstructionType.SVC: {
        const syscallNum = Number(this.cpu.getReg(8));

        if (syscallNum === 93) { // sys_exit
          this.cpu.exitCode = Number(this.cpu.getReg(0));
          this.cpu.halted = true;
          if (this.onHalt) {
            this.onHalt(this.cpu.exitCode);
          }
        } else if (syscallNum === 64) { // sys_write
          const fd = Number(this.cpu.getReg(0));
          const bufAddr = Number(this.cpu.getReg(1));
          const count = Number(this.cpu.getReg(2));

          const bytes = new Uint8Array(count);
          for (let i = 0; i < count; i++) {
            bytes[i] = this.memory.read8(bufAddr + i);
          }
          const text = new TextDecoder().decode(bytes);

          if (this.onWrite) {
            this.onWrite(text, fd);
          }
          if ((fd === 1 || fd === 2) && typeof process !== "undefined" && process.stdout && !this.suppressStdout) {
            process.stdout.write(text);
          }

          this.cpu.setReg(0, BigInt(count));
        } else {
          throw new Error(`Unimplemented syscall number: ${syscallNum}`);
        }
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
      changedMem: Array.from(this.memory.lastWritten),
      halted: this.cpu.halted,
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

  run(maxCycles = 10000, verbose = true) {
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
