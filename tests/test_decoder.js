// tests/test_decoder.js - Unit tests for ARM64 Decoder (32+ Base Instructions)
import { Decoder, InstructionType } from "../src/decoder.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log("Running ARM64 Instruction Decoder Extended Unit Tests...\n");

// 1. Math: MUL, MADD, MSUB, SDIV, UDIV
{
  const d = Decoder.decode(0x9b027c20); // mul x0, x1, x2
  assert(d.type === InstructionType.MUL, "Type must be MUL");
  assert(d.rd === 0 && d.rn === 1 && d.rm === 2, "Registers must match");
  console.log(`[PASS] MUL test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x9b020c20); // madd x0, x1, x2, x3
  assert(d.type === InstructionType.MADD, "Type must be MADD");
  assert(d.rd === 0 && d.rn === 1 && d.rm === 2 && d.ra === 3, "MADD registers must match");
  console.log(`[PASS] MADD test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x9b028c20); // msub x0, x1, x2, x3
  assert(d.type === InstructionType.MSUB, "Type must be MSUB");
  assert(d.rd === 0 && d.rn === 1 && d.rm === 2 && d.ra === 3, "MSUB registers must match");
  console.log(`[PASS] MSUB test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x9ac20c20); // sdiv x0, x1, x2
  assert(d.type === InstructionType.SDIV, "Type must be SDIV");
  console.log(`[PASS] SDIV test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x9ac20820); // udiv x0, x1, x2
  assert(d.type === InstructionType.UDIV, "Type must be UDIV");
  console.log(`[PASS] UDIV test: ${d.disassembly}`);
}

// 2. Bitwise Logic: AND, EOR, MVN
{
  const d = Decoder.decode(0x8a020020); // and x0, x1, x2
  assert(d.type === InstructionType.AND_REG, "Type must be AND_REG");
  console.log(`[PASS] AND test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xca020020); // eor x0, x1, x2
  assert(d.type === InstructionType.EOR_REG, "Type must be EOR_REG");
  console.log(`[PASS] EOR (XOR) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xaa2103e0); // mvn x0, x1
  assert(d.type === InstructionType.MVN_REG, "Type must be MVN_REG");
  console.log(`[PASS] MVN (NOT) test: ${d.disassembly}`);
}

// 3. Control Flow: BL, BR, BLR, RET
{
  const d = Decoder.decode(0x94000008); // bl [offset +32B]
  assert(d.type === InstructionType.BL, "Type must be BL");
  assert(d.offsetBytes === 32, "Offset must be 32 bytes");
  console.log(`[PASS] BL (Call) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xd61f0020); // br x1
  assert(d.type === InstructionType.BR, "Type must be BR");
  assert(d.rn === 1, "Rn must be 1");
  console.log(`[PASS] BR (Indirect Jump) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xd63f0040); // blr x2
  assert(d.type === InstructionType.BLR, "Type must be BLR");
  assert(d.rn === 2, "Rn must be 2");
  console.log(`[PASS] BLR (Call Pointer) test: ${d.disassembly}`);
}

// 4. Stack Frames & Pairs: STP, LDP (including Pre-Index & Post-Index & SP formatting)
{
  const d = Decoder.decode(0xa9bf7bfd); // stp x29, x30, [sp, #-16]!
  assert(d.type === InstructionType.STP, "Type must be STP");
  assert(d.rt1 === 29 && d.rt2 === 30, "Registers must be FP (29) and LR (30)");
  assert(d.preIndex === true && d.postIndex === false, "Must be pre-indexed");
  assert(d.disassembly === "stp x29, x30, [sp, #-16]!", `Expected pre-index sp disasm, got: ${d.disassembly}`);
  console.log(`[PASS] STP Pre-Index test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xa8c17bfd); // ldp x29, x30, [sp], #16
  assert(d.type === InstructionType.LDP, "Type must be LDP");
  assert(d.postIndex === true && d.preIndex === false, "Must be post-indexed");
  assert(d.disassembly === "ldp x29, x30, [sp], #16", `Expected post-index sp disasm, got: ${d.disassembly}`);
  console.log(`[PASS] LDP Post-Index test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xa9417bfd); // ldp x29, x30, [sp, #16]
  assert(d.type === InstructionType.LDP, "Type must be LDP");
  assert(d.preIndex === false && d.postIndex === false, "Must be signed-offset");
  assert(d.disassembly === "ldp x29, x30, [sp, #16]", `Expected signed-offset sp disasm, got: ${d.disassembly}`);
  console.log(`[PASS] LDP Signed-Offset test: ${d.disassembly}`);
}

