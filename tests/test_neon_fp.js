// tests/test_neon_fp.js - Unit & Integration Tests for ARM64 Floating-Point & NEON SIMD
import assert from "assert";
import { MiniQEMU } from "../src/emulator.js";
import { Decoder, InstructionType } from "../src/decoder.js";
import { StaticRecompiler } from "../src/static_recompiler.js";
import { Arm2X86Translator } from "../src/arm2x86.js";

console.log("Running Floating-Point & NEON SIMD Unit Tests...\n");

// 1. Test Scalar Floating-Point Arithmetic (Single & Double)
{
  const emu = new MiniQEMU();

  // Test Double Precision: FADD, FSUB, FMUL, FDIV, FSQRT, FNEG, FABS
  emu.cpu.setFRegDouble(1, 10.5);
  emu.cpu.setFRegDouble(2, 2.5);

  // fadd d0, d1, d2 (10.5 + 2.5 = 13.0)
  emu.loadProgram([0x1e622820], 0x00400000);
  emu.step(false);
  assert.strictEqual(emu.cpu.getFRegDouble(0), 13.0, "FADD Double must equal 13.0");

  // fsub d0, d1, d2 (10.5 - 2.5 = 8.0)
  emu.loadProgram([0x1e623820], 0x00400000);
  emu.step(false);
  assert.strictEqual(emu.cpu.getFRegDouble(0), 8.0, "FSUB Double must equal 8.0");

  // fmul d0, d1, d2 (10.5 * 2.5 = 26.25)
  emu.loadProgram([0x1e620820], 0x00400000);
  emu.step(false);
  assert.strictEqual(emu.cpu.getFRegDouble(0), 26.25, "FMUL Double must equal 26.25");

  // fdiv d0, d1, d2 (10.5 / 2.5 = 4.2)
  emu.loadProgram([0x1e621820], 0x00400000);
  emu.step(false);
  assert.strictEqual(emu.cpu.getFRegDouble(0), 4.2, "FDIV Double must equal 4.2");

  // fsqrt d0, d1 (sqrt(10.5))
  emu.loadProgram([0x1e61c020], 0x00400000);
  emu.step(false);
  assert.ok(Math.abs(emu.cpu.getFRegDouble(0) - Math.sqrt(10.5)) < 1e-12, "FSQRT Double must match Math.sqrt");

  // Single Precision Arithmetic
  emu.cpu.setFRegSingle(1, 3.5);
  emu.cpu.setFRegSingle(2, 1.5);
  // fadd s0, s1, s2 (3.5 + 1.5 = 5.0)
  emu.loadProgram([0x1e222820], 0x00400000);
  emu.step(false);
  assert.strictEqual(emu.cpu.getFRegSingle(0), 5.0, "FADD Single must equal 5.0");

  console.log("[PASS] Scalar floating-point basic arithmetic (Single & Double) verified");
}

// 2. Test FCMP and Condition Flag Updates (IEEE-754 NZCV)
{
  const emu = new MiniQEMU();

  // Test Greater: 10.0 > 5.0 -> N=0, Z=0, C=1, V=0
  emu.cpu.setFRegDouble(1, 10.0);
  emu.cpu.setFRegDouble(2, 5.0);
  emu.loadProgram([0x1e622020], 0x00400000); // fcmp d1, d2
  emu.step(false);
  assert.deepStrictEqual(emu.cpu.flags, { N: false, Z: false, C: true, V: false }, "FCMP greater must set C=1");

  // Test Equal: 5.0 == 5.0 -> N=0, Z=1, C=1, V=0
  emu.cpu.setFRegDouble(1, 5.0);
  emu.loadProgram([0x1e622020], 0x00400000);
  emu.step(false);
  assert.deepStrictEqual(emu.cpu.flags, { N: false, Z: true, C: true, V: false }, "FCMP equal must set Z=1, C=1");

  // Test Less: 2.0 < 5.0 -> N=1, Z=0, C=0, V=0
  emu.cpu.setFRegDouble(1, 2.0);
  emu.loadProgram([0x1e622020], 0x00400000);
  emu.step(false);
  assert.deepStrictEqual(emu.cpu.flags, { N: true, Z: false, C: false, V: false }, "FCMP less must set N=1");

  // Test Unordered (NaN comparison): NaN vs 5.0 -> N=0, Z=0, C=0, V=1
  emu.cpu.setFRegDouble(1, NaN);
  emu.loadProgram([0x1e622020], 0x00400000);
  emu.step(false);
  assert.deepStrictEqual(emu.cpu.flags, { N: false, Z: false, C: false, V: true }, "FCMP NaN must set V=1 (Unordered)");

  console.log("[PASS] FCMP comparison and NZCV flag semantics verified");
}

