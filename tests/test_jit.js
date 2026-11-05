// test_jit.js - Comprehensive Dynamic Just-In-Time (JIT) Compiler Unit & Benchmark Tests
import nodeAssert from "node:assert";
import { MiniQEMU } from "../src/emulator.js";
import { JitCompiler } from "../src/jit.js";
import { Memory } from "../src/memory.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
assert.deepStrictEqual = (actual, expected, message) => nodeAssert.deepStrictEqual(actual, expected, message);
assert.strictEqual = (actual, expected, message) => nodeAssert.strictEqual(actual, expected, message);

console.log("Running Dynamic Just-In-Time (JIT) Compiler Unit Tests...\n");

// --- Test 1: Tiered Compilation & Hotness Profiling ---
{
  const emu = new MiniQEMU({ jitHotThreshold: 5 });
  // Simple loop:
  // x0 = 0 (counter)
  // x1 = 20 (limit)
  // loop:
  //   add x0, x0, #1
  //   cmp x0, x1
  //   b.ne loop
  // exit:
  //   movz x8, #93 (sys_exit)
  //   svc #0
  const instructions = [
    0xd2800000, // 0x400000: movz x0, #0
    0xd2800281, // 0x400004: movz x1, #20
    // <loop>: 0x400008
    0x91000400, // 0x400008: add x0, x0, #1
    0xeb01001f, // 0x40000c: cmp x0, x1 (subs xzr, x0, x1)
    0x54000000 | (((-2) & 0x7ffff) << 5) | 1, // 0x400010: b.ne 0x400008 (-2 instrs / -8 bytes = 0x54ffffc1)
    // <exit>: 0x400014
    0xd2800ba8, // 0x400014: movz x8, #93
    0xd4000001  // 0x400018: svc #0
  ];

  emu.loadProgram(instructions, 0x00400000);
  emu.run(100, false);

  assert(emu.cpu.halted, "Program must halt via sys_exit");
  assert(emu.cpu.getReg(0) === 20n, `x0 must be 20, got ${emu.cpu.getReg(0)}`);

  const stats = emu.getJitStats();
  assert(stats.enabled === true, "JIT must be enabled");
  assert(stats.compiledBlocks >= 1, `Must compile at least 1 hot block, got ${stats.compiledBlocks}`);
  assert(stats.blockExecutions >= 15, `Compiled loop block must execute at least 15 times, got ${stats.blockExecutions}`);
  assert(stats.jitCycles > 0, `Must record JIT cycles, got ${stats.jitCycles}`);
  assert(stats.jitPercentage > 50, `JIT coverage must be > 50%, got ${stats.jitPercentage}%`);

  const blocks = emu.getJitBlocks();
  const loopBlock = blocks.find(b => b.startPC === 0x00400008);
  assert(loopBlock !== undefined, "Loop block at 0x400008 must be compiled");
  assert(loopBlock.instrCount === 3, `Loop block must have 3 instructions, got ${loopBlock.instrCount}`);
  assert(loopBlock.execCount >= 15, `Loop block execCount must be >= 15, got ${loopBlock.execCount}`);

  console.log(`[PASS] Tiered compilation verified: ${stats.compiledBlocks} blocks compiled, ${stats.blockExecutions} block executions, JIT coverage: ${stats.jitPercentage}%`);
}