// 5. Byte & Halfword & Unscaled Memory: STRB, LDRB, STRH, LDRH, STUR, LDUR
{
  const d = Decoder.decode(0x39001420); // strb w0, [x1, #5]
  assert(d.type === InstructionType.STRB_IMM, "Type must be STRB_IMM");
  assert(d.offsetBytes === 5, "Offset must be 5 bytes");
  console.log(`[PASS] STRB (Store Byte) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x39401420); // ldrb w0, [x1, #5]
  assert(d.type === InstructionType.LDRB_IMM, "Type must be LDRB_IMM");
  assert(d.offsetBytes === 5, "Offset must be 5 bytes");
  console.log(`[PASS] LDRB (Load Byte) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x79000c20); // strh w0, [x1, #6]
  assert(d.type === InstructionType.STRH_IMM, "Type must be STRH_IMM");
  assert(d.offsetBytes === 6, "Offset must be 6 bytes");
  console.log(`[PASS] STRH (Store Halfword) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x79400c20); // ldrh w0, [x1, #6]
  assert(d.type === InstructionType.LDRH_IMM, "Type must be LDRH_IMM");
  assert(d.offsetBytes === 6, "Offset must be 6 bytes");
  console.log(`[PASS] LDRH (Load Halfword) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xf81f8002); // stur x2, [x0, #-8]
  assert(d.type === InstructionType.STR_IMM, "Type must be STR_IMM (unscaled STUR)");
  assert(d.offsetBytes === -8, `Expected offset -8, got ${d.offsetBytes}`);
  console.log(`[PASS] STUR (Unscaled Negative Offset) test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xf85f8003); // ldur x3, [x0, #-8]
  assert(d.type === InstructionType.LDR_IMM, "Type must be LDR_IMM (unscaled LDUR)");
  assert(d.offsetBytes === -8, `Expected offset -8, got ${d.offsetBytes}`);
  console.log(`[PASS] LDUR (Unscaled Negative Offset) test: ${d.disassembly}`);
}

// 6. Compiler Primitives: ADRP, CSEL, CSET, MOVK, CBZ, CBNZ, 32-bit W registers
{
  const d = Decoder.decode(0x90000020); // adrp x0, [page +16384B] (immhi=1, immlo=0 -> imm21=4)
  assert(d.type === InstructionType.ADRP, "Type must be ADRP");
  assert(d.rd === 0, "Rd must be 0");
  assert(d.offsetBytes === 16384, "Offset must be 16384 bytes");
  console.log(`[PASS] ADRP test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x9a820020); // csel x0, x1, x2, eq
  assert(d.type === InstructionType.CSEL, "Type must be CSEL");
  assert(d.rd === 0 && d.rn === 1 && d.rm === 2, "Registers must match");
  console.log(`[PASS] CSEL test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x9a9f17e0); // cset x0, eq (csinc x0, xzr, xzr, ne)
  assert(d.type === InstructionType.CSINC, "Type must be CSINC (CSET)");
  assert(d.rd === 0, "Rd must be 0");
  console.log(`[PASS] CSET test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xf2a24680); // movk x0, #4660, lsl #16
  assert(d.type === InstructionType.MOVK, "Type must be MOVK");
  assert(d.rd === 0 && d.imm16 === 0x1234 && d.shift === 16, "MOVK fields must match");
  console.log(`[PASS] MOVK test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xb4000080); // cbz x0, [offset +16B]
  assert(d.type === InstructionType.CBZ, "Type must be CBZ");
  assert(d.rt === 0 && d.offsetBytes === 16, "CBZ fields must match");
  console.log(`[PASS] CBZ test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0xb5000081); // cbnz x1, [offset +16B]
  assert(d.type === InstructionType.CBNZ, "Type must be CBNZ");
  assert(d.rt === 1 && d.offsetBytes === 16, "CBNZ fields must match");
  console.log(`[PASS] CBNZ test: ${d.disassembly}`);
}
{
  const d = Decoder.decode(0x0b020020); // add w0, w1, w2 (sf=0)
  assert(d.type === InstructionType.ADD_REG && d.sf === 0, "Must be 32-bit ADD_REG (sf=0)");
  assert(d.disassembly === "add w0, w1, w2", `Expected "add w0, w1, w2", got "${d.disassembly}"`);
  console.log(`[PASS] 32-bit W Register test: ${d.disassembly}`);
}
{
  const d1 = Decoder.decode(0xd51bd040); // msr tpidr_el0, x0
  const d2 = Decoder.decode(0xd53bd041); // mrs x1, tpidr_el0
  assert(d1.type === InstructionType.MSR && d1.sysregName === "tpidr_el0", "Must decode MSR tpidr_el0");
  assert(d2.type === InstructionType.MRS && d2.sysregName === "tpidr_el0", "Must decode MRS tpidr_el0");
  console.log(`[PASS] TLS System Register test: ${d1.disassembly} / ${d2.disassembly}`);
}
{
  const d1 = Decoder.decode(0x36180080); // tbz w0, #3, [offset +16B]
  const d2 = Decoder.decode(0xb7f80081); // tbnz x1, #63, [offset +16B]
  assert(d1.type === InstructionType.TBZ && d1.bitPos === 3 && d1.offsetBytes === 16, "Must decode TBZ");
  assert(d2.type === InstructionType.TBNZ && d2.bitPos === 63 && d2.offsetBytes === 16, "Must decode TBNZ");
  console.log(`[PASS] TBZ / TBNZ test: ${d1.disassembly} / ${d2.disassembly}`);
}
{
  const dLsl = Decoder.decode(0xd37cec20); // lsl x0, x1, #4 (ubfm x0, x1, #60, #59)
  const dSxtw = Decoder.decode(0x93407c20); // sxtw x0, w1 (sbfm x0, x1, #0, #31)
  assert(dLsl.type === InstructionType.UBFM && dLsl.disassembly === "lsl x0, x1, #4", `Expected lsl x0, x1, #4, got ${dLsl.disassembly}`);
  assert(dSxtw.type === InstructionType.SBFM && dSxtw.disassembly === "sxtw x0, w1", `Expected sxtw x0, w1, got ${dSxtw.disassembly}`);
  console.log(`[PASS] Bitfield UBFM/SBFM test: ${dLsl.disassembly} / ${dSxtw.disassembly}`);
}
{
  const dRegLdr = Decoder.decode(0xf8627820); // ldr x0, [x1, x2, lsl #3]
  const dLdrsw = Decoder.decode(0xb9800020);  // ldrsw x0, [x1]
  assert(dRegLdr.type === InstructionType.LDR_IMM && dRegLdr.isRegOffset && dRegLdr.regShift === 3, "Must decode register-offset LDR");
  assert(dLdrsw.type === InstructionType.LDRSW_IMM, "Must decode LDRSW");
  console.log(`[PASS] Register-Offset & Sign-Extend Load test: ${dRegLdr.disassembly} / ${dLdrsw.disassembly}`);
}

