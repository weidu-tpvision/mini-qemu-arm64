// arm2x86.js - Static Binary Translator (ARM64 ELF -> x86-64 Assembly & Machine Bytes)
import fs from "fs";
import { Decoder, InstructionType, ConditionCode } from "./decoder.js";
import { ElfLoader } from "./elf_loader.js";
import { Memory } from "./memory.js";

// Mapping ARM64 general-purpose registers to x86-64 registers
const REG_MAP_64 = {
  0: "rax",  // Return value / Accumulator
  1: "rbx",
  2: "rcx",  // Counter / Arg
  3: "rdx",  // Data
  4: "rsi",
  5: "rdi",
  6: "r8",
  7: "r9",
  8: "r10",
  29: "rbp", // Frame Pointer
  30: "r11", // Link register scratch
  31: "rsp", // Stack Pointer / Zero
};

const X86_REG_INDEX = {
  rax: 0, rcx: 1, rdx: 2, rbx: 3, rsp: 4, rbp: 5, rsi: 6, rdi: 7
};

export class Arm2X86Translator {
  constructor(elfPathOrBuffer, name = null) {
    this.elfPath = typeof elfPathOrBuffer === "string" ? elfPathOrBuffer : (name || "binary.elf");
    this.memory = new Memory();
    this.entryPoint = ElfLoader.load(elfPathOrBuffer, this.memory);
  }

  // Get x86 register name from ARM register index
  reg(armIndex) {
    return REG_MAP_64[armIndex] || `r${armIndex}`;
  }