// --- Test 2: Bit-Exact Parity Across All Standard Guest Binaries (Interpreter vs JIT) ---
{
  const binariesToTest = [
    { file: "bin/fib.elf", expectedExit: 55 },
    { file: "bin/fib_rec.elf", expectedExit: 55 },
    { file: "bin/math_func.elf", expectedExit: 52 },
    { file: "bin/heap_demo.elf", expectedExit: 150 },
    { file: "bin/dynamic_memory.elf", expectedExit: 42 },
    { file: "bin/neon_matrix.elf", expectedExit: 42 },
    { file: "bin/graphics_pattern.elf", expectedExit: 0 },
    { file: "bin/plasma.elf", expectedExit: 0 }
  ];

  for (const item of binariesToTest) {
    const isGraphics = item.file.includes("graphics") || item.file.includes("plasma");
    const runCycles = isGraphics ? 2000000 : 200000;

    // 1. Run in Pure Interpreter Mode
    const interpEmu = new MiniQEMU({ jitEnabled: false });
    interpEmu.loadElf(item.file);
    const interpExit = interpEmu.run(runCycles, false);
    assert(interpExit === item.expectedExit, `Interpreter on ${item.file} expected exit ${item.expectedExit}, got ${interpExit}`);

    // 2. Run in Dynamic JIT Mode
    const jitEmu = new MiniQEMU({ jitEnabled: true, jitHotThreshold: 3 });
    jitEmu.loadElf(item.file);
    const jitExit = jitEmu.run(runCycles, false);
    assert(jitExit === item.expectedExit, `JIT on ${item.file} expected exit ${item.expectedExit}, got ${jitExit}`);

    // Verify CPU registers bit-exact equivalence
    for (let r = 0; r < 31; r++) {
      const interpReg = interpEmu.cpu.getReg(r);
      const jitReg = jitEmu.cpu.getReg(r);
      assert(interpReg === jitReg, `Register X${r} mismatch on ${item.file}: interp=0x${interpReg.toString(16)}, jit=0x${jitReg.toString(16)}`);
    }

    // Verify Flags bit-exact equivalence
    assert(interpEmu.cpu.flags.Z === jitEmu.cpu.flags.Z, `Flag Z mismatch on ${item.file}`);
    assert(interpEmu.cpu.flags.N === jitEmu.cpu.flags.N, `Flag N mismatch on ${item.file}`);
    assert(interpEmu.cpu.flags.C === jitEmu.cpu.flags.C, `Flag C mismatch on ${item.file}`);
    assert(interpEmu.cpu.flags.V === jitEmu.cpu.flags.V, `Flag V mismatch on ${item.file}`);

    // Verify Vector/FP registers
    for (let v = 0; v < 32; v++) {
      const interpLow = interpEmu.cpu.vUint64[v * 2];
      const jitLow = jitEmu.cpu.vUint64[v * 2];
      const interpHigh = interpEmu.cpu.vUint64[v * 2 + 1];
      const jitHigh = jitEmu.cpu.vUint64[v * 2 + 1];
      assert(interpLow === jitLow && interpHigh === jitHigh, `Vector V${v} mismatch on ${item.file}`);
    }

    const jitStats = jitEmu.getJitStats();
    console.log(`[PASS] ${item.file.padEnd(26, " ")}: 100% bit-exact parity! (${jitStats.compiledBlocks} blocks, ${jitStats.jitPercentage}% JIT)`);
  }

  console.log("\nVerifying 100% Hot-Compiled JIT Execution (jitHotThreshold = 1) Across All 8 Binaries...");
  for (const item of binariesToTest) {
    const isGraphics = item.file.includes("graphics") || item.file.includes("plasma");
    const runCycles = isGraphics ? 2000000 : 200000;

    const interpEmu = new MiniQEMU({ jitEnabled: false });
    interpEmu.loadElf(item.file);
    const interpExit = interpEmu.run(runCycles, false);

    const jitEmu = new MiniQEMU({ jitEnabled: true, jitHotThreshold: 1 });
    jitEmu.loadElf(item.file);
    const jitExit = jitEmu.run(runCycles, false);

    assert(jitExit === item.expectedExit, `JIT (threshold=1) on ${item.file} expected exit ${item.expectedExit}, got ${jitExit}`);
    for (let r = 0; r < 31; r++) {
      assert(interpEmu.cpu.getReg(r) === jitEmu.cpu.getReg(r), `Register X${r} mismatch on ${item.file}`);
    }
    const jitStats = jitEmu.getJitStats();
    assert(jitStats.jitPercentage === 100, `Expected 100% JIT coverage for ${item.file} with hotThreshold=1, got ${jitStats.jitPercentage}%`);
    assert(jitStats.compiledBlocks > 0, `Expected compiled blocks > 0 for ${item.file}`);
    console.log(`[PASS] ${item.file.padEnd(26, " ")}: 100% bit-exact parity & 100% JIT! (${jitStats.compiledBlocks} blocks)`);
  }
}

