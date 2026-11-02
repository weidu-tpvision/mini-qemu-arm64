// tests/test_decoder.js - Unit tests for ARM64 Decoder (32+ Base Instructions)
import { Decoder, InstructionType } from "../src/decoder.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

console.log("Running ARM64 Instruction Decoder Extended Unit Tests...\n");

// 1. Math: MUL, SDIV, UDIV
{
  const d = Decoder.decode(0x9b027c20); // mul x0, x1, x2
  assert(d.type === InstructionType.MUL, "Type must be MUL");
  assert(d.rd === 0 && d.rn === 1 && d.rm === 2, "Registers must match");
  console.log(`[PASS] MUL test: ${d.disassembly}`);
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

// 5. Byte Memory: STRB, LDRB
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

// 6. Original Base Set Tests
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

console.log("\nAll 23 Decoder Unit Tests Passed Successfully!");