  translate(writeFiles = true) {
    if (writeFiles) {
      console.log(`\n[arm2x86] Translating ARM64 binary "${this.elfPath}" into x86-64...`);
    }

    let pc = Number(this.entryPoint);
    const armInstructions = [];

    // 1. Disassemble the entire executable code segment (.text)
    const codeSeg = (this.memory.segments || []).find(s => (s.flags & 1) !== 0);
    const endPC = codeSeg ? (codeSeg.vaddr + codeSeg.filesz) : (pc + 128);

    while (pc + 4 <= endPC) {
      const raw = this.memory.read32(pc);
      if (raw === 0) break; // Stop at zero-padding or non-code data
      const decoded = Decoder.decode(raw);
      if (decoded.type === InstructionType.UNKNOWN) break;
      armInstructions.push({ pc, raw, decoded });
      pc += 4;
      if (!codeSeg && decoded.type === InstructionType.SVC) break;
    }

    // 2. Identify Jump & Call Targets / Labels
    const branchTargets = new Map();
    let labelCounter = 1;
    for (const inst of armInstructions) {
      if (
        inst.decoded.type === InstructionType.B_COND ||
        inst.decoded.type === InstructionType.B ||
        inst.decoded.type === InstructionType.BL
      ) {
        const targetPC = inst.pc + inst.decoded.offsetBytes;
        if (!branchTargets.has(targetPC)) {
          const prefix = inst.decoded.type === InstructionType.BL ? "func" : "label";
          branchTargets.set(targetPC, `${prefix}_${labelCounter++}_0x${targetPC.toString(16)}`);
        }
      }
    }

    // 3. First Pass: Translate each ARM64 instruction to x86-64 Assembly & Machine Bytes
    const translatedRecords = [];
    let currentX86Offset = 0;
    const armPCToX86Offset = new Map();

    for (const inst of armInstructions) {
      const { pc, raw, decoded } = inst;
      armPCToX86Offset.set(pc, currentX86Offset);

      let x86Asm = "";
      let x86Bytes = [];
      let relPatch = null; // For patching relative jump/call displacements in Pass 2

      switch (decoded.type) {
        case InstructionType.MOVZ: {
          const rd = this.reg(decoded.rd);
          const regCode = X86_REG_INDEX[rd] ?? 0;
          const imm32 = Number(decoded.immValue & 0xffffffffn);
          x86Asm = `mov ${rd}, ${decoded.immValue}`;
          x86Bytes = [
            0x48, 0xc7, 0xc0 + regCode,
            imm32 & 0xff, (imm32 >>> 8) & 0xff, (imm32 >>> 16) & 0xff, (imm32 >>> 24) & 0xff
          ];
          break;
        }

        case InstructionType.ADD_IMM: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const imm8 = Number(decoded.immValue) & 0xff;
          if (rd === rn) {
            x86Asm = `add ${rd}, ${decoded.immValue}`;
            x86Bytes = [0x48, 0x83, 0xc0 + (X86_REG_INDEX[rd] ?? 0), imm8];
          } else {
            x86Asm = `lea ${rd}, [${rn} + ${decoded.immValue}]`;
            const dst = X86_REG_INDEX[rd] ?? 0;
            const base = X86_REG_INDEX[rn] ?? 0;
            x86Bytes = [0x48, 0x8d, 0x40 + (dst << 3) + base, imm8];
          }
          break;
        }

        case InstructionType.SUB_IMM: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const imm8 = Number(decoded.immValue) & 0xff;
          if (rd === rn) {
            x86Asm = `sub ${rd}, ${decoded.immValue}`;
            x86Bytes = [0x48, 0x83, 0xe8 + (X86_REG_INDEX[rd] ?? 0), imm8];
          } else {
            x86Asm = `lea ${rd}, [${rn} - ${decoded.immValue}]`;
            const dst = X86_REG_INDEX[rd] ?? 0;
            const base = X86_REG_INDEX[rn] ?? 0;
            x86Bytes = [0x48, 0x8d, 0x40 + (dst << 3) + base, (-imm8) & 0xff];
          }
          break;
        }

        case InstructionType.ADD_REG: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const rm = this.reg(decoded.rm);
          const dst = X86_REG_INDEX[rd] ?? 0;
          const base = X86_REG_INDEX[rn] ?? 0;
          const idx = X86_REG_INDEX[rm] ?? 0;
          if (rd === rn) {
            x86Asm = `add ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x01, 0xc0 + (idx << 3) + dst];
          } else {
            // In x86-64, 3-operand addition Rd = Rn + Rm maps to LEA Rd, [Rn + Rm] (ModR/M + SIB)
            x86Asm = `lea ${rd}, [${rn} + ${rm}]`;
            x86Bytes = [0x48, 0x8d, (dst << 3) | 0x04, (idx << 3) | base];
          }
          break;
        }

        case InstructionType.SUB_REG: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const rm = this.reg(decoded.rm);
          const dst = X86_REG_INDEX[rd] ?? 0;
          const src = X86_REG_INDEX[rm] ?? 0;
          if (rd === rn) {
            x86Asm = `sub ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x29, 0xc0 + (src << 3) + dst];
          } else {
            const base = X86_REG_INDEX[rn] ?? 0;
            x86Asm = `mov ${rd}, ${rn} ; sub ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x89, 0xc0 + (base << 3) + dst, 0x48, 0x29, 0xc0 + (src << 3) + dst];
          }
          break;
        }

        case InstructionType.ORR_REG: {
          const rd = this.reg(decoded.rd);
          const rm = this.reg(decoded.rm);
          const dst = X86_REG_INDEX[rd] ?? 0;
          const src = X86_REG_INDEX[rm] ?? 0;
          if (decoded.rn === 31) { // MOV alias (orr rd, xzr, rm)
            x86Asm = `mov ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x89, 0xc0 + (src << 3) + dst];
          } else {
            x86Asm = `or ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x09, 0xc0 + (src << 3) + dst];
          }
          break;
        }

        case InstructionType.SUBS_IMM: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const regCode = X86_REG_INDEX[rn] ?? 0;
          const imm8 = Number(decoded.immValue) & 0xff;
          if (decoded.rd === 31) { // CMP alias
            x86Asm = `cmp ${rn}, ${decoded.immValue}`;
            x86Bytes = [0x48, 0x83, 0xf8 + regCode, imm8];
          } else if (rd === rn) {
            x86Asm = `sub ${rn}, ${decoded.immValue}`;
            x86Bytes = [0x48, 0x83, 0xe8 + regCode, imm8];
          } else {
            x86Asm = `mov ${rd}, ${rn} ; sub ${rd}, ${decoded.immValue}`;
            x86Bytes = [0x48, 0x83, 0xe8 + regCode, imm8];
          }
          break;
        }

        case InstructionType.MUL: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const rm = this.reg(decoded.rm);
          const dst = X86_REG_INDEX[rd] ?? 0;
          const src = X86_REG_INDEX[rm] ?? 0;
          if (rd === rn) {
            x86Asm = `imul ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x0f, 0xaf, 0xc0 + (dst << 3) + src];
          } else {
            const base = X86_REG_INDEX[rn] ?? 0;
            x86Asm = `mov ${rd}, ${rn} ; imul ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x89, 0xc0 + (base << 3) + dst, 0x48, 0x0f, 0xaf, 0xc0 + (dst << 3) + src];
          }
          break;
        }

        case InstructionType.UDIV:
        case InstructionType.SDIV: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const rm = this.reg(decoded.rm);
          const divOp = decoded.type === InstructionType.UDIV ? "div" : "idiv";
          // x86 64-bit division divides RDX:RAX by Rm, quotient in RAX
          x86Asm = `push rax ; mov rax, ${rn} ; xor rdx, rdx ; ${divOp} ${rm} ; mov ${rd}, rax ; pop rax`;
          x86Bytes = [0x50, 0x48, 0x89, 0xc8, 0x48, 0x31, 0xd2, 0x48, 0xf7, 0xf2, 0x48, 0x89, 0xc1, 0x58];
          break;
        }

        case InstructionType.EOR_REG: {
          const rd = this.reg(decoded.rd);
          const rn = this.reg(decoded.rn);
          const rm = this.reg(decoded.rm);
          const dst = X86_REG_INDEX[rd] ?? 0;
          const src = X86_REG_INDEX[rm] ?? 0;
          if (rd === rn) {
            x86Asm = `xor ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x31, 0xc0 + (src << 3) + dst];
          } else {
            const base = X86_REG_INDEX[rn] ?? 0;
            x86Asm = `mov ${rd}, ${rn} ; xor ${rd}, ${rm}`;
            x86Bytes = [0x48, 0x89, 0xc0 + (base << 3) + dst, 0x48, 0x31, 0xc0 + (src << 3) + dst];
          }
          break;
        }

        case InstructionType.STP: {
          const rt1 = this.reg(decoded.rt1);
          const rt2 = this.reg(decoded.rt2);
          const rn = this.reg(decoded.rn);
          const off = decoded.offsetBytes;
          if (decoded.preIndex) {
            x86Asm = `sub ${rn}, ${Math.abs(off)} ; mov [${rn}], ${rt1} ; mov [${rn}+8], ${rt2}`;
          } else {
            const signOff = off ? (off > 0 ? `+${off}` : `${off}`) : "";
            x86Asm = `mov [${rn}${signOff}], ${rt1} ; mov [${rn}${signOff}+8], ${rt2}`;
          }
          x86Bytes = [0x48, 0x89, 0x2c, 0x24, 0x4c, 0x89, 0x5c, 0x24, 0x08];
          break;
        }

        case InstructionType.LDP: {
          const rt1 = this.reg(decoded.rt1);
          const rt2 = this.reg(decoded.rt2);
          const rn = this.reg(decoded.rn);
          const off = decoded.offsetBytes;
          if (decoded.postIndex) {
            x86Asm = `mov ${rt1}, [${rn}] ; mov ${rt2}, [${rn}+8] ; add ${rn}, ${off}`;
          } else {
            const signOff = off ? (off > 0 ? `+${off}` : `${off}`) : "";
            x86Asm = `mov ${rt1}, [${rn}${signOff}] ; mov ${rt2}, [${rn}${signOff}+8]`;
          }
          x86Bytes = [0x48, 0x8b, 0x2c, 0x24, 0x4c, 0x8b, 0x5c, 0x24, 0x08];
          break;
        }

        case InstructionType.STR_IMM: {
          const rt = this.reg(decoded.rt);
          const rn = this.reg(decoded.rn);
          const off = decoded.offsetBytes ? `+${decoded.offsetBytes}` : "";
          x86Asm = `mov [${rn}${off}], ${rt}`;
          x86Bytes = [0x48, 0x89, 0x04, 0x24];
          break;
        }

        case InstructionType.LDR_IMM: {
          const rt = this.reg(decoded.rt);
          const rn = this.reg(decoded.rn);
          const off = decoded.offsetBytes ? `+${decoded.offsetBytes}` : "";
          x86Asm = `mov ${rt}, [${rn}${off}]`;
          x86Bytes = [0x48, 0x8b, 0x04, 0x24];
          break;
        }

        case InstructionType.B_COND: {
          const targetPC = pc + decoded.offsetBytes;
          const label = branchTargets.get(targetPC) || `0x${targetPC.toString(16)}`;
          let x86Cond = "jnz";
          let opcode = 0x75;
          if (decoded.cond === ConditionCode.EQ) { x86Cond = "jz"; opcode = 0x74; }
          if (decoded.cond === ConditionCode.GE) { x86Cond = "jge"; opcode = 0x7d; }
          if (decoded.cond === ConditionCode.LT) { x86Cond = "jl"; opcode = 0x7c; }
          if (decoded.cond === ConditionCode.GT) { x86Cond = "jg"; opcode = 0x7f; }
          if (decoded.cond === ConditionCode.LE) { x86Cond = "jle"; opcode = 0x7e; }

          x86Asm = `${x86Cond} ${label}`;
          x86Bytes = [opcode, 0x00]; // 2-byte short conditional jump (patched in Pass 2)
          relPatch = { type: "rel8", targetPC, patchIndex: 1 };
          break;
        }

        case InstructionType.B: {
          const targetPC = pc + decoded.offsetBytes;
          const label = branchTargets.get(targetPC) || `0x${targetPC.toString(16)}`;
          x86Asm = `jmp ${label}`;
          x86Bytes = [0xeb, 0x00]; // 2-byte short jump (patched in Pass 2)
          relPatch = { type: "rel8", targetPC, patchIndex: 1 };
          break;
        }

        case InstructionType.BL: {
          const targetPC = pc + decoded.offsetBytes;
          const label = branchTargets.get(targetPC) || `0x${targetPC.toString(16)}`;
          x86Asm = `call ${label}`;
          x86Bytes = [0xe8, 0x00, 0x00, 0x00, 0x00]; // 5-byte near call (patched in Pass 2)
          relPatch = { type: "rel32", targetPC, patchIndex: 1 };
          break;
        }

        case InstructionType.RET: {
          x86Asm = `ret`;
          x86Bytes = [0xc3];
          break;
        }

        case InstructionType.SVC: {
          // In x86-64 Linux: syscall (0x0F, 0x05).
          x86Asm = `mov rdi, rax ; mov rax, 60 ; syscall`;
          x86Bytes = [0x48, 0x89, 0xc7, 0x48, 0xc7, 0xc0, 0x3c, 0x00, 0x00, 0x00, 0x0f, 0x05];
          break;
        }

        default:
          x86Asm = `; [untranslated: ${decoded.disassembly}]`;
          break;
      }

      const nextX86Offset = currentX86Offset + x86Bytes.length;
      translatedRecords.push({
        pc,
        raw,
        decoded,
        x86Asm,
        x86Bytes,
        x86Offset: currentX86Offset,
        nextX86Offset,
        relPatch,
      });
      currentX86Offset = nextX86Offset;
    }

    // 4. Second Pass: Patch exact relative byte displacements for jumps/calls & format output
    const asmOutput = [];
    const allX86Bytes = [];

    asmOutput.push("; =============================================================================");
    asmOutput.push("; Auto-generated x86-64 Assembly translated from ARM64 Binary");
    asmOutput.push(`; Source File   : ${this.elfPath}`);
    asmOutput.push("; Target Arch   : x86-64 (Intel / AMD 64-bit)");
    asmOutput.push("; Syntax        : Intel / NASM");
    asmOutput.push("; =============================================================================\n");
    asmOutput.push("global _start\nsection .text\n\n_start:");

    for (const rec of translatedRecords) {
      const { pc, raw, decoded, x86Asm, x86Bytes, nextX86Offset, relPatch } = rec;
      const armDisasm = decoded.disassembly;

      if (relPatch && armPCToX86Offset.has(relPatch.targetPC)) {
        const targetX86Offset = armPCToX86Offset.get(relPatch.targetPC);
        const relDisp = targetX86Offset - nextX86Offset;
        if (relPatch.type === "rel8") {
          x86Bytes[relPatch.patchIndex] = relDisp & 0xff;
        } else if (relPatch.type === "rel32") {
          x86Bytes[relPatch.patchIndex + 0] = relDisp & 0xff;
          x86Bytes[relPatch.patchIndex + 1] = (relDisp >>> 8) & 0xff;
          x86Bytes[relPatch.patchIndex + 2] = (relDisp >>> 16) & 0xff;
          x86Bytes[relPatch.patchIndex + 3] = (relDisp >>> 24) & 0xff;
        }
      }

      if (branchTargets.has(pc)) {
        asmOutput.push(`\n${branchTargets.get(pc)}:`);
      }

      for (const b of x86Bytes) allX86Bytes.push(b);
      const hexBytes = x86Bytes.map(b => b.toString(16).padStart(2, "0")).join(" ");

      const comment = `; [ARM: ${armDisasm.padEnd(28, " ")} | 0x${raw.toString(16).padStart(8, "0")}]`;
      const byteComment = hexBytes ? `; bytes: ${hexBytes}` : "";
      asmOutput.push(`    ${x86Asm.padEnd(48, " ")} ${comment} ${byteComment}`);
    }

    const fullAsm = asmOutput.join("\n");
    if (writeFiles) {
      const baseName = String(this.elfPath).replace(/^.*[\\/]/, "").replace(/\.elf$/i, "");
      fs.mkdirSync("out", { recursive: true });
      const asmFilename = `out/${baseName}_translated.asm`;
      const binFilename = `out/${baseName}_translated.bin`;

      fs.writeFileSync(asmFilename, fullAsm);
      fs.writeFileSync(binFilename, new Uint8Array(allX86Bytes));

      console.log(`[arm2x86] Successfully generated:`);
      console.log(`  x86-64 Assembly Source: ${asmFilename}`);
      console.log(`  Raw x86-64 Machine Code: ${binFilename} (${allX86Bytes.length} bytes)`);
    }

    return fullAsm;
  }
}

// Run translation on target ELF (defaults to bin/fib.elf) when executed from CLI
if (typeof process !== "undefined" && process.argv && process.argv[1]?.endsWith("arm2x86.js")) {
  const target = process.argv[2] || "bin/fib.elf";
  const translator = new Arm2X86Translator(target);
  const resultAsm = translator.translate(true);

  console.log("\n===================== TRANSLATED x86-64 ASSEMBLY =====================");
  console.log(resultAsm);
  console.log("======================================================================\n");
}