// --- Test 3: Cache Invalidation & Self-Modifying Code ---
{
  const emu = new MiniQEMU({ jitHotThreshold: 2 });
  // Program:
  // 0x400000: add x0, x0, #1
  // 0x400004: b 0x400000
  const instructions = [
    0x91000400, // add x0, x0, #1
    0x17ffffff  // b -1 instr (-4B) -> 0x400000
  ];
  emu.loadProgram(instructions, 0x00400000);

  // Run 10 cycles to trigger JIT compilation
  emu.run(10, false);
  assert(emu.jit.blockCache.has(0x00400000), "Block 0x400000 must be compiled");
  assert(emu.cpu.getReg(0) >= 4n, `Counter x0 must be >= 4, got ${emu.cpu.getReg(0)}`);

  // Now dynamically modify code in memory (Self-Modifying Code):
  // Replace 0x400000 with: add x0, x0, #10 (0x91002800)
  emu.memory.write32(0x00400000, 0x91002800);
  // Invalidate range
  const invalidated = emu.jit.invalidateRange(0x00400000, 4);
  assert(invalidated === 1, `Must invalidate 1 block, got ${invalidated}`);
  assert(!emu.jit.blockCache.has(0x00400000), "Block 0x400000 must be removed from cache");

  const prevX0 = emu.cpu.getReg(0);
  emu.run(emu.cycleCount + 10, false);
  const diff = emu.cpu.getReg(0) - prevX0;
  assert(diff >= 30n, `After SMC modification, step by 10 must increase counter significantly, got diff ${diff}`);
  console.log(`[PASS] Cache invalidation & Self-Modifying Code handling verified successfully`);
}