// 3. Test Float-Integer Conversions & Precision Transforms
{
  const emu = new MiniQEMU();

  // SCVTF: signed integer to double (x1 = -42 -> d0 = -42.0)
  emu.cpu.setReg(1, BigInt.asUintN(64, -42n));
  emu.loadProgram([0x9e620020], 0x00400000); // scvtf d0, x1
  emu.step(false);
  assert.strictEqual(emu.cpu.getFRegDouble(0), -42.0, "SCVTF must convert signed -42 to -42.0");

  // FCVTZS: float to signed integer truncate (d0 = 42.75 -> x2 = 42)
  emu.cpu.setFRegDouble(0, 42.75);
  emu.loadProgram([0x9e780002], 0x00400000); // fcvtzs x2, d0
  emu.step(false);
  assert.strictEqual(emu.cpu.getReg(2), 42n, "FCVTZS must truncate 42.75 to 42n");

  // FCVT: Single to Double (s1 = 2.5f -> d0 = 2.5d)
  emu.cpu.setFRegSingle(1, 2.5);
  emu.loadProgram([0x1e22c020], 0x00400000); // fcvt d0, s1
  emu.step(false);
  assert.strictEqual(emu.cpu.getFRegDouble(0), 2.5, "FCVT single to double must preserve value");

  // FMOV GPR <-> FPR Bitcast
  emu.cpu.setReg(3, 0x40490fdbn); // 32-bit float pi bitwise representation
  emu.loadProgram([0x1e270060], 0x00400000); // fmov s0, w3
  emu.step(false);
  assert.ok(Math.abs(emu.cpu.getFRegSingle(0) - 3.1415927) < 1e-6, "FMOV bitcast GPR to FPR must preserve bit pattern");

  console.log("[PASS] Conversions (SCVTF, FCVTZS, FCVT) & bitwise FMOV transfers verified");
}

// 4. Test NEON 128-bit SIMD Vector Arithmetic & Reductions
{
  const emu = new MiniQEMU();

  // Set Vector Q1 = [1.0, 2.0, 3.0, 4.0]
  // Set Vector Q2 = [5.0, 6.0, 7.0, 8.0]
  emu.cpu.setVRegFloat32(1, [1.0, 2.0, 3.0, 4.0]);
  emu.cpu.setVRegFloat32(2, [5.0, 6.0, 7.0, 8.0]);

  // fmul v0.4s, v1.4s, v2.4s -> [5.0, 12.0, 21.0, 32.0]
  emu.loadProgram([0x6e22dc20], 0x00400000);
  emu.step(false);
  const mulRes = Array.from(emu.cpu.getVRegFloat32(0, 4));
  assert.deepStrictEqual(mulRes, [5.0, 12.0, 21.0, 32.0], "FMUL.4S vector multiplication must match");

  // faddp v3.4s, v0.4s, v0.4s -> pairwise add: [5+12, 21+32, 5+12, 21+32] = [17.0, 53.0, 17.0, 53.0]
  emu.loadProgram([0x6e20d403], 0x00400000);
  emu.step(false);
  const pair1 = Array.from(emu.cpu.getVRegFloat32(3, 4));
  assert.deepStrictEqual(pair1, [17.0, 53.0, 17.0, 53.0], "FADDP.4S first reduction must match");

  // faddp v4.4s, v3.4s, v3.4s -> pairwise add: [17+53, ...] = [70.0, 70.0, 70.0, 70.0]
  emu.loadProgram([0x6e23d464], 0x00400000);
  emu.step(false);
  const dotProduct = emu.cpu.getVRegFloat32(4, 4)[0];
  assert.strictEqual(dotProduct, 70.0, "NEON vector dot product reduction must equal 70.0");

  console.log("[PASS] NEON SIMD 128-bit vector multiply & pairwise add reduction verified");
}

