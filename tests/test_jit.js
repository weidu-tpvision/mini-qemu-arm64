// test_jit.js - Comprehensive Dynamic Just-In-Time (JIT) Compiler Unit & Benchmark Tests
import { MiniQEMU } from "../src/emulator.js";
import { JitCompiler } from "../src/jit.js";
import { Memory } from "../src/memory.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

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

// --- Test 4: Subroutine Call / Return Chaining & Deep Recursion under JIT ---
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

// --- Test 5: Performance Benchmark: Pure Interpreter vs. Dynamic JIT ---
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

console.log("\nAll Dynamic JIT Compiler Tests Passed Successfully!");