// --- Test 4: Comprehensive JIT Instruction & Edge-Case Verification ---
{
  console.log("\nRunning Comprehensive JIT Instruction & Edge-Case Verification Suite...");

  // 1. Hot loop with SVC syscall inside JIT block (sys_getpid, sys_sched_yield, sys_write)
  {
    const emu = new MiniQEMU({ jitHotThreshold: 2 });
    let writes = "";
    emu.onWrite = (s) => { writes += s; };
    emu.memory.write8(0x500000, 72); // 'H'
    emu.memory.write8(0x500001, 105); // 'i'

    const code = [
      0xd28000b3, // movz x19, #5
      // <loop>: 0x400004
      0xd2801588, // movz x8, #172 (getpid)
      0xd4000001, // svc #0
      0xd2800f88, // movz x8, #124 (sched_yield)
      0xd4000001, // svc #0
      0xd2800020, // movz x0, #1
      0xd2a00a01, // movz x1, #0x50, lsl #16
      0xd2800042, // movz x2, #2
      0xd2800808, // movz x8, #64 (write)
      0xd4000001, // svc #0
      0xf1000673, // subs x19, x19, #1
      0x54000000 | (((-10) & 0x7ffff) << 5) | 1, // b.ne loop
      0xd2800ba8, // movz x8, #93
      0xd2800000, // movz x0, #0
      0xd4000001  // svc #0
    ];

    emu.loadProgram(code, 0x400000);
    emu.run(200, false);
    assert(emu.cpu.halted, "SVC loop must halt cleanly");
    assert(writes === "HiHiHiHiHi", `Expected 'HiHiHiHiHi', got '${writes}'`);
    assert(emu.getJitStats().compiledBlocks >= 3, `Expected compiled blocks >= 3, got ${emu.getJitStats().compiledBlocks}`);
    console.log(`  [PASS] Hot loop with SVC syscalls inside JIT block verified`);
  }

  // 2. Hot loop with FMOV and FCVTZS/FCVTZU saturation (Infinity, -Infinity, NaN, 64-bit limits)
  {
    const emu = new MiniQEMU({ jitHotThreshold: 2 });
    emu.cpu.setReg(0, 0x123456789abcdef0n);
    emu.cpu.setFRegDouble(10, Infinity);
    emu.cpu.setFRegDouble(11, -Infinity);
    emu.cpu.setFRegDouble(12, NaN);
    emu.cpu.setFRegSingle(15, Infinity);
    emu.cpu.setFRegSingle(16, -Infinity);
    emu.cpu.setFRegSingle(17, NaN);

    const fmovImmD = 0x1e601000 | (0x72 << 13) | 0; // fmov d0, #1.125
    const fmovGprFprD = 0x9e670001; // fmov d1, x0
    const fmovFprGprD = 0x9e660022; // fmov x2, d1
    const fmovFprFprD = 0x1e604005; // fmov d5, d0
    const fcvtzsXPosInf = 0x9e780147; // fcvtzs x7, d10
    const fcvtzsXNegInf = 0x9e780174; // fcvtzs x20, d11 (rd=20)
    const fcvtzsWPosInf = 0x1e3801e9; // fcvtzs w9, s15
    const fcvtzsWNegInf = 0x1e38020a; // fcvtzs w10, s16
    const fcvtzsXNan = 0x9e78018b; // fcvtzs x11, d12
    const fcvtzuXPosInf = 0x9e79014c; // fcvtzu x12, d10
    const fcvtzuWPosInf = 0x1e3901ed; // fcvtzu w13, s15
    const fcvtzuXNan = 0x9e79018e; // fcvtzu x14, d12

    const loop = [
      0xd2800073, // movz x19, #3
      // <loop>: 0x400004
      fmovImmD,
      fmovGprFprD,
      fmovFprGprD,
      fmovFprFprD,
      fcvtzsXPosInf,
      fcvtzsXNegInf,
      fcvtzsWPosInf,
      fcvtzsWNegInf,
      fcvtzsXNan,
      fcvtzuXPosInf,
      fcvtzuWPosInf,
      fcvtzuXNan,
      0xf1000673, // subs x19, x19, #1
      0x54000000 | (((-13) & 0x7ffff) << 5) | 1, // b.ne
      0xd2800ba8, // movz x8, #93
      0xd4000001  // svc #0
    ];

    emu.loadProgram(loop, 0x400000);
    emu.run(100, false);
    assert(emu.cpu.getFRegDouble(0) === 1.125, "FMOV immediate must load 1.125");
    assert(emu.cpu.getReg(2) === 0x123456789abcdef0n, "FMOV FPR->GPR must transfer bit pattern");
    assert(emu.cpu.getFRegDouble(5) === 1.125, "FMOV FPR->FPR must copy register");
    assert(emu.cpu.getReg(7) === 0x7fffffffffffffffn, "FCVTZS +Infinity must saturate to INT64_MAX");
    assert(emu.cpu.getReg(20) === 0x8000000000000000n, "FCVTZS -Infinity must saturate to INT64_MIN");
    assert(emu.cpu.getReg(9) === 0x7fffffffn, "FCVTZS 32-bit +Infinity must saturate to INT32_MAX");
    assert(emu.cpu.getReg(10) === 0x80000000n, "FCVTZS 32-bit -Infinity must saturate to INT32_MIN");
    assert(emu.cpu.getReg(11) === 0n, "FCVTZS NaN must produce 0");
    assert(emu.cpu.getReg(12) === 0xffffffffffffffffn, "FCVTZU +Infinity must saturate to UINT64_MAX");
    assert(emu.cpu.getReg(13) === 0xffffffffn, "FCVTZU 32-bit +Infinity must saturate to UINT32_MAX");
    assert(emu.cpu.getReg(14) === 0n, "FCVTZU NaN must produce 0");
    console.log(`  [PASS] FMOV immediate/registers and FCVTZS/FCVTZU IEEE saturation verified`);
  }

  // 3. Hot loop with NEON vector instructions (ADD_VEC, SUB_VEC, MUL_VEC, ADDP_VEC, FADDP_VEC 2S/4S, FNEG_VEC, FABS_VEC, DUP_ELEM, AND_VEC 8B)
  {
    const emu = new MiniQEMU({ jitHotThreshold: 2 });
    emu.cpu.setVRegUint32(1, [10, 20, 30, 40]);
    emu.cpu.setVRegUint32(2, [1, 2, 3, 4]);
    emu.cpu.setVRegFloat32(11, [1.0, 2.0, 3.0, 4.0]);

    const addVec = 0x4ea28420; // add v0.4s, v1.4s, v2.4s -> [11, 22, 33, 44]
    const subVec = 0x6ea28423; // sub v3.4s, v1.4s, v2.4s -> [9, 18, 27, 36]
    const mulVec = 0x4ea29c24; // mul v4.4s, v1.4s, v2.4s -> [10, 40, 90, 160]
    const addpVec = 0x4ea2b425; // addp v5.4s, v1.4s, v2.4s -> [30, 70, 3, 7]
    const faddp4s = 0x6e20d400 | (11 << 16) | (11 << 5) | 12; // faddp v12.4s, v11.4s, v11.4s -> [3.0, 7.0, 3.0, 7.0]
    const faddp2s = 0x2e20d400 | (11 << 16) | (11 << 5) | 6;  // faddp v6.2s, v11.2s, v11.2s -> [3.0, 3.0, 0, 0]
    const fneg4s = 0x6ea0f800 | (11 << 5) | 7;  // fneg v7.4s, v11.4s -> [-1.0, -2.0, -3.0, -4.0]
    const fabs4s = 0x4ea0f800 | (7 << 5) | 8;   // fabs v8.4s, v7.4s -> [1.0, 2.0, 3.0, 4.0]
    const dupElem = 0x4e000400 | (12 << 16) | (1 << 5) | 9; // dup v9.4s, v1.s[1] (20)
    const and8b = 0x0e221c2a;   // and v10.8b, v1.8b, v2.8b (Q=0)

    const loop = [
      0xd2800073, // movz x19, #3
      // <loop>: 0x400004
      addVec,
      subVec,
      mulVec,
      addpVec,
      faddp4s,
      faddp2s,
      fneg4s,
      fabs4s,
      dupElem,
      and8b,
      0xf1000673, // subs x19, x19, #1
      0x54000000 | (((-11) & 0x7ffff) << 5) | 1, // b.ne
      0xd2800ba8, // movz x8, #93
      0xd4000001  // svc #0
    ];

    emu.loadProgram(loop, 0x400000);
    emu.run(100, false);
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegUint32(0, 4)), [11, 22, 33, 44], "ADD_VEC must add 4S lanes");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegUint32(3, 4)), [9, 18, 27, 36], "SUB_VEC must sub 4S lanes");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegUint32(4, 4)), [10, 40, 90, 160], "MUL_VEC must mul 4S lanes");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegUint32(5, 4)), [30, 70, 3, 7], "ADDP_VEC must pairwise add lanes");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat32(12, 4)), [3.0, 7.0, 3.0, 7.0], "FADDP_VEC 4S must pairwise add 4 float lanes");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat32(6, 4)), [3.0, 3.0, 0, 0], "FADDP_VEC 2S must pairwise add 2 float lanes and clear upper 64 bits");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat32(7, 4)), [-1.0, -2.0, -3.0, -4.0], "FNEG_VEC 4S must negate float lanes");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegFloat32(8, 4)), [1.0, 2.0, 3.0, 4.0], "FABS_VEC 4S must compute abs of float lanes");
    assert.deepStrictEqual(Array.from(emu.cpu.getVRegUint32(9, 4)), [20, 20, 20, 20], "DUP_ELEM must broadcast lane 1 across all lanes");
    assert.strictEqual(emu.cpu.vUint64[10 * 2 + 1], 0n, "AND_VEC (Q=0) must clear upper 64 bits");
    console.log(`  [PASS] NEON SIMD vector arithmetic, reductions, and element operations verified`);
  }

  // 4. Hot loop with 32-bit sf=0 operations (MOVN, SUBS, shifted ADD_REG, UDIV, CSINV, LDRSH)
  {
    const emu = new MiniQEMU({ jitHotThreshold: 2 });
    emu.memory.write16(0x600000, 0xfb2e); // -1234
    emu.cpu.setReg(6, 0x600000n);
    emu.cpu.setReg(10, 10n);
    emu.cpu.setReg(11, 0xfffffff0n); // -16
    emu.cpu.setReg(12, 20n);

    const movnW0 = 0x12800000; // movn w0, #0 -> 0xffffffffn
    const subsW1 = 0x71000000 | (5 << 10) | (12 << 5) | 1; // subs w1, w12, #5 -> 15n
    const addAsr = 0x0b800000 | (11 << 16) | (2 << 10) | (10 << 5) | 2; // add w2, w10, w11, asr #2: 10 + (-4) = 6
    const udivW3 = 0x1ac00800 | (2 << 16) | (1 << 5) | 3; // udiv w3, w1, w2 -> 15 / 6 = 2
    const csinv = (0x0d4 << 21) | (2 << 16) | (0 << 12) | (0b10 << 10) | (1 << 5) | 4; // csinv w4, w1, w2, eq (Z is false -> ~6 = 0xfffffff9)
    const ldrshW5 = 0x79c000c5; // ldrsh w5, [x6] -> 0xfffffb2en

    const loop = [
      0xd2800073, // movz x19, #3
      // <loop>: 0x400004
      movnW0,
      subsW1,
      addAsr,
      udivW3,
      csinv,
      ldrshW5,
      0xf1000673, // subs x19, x19, #1
      0x54000000 | (((-7) & 0x7ffff) << 5) | 1, // b.ne
      0xd2800ba8, // movz x8, #93
      0xd4000001  // svc #0
    ];

    emu.loadProgram(loop, 0x400000);
    emu.run(100, false);
    assert(emu.cpu.getReg(0) === 0xffffffffn, "MOVN w0 must mask to 32 bits");
    assert(emu.cpu.getReg(2) === 6n, "ADD w2 with ASR #2 shift must compute 6n");
    assert(emu.cpu.getReg(3) === 2n, "UDIV w3 must compute 32-bit quotient 2n");
    assert(emu.cpu.getReg(4) === 0xfffffff9n, "CSINV w4 must mask inverted value to 32 bits");
    assert(emu.cpu.getReg(5) === 0xfffffb2en, "LDRSH w5 must sign-extend 16-bit to 32 bits (zero-extending upper 32)");
    console.log(`  [PASS] 32-bit sf=0 operations (MOVN, SUBS, ASR-shifted ADD, UDIV, CSINV, LDRSH) verified`);
  }

  // 5. Mid-block breakpoint stopping at exact breakpoint PC inside a hot loop
  {
    const emu = new MiniQEMU({ jitHotThreshold: 2 });
    const code = [
      0x91000400, // 0x400000: add x0, x0, #1
      0x91000821, // 0x400004: add x1, x1, #2
      0x91000c42, // 0x400008: add x2, x2, #3
      0x17fffffd  // 0x40000c: b -3 instrs -> 0x400000
    ];
    emu.loadProgram(code, 0x400000);
    emu.run(10, false);
    assert(emu.getJitStats().compiledBlocks >= 1, "Must compile initial loop block");

    // Add breakpoint at 0x400004
    emu.addBreakpoint(0x400004);
    emu.run(emu.cycleCount + 20, false);
    assert(emu.cpu.pc === 0x400004n, `Execution must halt exactly at breakpoint 0x400004, got 0x${emu.cpu.pc.toString(16)}`);
    assert(emu.breakpoints.has(Number(emu.cpu.pc)), "Halted PC must match active breakpoint");
    console.log(`  [PASS] Mid-block breakpoint accurately split block and halted at target PC`);
  }

  console.log("[PASS] Comprehensive JIT Instruction & Edge-Case Verification completed successfully!");
}