// 7. Original Base Set Tests
{
  assert(Decoder.decode(0xd2800142).type === InstructionType.MOVZ, "MOVZ");
  assert(Decoder.decode(0x8b010003).type === InstructionType.ADD_REG, "ADD_REG");
  assert(Decoder.decode(0xaa0103e0).type === InstructionType.ORR_REG, "ORR_REG");
  assert(Decoder.decode(0xf1000442).type === InstructionType.SUBS_IMM, "SUBS_IMM");
  assert(Decoder.decode(0x54ffff81).type === InstructionType.B_COND, "B_COND");
  assert(Decoder.decode(0x14000008).type === InstructionType.B, "B");
  assert(Decoder.decode(0xd65f03c0).type === InstructionType.RET, "RET");
  assert(Decoder.decode(0xd4000001).type === InstructionType.SVC, "SVC");
  assert(Decoder.decode(0x10000081).type === InstructionType.ADR, "ADR");
  assert(Decoder.decode(0xf9000403).type === InstructionType.STR_IMM, "STR_IMM");
  assert(Decoder.decode(0xf9400404).type === InstructionType.LDR_IMM, "LDR_IMM");
  console.log(`[PASS] Base 11 instructions verified.`);
}

console.log("\nAll 44 Decoder Unit Tests Passed Successfully!");
