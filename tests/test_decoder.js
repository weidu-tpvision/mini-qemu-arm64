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
  assert(d.condName === "eq", `CSEL must include condName="eq", got "${d.condName}"`);
  console.log(`[PASS] CSEL test (with condName): ${d.disassembly}`);
}
{
  // Shifted ADD_REG (lsr #3) and shifted ORR_REG (lsl #2)
  const dAddLsr = Decoder.decode(0x8b420c20); // add x0, x1, x2, lsr #3
  assert(dAddLsr.type === InstructionType.ADD_REG && dAddLsr.shift === 1 && dAddLsr.imm6 === 3, "Shifted ADD_REG fields");
  assert(dAddLsr.disassembly === "add x0, x1, x2, lsr #3", `Expected "add x0, x1, x2, lsr #3", got "${dAddLsr.disassembly}"`);

  const dOrrLsl = Decoder.decode(0xaa020820); // orr x0, x1, x2, lsl #2
  assert(dOrrLsl.type === InstructionType.ORR_REG && dOrrLsl.shift === 0 && dOrrLsl.imm6 === 2, "Shifted ORR_REG fields");
  assert(dOrrLsl.disassembly === "orr x0, x1, x2, lsl #2", `Expected "orr x0, x1, x2, lsl #2", got "${dOrrLsl.disassembly}"`);

  // 32-bit STP / LDP (opc=00 -> w registers, scale=4)
  const dStpW = Decoder.decode(0x29010be1); // stp w1, w2, [sp, #8] (imm7=2 * 4 = 8)
  assert(dStpW.type === InstructionType.STP && dStpW.sf === 0 && dStpW.offsetBytes === 8, "32-bit STP fields");
  assert(dStpW.disassembly === "stp w1, w2, [sp, #8]", `Expected "stp w1, w2, [sp, #8]", got "${dStpW.disassembly}"`);

  const dLdpW = Decoder.decode(0x29410be1); // ldp w1, w2, [sp, #8] (imm7=2 * 4 = 8)
  assert(dLdpW.type === InstructionType.LDP && dLdpW.sf === 0 && dLdpW.offsetBytes === 8, "32-bit LDP fields");
  assert(dLdpW.disassembly === "ldp w1, w2, [sp, #8]", `Expected "ldp w1, w2, [sp, #8]", got "${dLdpW.disassembly}"`);
  console.log(`[PASS] Shifted ADD/ORR & 32-bit STP/LDP decoding verified.`);
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

// 8. Static Libc Primitives & Memory Barriers: NOP, DMB, ISB, CLZ, REV/REV16/REV32, RBIT, EXTR, LDXR/STXR
{
  assert(Decoder.decode(0xd503201f).type === InstructionType.NOP, "NOP");
  assert(Decoder.decode(0xd50335bf).type === InstructionType.DMB, "DMB");
  assert(Decoder.decode(0xd5033fdf).type === InstructionType.ISB, "ISB");
  assert(Decoder.decode(0xd503203f).type === InstructionType.YIELD, "YIELD");
  assert(Decoder.decode(0x5ac01001).type === InstructionType.CLZ, "CLZ 32-bit");
  assert(Decoder.decode(0xdac01043).type === InstructionType.CLZ, "CLZ 64-bit");
  assert(Decoder.decode(0x5ac00885).type === InstructionType.REV, "REV 32-bit");
  assert(Decoder.decode(0xdac00cc7).type === InstructionType.REV, "REV 64-bit");
  assert(Decoder.decode(0x5ac00509).type === InstructionType.REV16, "REV16");
  assert(Decoder.decode(0xdac0094b).type === InstructionType.REV32, "REV32");
  assert(Decoder.decode(0x5ac0018d).type === InstructionType.RBIT, "RBIT");
  assert(Decoder.decode(0x93ce11cf).type === InstructionType.EXTR, "EXTR / ROR");
  assert(Decoder.decode(0xc85f7fe0).type === InstructionType.LDXR, "LDXR");
  assert(Decoder.decode(0xc8017fe0).type === InstructionType.STXR, "STXR");
  console.log(`[PASS] Static Libc & Hardware Barrier instructions (NOP, DMB, ISB, CLZ, REV, EXTR, LDXR, STXR) verified.`);
}

// 9. Edge-case & Regression Tests: 1-source vs 2-source, PACIASP/hints, Exclusive byte/pair/ordered, CAS unknown
{
  const dUdiv = Decoder.decode(0x1ac00862); // udiv w2, w3, w0
  assert(dUdiv.type === InstructionType.UDIV, `Expected UDIV, got ${dUdiv.type}`);
  assert(dUdiv.rd === 2 && dUdiv.rn === 3 && dUdiv.rm === 0 && dUdiv.sf === 0, "udiv w2, w3, w0 fields must match");

  const dSdiv = Decoder.decode(0x9ac00c20); // sdiv x0, x1, x0
  assert(dSdiv.type === InstructionType.SDIV, `Expected SDIV, got ${dSdiv.type}`);
  assert(dSdiv.rd === 0 && dSdiv.rn === 1 && dSdiv.rm === 0 && dSdiv.sf === 1, "sdiv x0, x1, x0 fields must match");

  const dPac = Decoder.decode(0xd503233f); // paciasp
  assert(dPac.type === InstructionType.NOP, `paciasp must decode as NOP, got ${dPac.type}`);
  assert(dPac.disassembly === "paciasp", `paciasp disassembly expected "paciasp", got "${dPac.disassembly}"`);

  const dLdxrb = Decoder.decode(0x085f7c20); // ldxrb w0, [x1]
  assert(dLdxrb.type === InstructionType.LDXR && dLdxrb.bytes === 1 && dLdxrb.exclusive === true && dLdxrb.pair === false, "ldxrb must have bytes=1, exclusive=true, pair=false");

  const dStlr = Decoder.decode(0xc89ffc20); // stlr x0, [x1]
  assert(dStlr.type === InstructionType.STXR && dStlr.exclusive === false && dStlr.bytes === 8, "stlr must have exclusive=false, bytes=8");

  const dLdxp = Decoder.decode(0xc87f0440); // ldxp x0, x1, [x2]
  assert(dLdxp.type === InstructionType.LDXR && dLdxp.pair === true && dLdxp.rt2 === 1 && dLdxp.bytes === 8, "ldxp must have pair=true, rt2=1, bytes=8");

  const dCas = Decoder.decode(0xc8a07c41); // cas x0, x1, [x2]
  assert(dCas.type === InstructionType.CAS, `CAS must decode as CAS, got ${dCas.type}`);
  assert(dCas.disassembly === "cas x0, x1, [x2]", `CAS disassembly mismatch: ${dCas.disassembly}`);

  const dLdadd = Decoder.decode(0xf8200041); // ldadd x0, x1, [x2]
  assert(dLdadd.type === InstructionType.LDADD && dLdadd.bytes === 8, "ldadd x0, x1, [x2] must decode as LDADD");
  assert(dLdadd.disassembly === "ldadd x0, x1, [x2]", `LDADD disassembly mismatch: ${dLdadd.disassembly}`);

  const dSwp = Decoder.decode(0xf8208041); // swp x0, x1, [x2]
  assert(dSwp.type === InstructionType.SWP && dSwp.bytes === 8, "swp x0, x1, [x2] must decode as SWP");
  assert(dSwp.disassembly === "swp x0, x1, [x2]", `SWP disassembly mismatch: ${dSwp.disassembly}`);

  console.log(`[PASS] Regression tests (1-src vs 2-src, PACIASP, LDXRB, STLR, LDXP, CAS, LDADD, SWP) verified.`);
}

console.log("\nAll Decoder Unit Tests Passed Successfully!");