// --- Test 5: Subroutine Call / Return Chaining & Deep Recursion under JIT ---
{
  const emu = new MiniQEMU({ jitHotThreshold: 3 });
  emu.loadElf("bin/fib_rec.elf");
  emu.run(50000, false);

  assert(emu.cpu.halted, "Recursive Fibonacci must halt");
  assert(emu.cpu.exitCode === 55, `fib(10) must return 55, got ${emu.cpu.exitCode}`);
  const stats = emu.getJitStats();
  assert(stats.compiledBlocks >= 3, `Recursive binary must compile multiple blocks, got ${stats.compiledBlocks}`);
  assert(stats.blockExecutions > 100, `Must execute compiled recursive blocks over 100 times, got ${stats.blockExecutions}`);
  console.log(`[PASS] Recursive stack frames and BL/RET subroutine chaining verified under JIT (${stats.blockExecutions} block executions)`);
}

// --- Test 6: Performance Benchmark: Pure Interpreter vs. Dynamic JIT ---
{
  console.log("\n--- JIT Performance Benchmark: 2,000,000 Cycle Heavy Computational Workload ---");
  // Tight benchmark program:
  // x0 = 0 (accumulator)
  // x1 = 500,000 (iterations)
  // loop:
  //   add x0, x0, #3
  //   subs x1, x1, #1
  //   b.ne loop
  // exit:
  //   movz x8, #93
  //   svc #0
  const benchInstructions = [
    0xd2800000, // movz x0, #0
    0xd283d081, // movz x1, #0x1e84, lsl #0
    0xf2a000e1, // movk x1, #7, lsl #16 -> x1 = 500,000
    // <loop>: 0x40000c
    0x91000c00, // add x0, x0, #3
    0xf1000421, // subs x1, x1, #1
    0x54000000 | (((-2) & 0x7ffff) << 5) | 1, // b.ne 0x40000c (-2 instrs / -8B)
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];

  // 1. Measure Pure Interpreter
  const interpEmu = new MiniQEMU({ jitEnabled: false });
  interpEmu.loadProgram(benchInstructions, 0x00400000);
  const t0Interp = performance.now();
  interpEmu.run(2000000, false);
  const t1Interp = performance.now();
  const interpMs = t1Interp - t0Interp;
  assert(interpEmu.cpu.getReg(0) === 1399692n, `Interp result must be 1,399,692, got ${interpEmu.cpu.getReg(0)}`);

  // 2. Measure Dynamic JIT
  const jitEmu = new MiniQEMU({ jitEnabled: true, jitHotThreshold: 5 });
  jitEmu.loadProgram(benchInstructions, 0x00400000);
  const t0Jit = performance.now();
  jitEmu.run(2000000, false);
  const t1Jit = performance.now();
  const jitMs = t1Jit - t0Jit;
  assert(jitEmu.cpu.getReg(0) === 1399692n, `JIT result must be 1,399,692, got ${jitEmu.cpu.getReg(0)}`);

  const speedup = (interpMs / Math.max(0.1, jitMs)).toFixed(1);
  const interpMhz = ((interpEmu.cycleCount / 1_000_000) / (interpMs / 1000)).toFixed(2);
  const jitMhz = ((jitEmu.cycleCount / 1_000_000) / (jitMs / 1000)).toFixed(2);

  console.log(`  Pure Interpreter : ${interpMs.toFixed(2)} ms (${interpMhz} MHz equivalent)`);
  console.log(`  Dynamic JIT      : ${jitMs.toFixed(2)} ms (${jitMhz} MHz equivalent)`);
  console.log(`  Speedup Factor   : ${speedup}x FASTER than interpreter!`);
  console.log(`  JIT Telemetry    : ${jitEmu.getJitStats().compiledBlocks} compiled blocks, ${jitEmu.getJitStats().jitPercentage}% JIT execution`);
  assert(Number(speedup) >= 1.5, `JIT must be at least 1.5x faster than interpreter, got ${speedup}x`);
  console.log(`[PASS] JIT benchmark validated with significant real-world speedup!`);
}