// 5. Test bin/neon_matrix.elf Execution
{
  const emu = new MiniQEMU();
  let capturedStdout = "";
  emu.onWrite = (str) => { capturedStdout += str; };

  emu.loadElf("bin/neon_matrix.elf");
  const exitCode = emu.run(10000, false);

  assert.strictEqual(exitCode, 42, "neon_matrix.elf must exit with code 42");
  assert.ok(
    capturedStdout.includes("[NEON / FP] 3D Vector magnitude & 128-bit SIMD 4xFloat dot product verified (Result = 300.0, Exit = 42)!"),
    "Captured stdout must confirm NEON matrix execution"
  );
  console.log(`[PASS] bin/neon_matrix.elf executed cleanly (Exit 42, Cycles: ${emu.cycleCount})`);
}

// 6. Test Static AOT Recompiler on neon_matrix.elf
{
  const aot = new StaticRecompiler("bin/neon_matrix.elf");
  const jsCode = aot.recompile(false);
  assert.ok(!jsCode.includes("UNHANDLED"), "AOT recompiler must have 0 unhandled instructions");
  assert.ok(jsCode.includes("vFloat32"), "AOT must include vector Float32 array");

  const bodySource = jsCode.replace(/export\s+function\s+runNative\s*\(\)\s*\{/, "").replace(/\}\s*$/, "");
  const nativeFn = new Function(bodySource);
  assert.strictEqual(nativeFn(), 42, "Static AOT runNative() must return exit code 42");
  console.log("[PASS] StaticRecompiler executes neon_matrix.elf with 0 unhandled instructions and returns 42");
}

// 7. Test x86-64 Translator on neon_matrix.elf
{
  const x86 = new Arm2X86Translator("bin/neon_matrix.elf");
  const fullAsm = x86.translate(false);
  assert.ok(!fullAsm.includes("[untranslated"), "x86-64 translator must have 0 untranslated instructions");
  assert.ok(fullAsm.includes("mulps") || fullAsm.includes("haddps"), "x86-64 translation must include SSE vector instructions");
  console.log("[PASS] Arm2X86Translator translates neon_matrix.elf to x86-64 SSE with 0 untranslated instructions");
}

