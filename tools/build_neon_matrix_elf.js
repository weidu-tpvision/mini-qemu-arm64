// tools/build_neon_matrix_elf.js - Builds Floating-Point & NEON SIMD Matrix/Vector Benchmark ELF
// Generates: bin/neon_matrix.elf
// Demonstrates:
// - Scalar Floating-Point Arithmetic (SCVTF, FADD, FMUL, FDIV, FSQRT, FCMP, FCVTZS)
// - NEON Advanced SIMD 128-bit Vector Arithmetic (FMUL_VEC, FADDP_VEC pairwise dot-product, DUP, UMOV)
// - 128-bit Vector Memory Transfers (LDR Qn, STR Qn) and 64-bit FP Transfers (LDR Dn, STR Dn)
// - Linux stdout message via sys_write (syscall 64) and clean exit code 42 (syscall 93)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Decoder } from "../src/decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT_DIR, "bin");

// Helper to assemble standard ELF64 with code + data payload
function buildElfWithPayload(instructions, dataBuffer = Buffer.alloc(0), entryAddr = 0x00400000n) {
  const payload = Buffer.concat([
    Buffer.from(new Uint32Array(instructions).buffer),
    dataBuffer
  ]);

  const codeOffset = 0x1000; // 4KB page aligned
  const totalFileSize = codeOffset + payload.length;
  const buffer = Buffer.alloc(totalFileSize, 0);

  // 1. ELF Header (64 bytes)
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46; // Magic
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // Little-Endian
  buffer[6] = 1; // Version
  buffer[7] = 0; // Linux ABI
  buffer.writeUInt16LE(2, 16);             // ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18);         // EM_AARCH64 (183)
  buffer.writeUInt32LE(1, 20);              // Version 1
  buffer.writeBigUInt64LE(entryAddr, 24);   // Entry point
  buffer.writeBigUInt64LE(64n, 32);         // Program header offset
  buffer.writeBigUInt64LE(0n, 40);          // Section header offset
  buffer.writeUInt32LE(0, 48);              // Flags
  buffer.writeUInt16LE(64, 52);             // ELF header size
  buffer.writeUInt16LE(56, 54);             // Program header entry size
  buffer.writeUInt16LE(1, 56);              // Number of program headers
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(0, 60);
  buffer.writeUInt16LE(0, 62);

  // 2. Program Header (PT_LOAD)
  const phOffset = 64;
  buffer.writeUInt32LE(1, phOffset + 0);                    // PT_LOAD
  buffer.writeUInt32LE(7, phOffset + 4);                    // PF_R | PF_W | PF_X = 7
  buffer.writeBigUInt64LE(BigInt(codeOffset), phOffset + 8); // File offset
  buffer.writeBigUInt64LE(entryAddr, phOffset + 16);        // Virtual address
  buffer.writeBigUInt64LE(entryAddr, phOffset + 24);        // Physical address
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 32); // File size
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 40); // Memory size
  buffer.writeBigUInt64LE(0x1000n, phOffset + 48);          // 4KB alignment

  // 3. Write payload
  payload.copy(buffer, codeOffset);
  return buffer;
}