// --- Test 7: Direct Block Chaining & Dynamic Jump Patching ---
{
  console.log("\nVerifying Direct Block Chaining & Link Invalidation...");
  const emu = new MiniQEMU({ jitHotThreshold: 2 });
  // Program with 2 chained blocks:
  // Block 1 (0x400000):
  //   add x0, x0, #1
  //   cmp x0, #100
  //   b.ne 0x400000  (loops back to 0x400000)
  // Block 2 (0x40000c):
  //   movz x8, #93
  //   svc #0
  const instructions = [
    0x91000400, // 0x400000: add x0, x0, #1
    0xf101901f, // 0x400004: cmp x0, #100
    0x54000000 | (((-2) & 0x7ffff) << 5) | 1, // 0x400008: b.ne 0x400000
    0xd2800ba8, // 0x40000c: movz x8, #93
    0xd4000001  // 0x400010: svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(500, false);

  assert(emu.cpu.halted, "Chained program must halt");
  assert(emu.cpu.getReg(0) === 100n, `x0 must be 100, got ${emu.cpu.getReg(0)}`);
  const stats = emu.getJitStats();
  assert(stats.chainsFormed >= 1, `Must form at least 1 direct block chain, got ${stats.chainsFormed}`);
  assert(stats.chainExecutions > 50, `Must execute direct block chains, got ${stats.chainExecutions}`);

  const loopBlock = emu.jit.getBlock(0x00400000);
  assert(loopBlock !== undefined, "Loop block must exist in cache");
  assert(loopBlock.linkTaken === loopBlock, "Self-loop taken link must point directly to itself");
  assert(loopBlock.targetTakenPC === 0x00400000, "targetTakenPC must match loop start");
  assert(loopBlock.targetFallthroughPC === 0x0040000c, "targetFallthroughPC must match exit block");

  // Verify unlinking on invalidation
  emu.jit.invalidateRange(0x00400000, 4);
  assert(!emu.jit.blockCache.has(0x00400000), "Invalidated block must be removed");
  const postStats = emu.getJitStats();
  assert(postStats.chainUnlinks >= 1, `Invalidating block must trigger unlinking, got ${postStats.chainUnlinks}`);
  console.log(`[PASS] Direct Block Chaining verified: ${stats.chainsFormed} chains formed, ${stats.chainExecutions} chained jumps, clean unlinking on invalidation`);
}

console.log("\nAll Dynamic JIT Compiler Tests Passed Successfully!");