// 8. Test Edge Cases: NaN/-0.0, FCVTZS Saturation, FMOV #imm8, FSUB_VEC/FABS_VEC/2D, Q=0 Zeroing & INS_ELEM
{
  const emu = new MiniQEMU();

  // (a) NaN and -0.0 preservation in setVRegFloat32 / setVRegFloat64
  emu.cpu.setVRegFloat32(5, [NaN, -0.0, 1.5, -2.5]);
  const v5 = emu.cpu.getVRegFloat32(5, 4);
  assert.ok(Number.isNaN(v5[0]), "setVRegFloat32 must preserve NaN");
  assert.ok(Object.is(v5[1], -0.0), "setVRegFloat32 must preserve -0.0");

  // (b) FCVTZS / FCVTZU saturation on NaN and +-Infinity
  emu.cpu.setFRegDouble(0, NaN);
  emu.loadProgram([0x9e780002], 0x00400000); // fcvtzs x2, d0
  emu.step(false);
  assert.strictEqual(emu.cpu.getReg(2), 0n, "FCVTZS on NaN must return 0");

  emu.cpu.setFRegDouble(0, Infinity);
  emu.loadProgram([0x9e780002], 0x00400000); // fcvtzs x2, d0
  emu.step(false);
  assert.strictEqual(emu.cpu.getReg(2), 0x7fffffffffffffffn, "FCVTZS on +Infinity must saturate to INT64_MAX");

  // (c) FMOV #imm8 with bit 1 of imm8 (bit 14 of raw instruction) set: imm8 = 0x72 -> 1.125
  const fmovImm1125 = 0x1e601000 | (0x72 << 13) | 0; // fmov d0, #1.125
  const decImm = Decoder.decode(fmovImm1125);
  assert.strictEqual(decImm.type, InstructionType.FMOV, "FMOV #1.125 must decode as FMOV");
  assert.strictEqual(decImm.immValue, 1.125, "FMOV #1.125 immediate value must be 1.125");

  // (d) FSUB_VEC 4S, FABS_VEC 4S, FNEG_VEC 4S, and FADD_VEC 2D
  emu.cpu.setVRegFloat32(1, [10.0, 20.0, 30.0, 40.0]);
  emu.cpu.setVRegFloat32(2, [1.0, 2.0, 3.0, 4.0]);
  emu.loadProgram([0x4ea2d420], 0x00400000); // fsub v0.4s, v1.4s, v2.4s
  const stepSub = emu.step(false);
  assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat32(0, 4)), [9.0, 18.0, 27.0, 36.0], "FSUB v0.4s must subtract all 4 lanes");
  assert.ok(stepSub.changedFRegs.includes(0), "stepResult.changedFRegs must track mutated V0");

  // fneg v3.4s, v0.4s (0x6ea0f803) and fabs v4.4s, v3.4s (0x4ea0f864)
  emu.loadProgram([0x6ea0f803, 0x4ea0f864], 0x00400000);
  emu.step(false);
  assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat32(3, 4)), [-9.0, -18.0, -27.0, -36.0], "FNEG v3.4s must negate all 4 lanes");
  emu.step(false);
  assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat32(4, 4)), [9.0, 18.0, 27.0, 36.0], "FABS v4.4s must take abs of all 4 lanes");

  // fadd v0.2d, v1.2d, v2.2d (0x4e62d420)
  emu.cpu.setVRegFloat64(1, [100.5, 200.25]);
  emu.cpu.setVRegFloat64(2, [0.5, 0.75]);
  emu.loadProgram([0x4e62d420], 0x00400000);
  emu.step(false);
  assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat64(0, 2)), [101.0, 201.0], "FADD v0.2d must add 2 double-precision lanes");

  // (e) Q=0 (64-bit vector) upper-64-bit zeroing on bitwise NOT (mvn v0.8b, v1.8b -> 0x2e205820)
  emu.cpu.vUint64[0] = 0xffffffffffffffffn;
  emu.cpu.vUint64[1] = 0xffffffffffffffffn;
  emu.cpu.vUint64[2] = 0x00ff00ff00ff00ffn; // v1 low 64
  emu.loadProgram([0x2e205820], 0x00400000); // mvn v0.8b, v1.8b
  emu.step(false);
  assert.strictEqual(emu.cpu.vUint64[0], 0xff00ff00ff00ff00n, "mvn v0.8b low 64 bits must be inverted");
  assert.strictEqual(emu.cpu.vUint64[1], 0n, "mvn v0.8b upper 64 bits must be zeroed when Q=0");

  // (f) INS_ELEM: ins v0.s[2], v1.s[1] (Q=1, op=1, imm5=0b10100 (20), imm4=0b0100 (4))
  const insElemInstr = 0x6e000400 | (20 << 16) | (4 << 11) | (1 << 5) | 0;
  emu.cpu.setVRegUint32(0, [10, 20, 30, 40]);
  emu.cpu.setVRegUint32(1, [111, 222, 333, 444]);
  emu.loadProgram([insElemInstr], 0x00400000);
  emu.step(false);
  assert.deepStrictEqual(Array.from(emu.cpu.getVRegUint32(0, 4)), [10, 20, 222, 40], "INS v0.s[2], v1.s[1] must copy lane 1 to lane 2");

  console.log("[PASS] Edge cases (NaN/-0.0, FCVTZS saturation, FMOV #imm8, FSUB/FABS/2D, Q=0 zeroing & INS_ELEM) verified");
}

console.log("\nAll Floating-Point & NEON SIMD Tests Passed Successfully!");