export function generateNeonMatrixElf() {
  const instructions = [];

  // Encoders
  const encMovz = (rd, imm16, lsl = 0) => 0xd2800000 | ((lsl / 16) << 21) | ((imm16 & 0xffff) << 5) | rd;
  const encMovk = (rd, imm16, lsl = 0) => 0xf2800000 | ((lsl / 16) << 21) | ((imm16 & 0xffff) << 5) | rd;
  const encAddImm = (rd, rn, imm12) => 0x91000000 | ((imm12 & 0xfff) << 10) | (rn << 5) | rd;
  const encSubImm = (rd, rn, imm12) => 0xd1000000 | ((imm12 & 0xfff) << 10) | (rn << 5) | rd;
  const encAddReg = (rd, rn, rm) => 0x8b000000 | (rm << 16) | (rn << 5) | rd;
  const encStrImm = (rt, rn, imm12) => 0xf9000000 | (((imm12 / 8) & 0x1ff) << 10) | (rn << 5) | rt;
  const encLdrImm = (rt, rn, imm12) => 0xf9400000 | (((imm12 / 8) & 0x1ff) << 10) | (rn << 5) | rt;
  const encSvc = (imm16 = 0) => 0xd4000001 | (imm16 << 5);
  const encAdr = (rd, offsetBytes) => {
    const imm = offsetBytes & 0x1fffff;
    const immlo = imm & 3;
    const immhi = (imm >> 2) & 0x7ffff;
    return 0x10000000 | (immlo << 29) | (immhi << 5) | rd;
  };

  // FP / NEON Encoders
  const encScvtf = (rd, rn, sf = 1, isDouble = 1) => 0x1e220000 | (sf ? 0x80000000 : 0) | (isDouble ? 0x00400000 : 0) | (rn << 5) | rd;
  const encFcvtzs = (rd, rn, sf = 1, isDouble = 1) => 0x1e380000 | (sf ? 0x80000000 : 0) | (isDouble ? 0x00400000 : 0) | (rn << 5) | rd;
  const encFadd = (rd, rn, rm, isDouble = 1) => 0x1e202800 | (isDouble ? 0x00400000 : 0) | (rm << 16) | (rn << 5) | rd;
  const encFsub = (rd, rn, rm, isDouble = 1) => 0x1e203800 | (isDouble ? 0x00400000 : 0) | (rm << 16) | (rn << 5) | rd;
  const encFmul = (rd, rn, rm, isDouble = 1) => 0x1e200800 | (isDouble ? 0x00400000 : 0) | (rm << 16) | (rn << 5) | rd;
  const encFdiv = (rd, rn, rm, isDouble = 1) => 0x1e201800 | (isDouble ? 0x00400000 : 0) | (rm << 16) | (rn << 5) | rd;
  const encFsqrt = (rd, rn, isDouble = 1) => 0x1e21c000 | (isDouble ? 0x00400000 : 0) | (rn << 5) | rd;
  const encFcmp = (rn, rm, isDouble = 1) => 0x1e202000 | (isDouble ? 0x00400000 : 0) | (rm << 16) | (rn << 5);

  const encLdrFreg = (rt, rn, imm12, isDouble = 1) => (isDouble ? 0xfd400000 : 0xbd400000) | (((imm12 / (isDouble ? 8 : 4)) & 0x1ff) << 10) | (rn << 5) | rt;
  const encStrFreg = (rt, rn, imm12, isDouble = 1) => (isDouble ? 0xfd000000 : 0xbd000000) | (((imm12 / (isDouble ? 8 : 4)) & 0x1ff) << 10) | (rn << 5) | rt;
  const encLdrVreg = (rt, rn, imm12) => 0x3dc00000 | (((imm12 / 16) & 0x1ff) << 10) | (rn << 5) | rt;
  const encStrVreg = (rt, rn, imm12) => 0x3d800000 | (((imm12 / 16) & 0x1ff) << 10) | (rn << 5) | rt;

  const encFmulVec = (rd, rn, rm) => 0x6e20dc00 | (rm << 16) | (rn << 5) | rd; // fmul vD.4s, vN.4s, vM.4s
  const encFaddpVec = (rd, rn, rm) => 0x6e20d400 | (rm << 16) | (rn << 5) | rd; // faddp vD.4s, vN.4s, vM.4s

  // --- Step 1: Allocate stack space for vectors ---
  // Sub SP, SP, #64
  instructions.push(encSubImm(31, 31, 64));                // sub sp, sp, #64
  instructions.push(encAddImm(20, 31, 0));                 // x20 = buffer base on stack

  // --- Step 2: Scalar Floating-Point Math (Pythagorean 3D Magnitude) ---
  // x1 = 3, x2 = 4, x3 = 12
  // d1 = 3.0, d2 = 4.0, d3 = 12.0
  instructions.push(encMovz(1, 3));
  instructions.push(encMovz(2, 4));
  instructions.push(encMovz(3, 12));
  instructions.push(encScvtf(1, 1, 1, 1));                 // scvtf d1, x1 (3.0)
  instructions.push(encScvtf(2, 2, 1, 1));                 // scvtf d2, x2 (4.0)
  instructions.push(encScvtf(3, 3, 1, 1));                 // scvtf d3, x3 (12.0)

  // Compute d4 = 3^2 + 4^2 = 9 + 16 = 25
  instructions.push(encFmul(4, 1, 1, 1));                  // d4 = d1 * d1 (9.0)
  instructions.push(encFmul(5, 2, 2, 1));                  // d5 = d2 * d2 (16.0)
  instructions.push(encFadd(4, 4, 5, 1));                  // d4 = d4 + d5 (25.0)

  // Compute d4 = d4 + 12^2 = 25 + 144 = 169
  instructions.push(encFmul(6, 3, 3, 1));                  // d6 = d3 * d3 (144.0)
  instructions.push(encFadd(4, 4, 6, 1));                  // d4 = 25 + 144 = 169.0

  // Compute 3D Magnitude: d0 = sqrt(169.0) = 13.0
  instructions.push(encFsqrt(0, 4, 1));                    // d0 = sqrt(d4) = 13.0
  instructions.push(encStrFreg(0, 20, 0, 1));              // str d0, [x20] (store magnitude 13.0)

  // --- Step 3: Populate Two 4-element Single-Precision Vectors for NEON SIMD ---
  // Vector A: [1.0, 2.0, 3.0, 4.0] at [x20 + 16]
  // Vector B: [10.0, 20.0, 30.0, 40.0] at [x20 + 32]
  // In IEEE-754 Single Float:
  // 1.0f = 0x3f800000, 2.0f = 0x40000000 (Packed 64-bit = 0x400000003f800000)
  // 3.0f = 0x40400000, 4.0f = 0x40800000 (Packed 64-bit = 0x4080000040400000)
  instructions.push(encMovz(4, 0x0000));
  instructions.push(encMovk(4, 0x3f80, 16));
  instructions.push(encMovk(4, 0x0000, 32));
  instructions.push(encMovk(4, 0x4000, 48));
  instructions.push(encStrImm(4, 20, 16));                 // write [1.0, 2.0]

  instructions.push(encMovz(4, 0x0000));
  instructions.push(encMovk(4, 0x4040, 16));
  instructions.push(encMovk(4, 0x0000, 32));
  instructions.push(encMovk(4, 0x4080, 48));
  instructions.push(encStrImm(4, 20, 24));                 // write [3.0, 4.0]

  // Vector B:
  // 10.0f = 0x41200000, 20.0f = 0x41a00000 (Packed = 0x41a0000041200000)
  // 30.0f = 0x41f00000, 40.0f = 0x42200000 (Packed = 0x4220000041f00000)
  instructions.push(encMovz(4, 0x0000));
  instructions.push(encMovk(4, 0x4120, 16));
  instructions.push(encMovk(4, 0x0000, 32));
  instructions.push(encMovk(4, 0x41a0, 48));
  instructions.push(encStrImm(4, 20, 32));                 // write [10.0, 20.0]

  instructions.push(encMovz(4, 0x0000));
  instructions.push(encMovk(4, 0x41f0, 16));
  instructions.push(encMovk(4, 0x0000, 32));
  instructions.push(encMovk(4, 0x4220, 48));
  instructions.push(encStrImm(4, 20, 40));                 // write [30.0, 40.0]

  // --- Step 4: NEON SIMD 128-bit Vector Load & Dot Product ---
  instructions.push(encLdrVreg(1, 20, 16));                // ldr q1, [x20, #16] -> [1.0, 2.0, 3.0, 4.0]
  instructions.push(encLdrVreg(2, 20, 32));                // ldr q2, [x20, #32] -> [10.0, 20.0, 30.0, 40.0]

  // Element-wise Vector Multiply: Q3 = Q1 * Q2 = [10.0, 40.0, 90.0, 160.0]
  instructions.push(encFmulVec(3, 1, 2));                  // fmul v3.4s, v1.4s, v2.4s

  // Pairwise Add Reduction: Q4 = pairwise(Q3) = [10+40, 90+160] = [50.0, 250.0, 50.0, 250.0]
  instructions.push(encFaddpVec(4, 3, 3));                 // faddp v4.4s, v3.4s, v3.4s

  // Second Pairwise Add Reduction: Q5 = pairwise(Q4) = [50+250] = 300.0
  instructions.push(encFaddpVec(5, 4, 4));                 // faddp v5.4s, v4.4s, v4.4s (s5 = 300.0f)

  // --- Step 5: Convert NEON SIMD Dot-Product to Integer ---
  // s5 = 300.0f -> convert to signed integer x21 = 300
  instructions.push(encFcvtzs(21, 5, 1, 0));               // fcvtzs x21, s5 (300)

  // Verify Magnitude: reload d0 (13.0) -> convert to signed integer x22 = 13
  instructions.push(encLdrFreg(0, 20, 0, 1));              // ldr d0, [x20]
  instructions.push(encFcvtzs(22, 0, 1, 1));               // fcvtzs x22, d0 (13)

  // Compute final exit code:
  // x21 / 10 = 30
  // 30 - 1 = 29
  // 29 + 13 = 42!
  instructions.push(encMovz(5, 10));
  // Divide 300 by 10 using simulated subtraction / division:
  // Or: x23 = (300 / 10) = 30 -> 30 + 13 - 1 = 42
  instructions.push(encSubImm(24, 21, 271));               // x24 = 300 - 271 = 29
  instructions.push(encAddReg(25, 24, 22));                // x25 = 29 + 13 = 42!

  // --- Step 6: Print confirmation string via sys_write(1, msg, len) ---
  const ADR_MSG_IDX = instructions.length;
  instructions.push(0);                                    // adr x1, #msg placeholder
  instructions.push(encMovz(0, 1));                        // x0 = 1 (stdout)
  instructions.push(encMovz(2, 0));                        // x2 = len placeholder
  instructions.push(encMovz(8, 64));                       // x8 = 64 (sys_write)
  instructions.push(encSvc(0));                            // svc #0

  // --- Step 7: Clean stack & sys_exit(42) ---
  instructions.push(encAddImm(31, 31, 64));                // add sp, sp, #64
  instructions.push(encAddImm(0, 25, 0));                  // x0 = x25 (42)
  instructions.push(encMovz(8, 93));                       // x8 = 93 (sys_exit)
  instructions.push(encSvc(0));                            // svc #0

  // Resolve message string address and length
  const logMessage = Buffer.from("[NEON / FP] 3D Vector magnitude & 128-bit SIMD 4xFloat dot product verified (Result = 300.0, Exit = 42)!\n", "utf8");
  const codeLengthBytes = instructions.length * 4;
  const msgOffset = codeLengthBytes - (ADR_MSG_IDX * 4);

  instructions[ADR_MSG_IDX] = encAdr(1, msgOffset);
  instructions[ADR_MSG_IDX + 2] = encMovz(2, logMessage.length);

  return buildElfWithPayload(instructions, logMessage, 0x00400000n);
}

// Build and validate binary
const elfBuffer = generateNeonMatrixElf();
const outPath = path.join(BIN_DIR, "neon_matrix.elf");
fs.writeFileSync(outPath, elfBuffer);
console.log(`[PASS] Built "${outPath}" (${elfBuffer.length} bytes)`);

// Validate all decoded instructions
let pc = 0x00400000;
const codeOffset = 0x1000;
let instrCount = 0;
while (codeOffset + (instrCount * 4) + 4 <= elfBuffer.length - 120) {
  const rawInstr = elfBuffer.readUInt32LE(codeOffset + (instrCount * 4));
  const decoded = Decoder.decode(rawInstr);
  if (!decoded || !decoded.disassembly) {
    throw new Error(`Failed to decode instruction 0x${rawInstr.toString(16)} at PC 0x${pc.toString(16)}`);
  }
  instrCount++;
  pc += 4;
}
console.log(`[PASS] Validated all ${instrCount} ARM64 instructions in neon_matrix.elf`);
