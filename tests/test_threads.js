// tests/test_threads.js - Comprehensive Unit & Integration Tests for ARMv8.1-A LSE Atomics & Multi-Threading
import { MiniQEMU } from "../src/emulator.js";
import { Decoder, InstructionType } from "../src/decoder.js";
import { generateThreadsElf } from "../tools/build_threads_elf.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// Helper to encode ARMv8.1-A LSE atomic memory operations
function encodeLse(size, a, r, rs, opc, rn, rt) {
  let v = (size << 30) >>> 0;
  v |= (0b111000 << 24) >>> 0;
  v |= (a << 23) >>> 0;
  v |= (r << 22) >>> 0;
  v |= (1 << 21) >>> 0;
  v |= (rs << 16) >>> 0;
  v |= (opc << 12) >>> 0;
  v |= (rn << 5) >>> 0;
  v |= rt >>> 0;
  return v >>> 0;
}

// Helper to encode ARMv8.1-A CAS
function encodeCas(size, l, o0, rs, rn, rt) {
  let v = (size << 30) >>> 0;
  v |= (0b001000 << 24) >>> 0;
  v |= (1 << 23) >>> 0; // o2 = 1
  v |= (l << 22) >>> 0;
  v |= (1 << 21) >>> 0; // o1 = 1
  v |= (rs << 16) >>> 0;
  v |= (o0 << 15) >>> 0;
  v |= (0b11111 << 10) >>> 0;
  v |= (rn << 5) >>> 0;
  v |= rt >>> 0;
  return v >>> 0;
}

console.log("Running ARMv8.1-A LSE Atomics & Multi-Threading Unit Tests...\n");

// --- Test 1: LSE Atomics Instruction Decoding ---
{
  // 1. CAS family
  const cas64 = encodeCas(3, 0, 0, 0, 2, 1); // cas x0, x1, [x2]
  const dCas64 = Decoder.decode(cas64);
  assert(dCas64.type === InstructionType.CAS, "cas64 must be CAS");
  assert(dCas64.bytes === 8 && dCas64.sf === 1, "cas64 must be 8 bytes");
  assert(dCas64.disassembly === "cas x0, x1, [x2]", `Expected 'cas x0, x1, [x2]', got '${dCas64.disassembly}'`);

  const casa32 = encodeCas(2, 0, 1, 3, 4, 5); // casa w3, w5, [x4]
  const dCasa32 = Decoder.decode(casa32);
  assert(dCasa32.type === InstructionType.CAS && dCasa32.aBit === 1, "casa32 must have acquire bit");
  assert(dCasa32.disassembly === "casa w3, w5, [x4]", `Expected 'casa w3, w5, [x4]', got '${dCasa32.disassembly}'`);

  const casal8 = encodeCas(0, 1, 1, 6, 7, 8); // casalb w6, w8, [x7]
  const dCasal8 = Decoder.decode(casal8);
  assert(dCasal8.type === InstructionType.CAS && dCasal8.bytes === 1, "casalb must have 1 byte");
  assert(dCasal8.disassembly === "casalb w6, w8, [x7]", `Expected 'casalb w6, w8, [x7]', got '${dCasal8.disassembly}'`);

  // 2. Atomic memory operations (LDADD, LDCLR, LDEOR, LDSET, SWP)
  const ldadd64 = encodeLse(3, 0, 0, 0, 0, 2, 1); // ldadd x0, x1, [x2]
  const dLdadd64 = Decoder.decode(ldadd64);
  assert(dLdadd64.type === InstructionType.LDADD && dLdadd64.bytes === 8, "ldadd64 must be LDADD 8 bytes");
  assert(dLdadd64.disassembly === "ldadd x0, x1, [x2]", `Got ${dLdadd64.disassembly}`);

  const ldclr32 = encodeLse(2, 1, 0, 1, 1, 3, 2); // ldclra w1, w2, [x3]
  const dLdclr32 = Decoder.decode(ldclr32);
  assert(dLdclr32.type === InstructionType.LDCLR && dLdclr32.aBit === 1, "ldclr32 must have acquire bit");
  assert(dLdclr32.disassembly === "ldclra w1, w2, [x3]", `Got ${dLdclr32.disassembly}`);

  const ldeor16 = encodeLse(1, 0, 1, 4, 2, 5, 6); // ldeorlh w4, w6, [x5]
  const dLdeor16 = Decoder.decode(ldeor16);
  assert(dLdeor16.type === InstructionType.LDEOR && dLdeor16.bytes === 2, "ldeor16 must be 2 bytes");
  assert(dLdeor16.disassembly === "ldeorlh w4, w6, [x5]", `Got ${dLdeor16.disassembly}`);

  const ldset8 = encodeLse(0, 1, 1, 7, 3, 8, 9); // ldsetalb w7, w9, [x8]
  const dLdset8 = Decoder.decode(ldset8);
  assert(dLdset8.type === InstructionType.LDSET && dLdset8.bytes === 1, "ldset8 must be 1 byte");
  assert(dLdset8.disassembly === "ldsetalb w7, w9, [x8]", `Got ${dLdset8.disassembly}`);

  const swp64 = encodeLse(3, 0, 0, 10, 8, 11, 12); // swp x10, x12, [x11]
  const dSwp64 = Decoder.decode(swp64);
  assert(dSwp64.type === InstructionType.SWP && dSwp64.bytes === 8, "swp64 must be SWP 8 bytes");
  assert(dSwp64.disassembly === "swp x10, x12, [x11]", `Got ${dSwp64.disassembly}`);

  // Zero register (XZR / WZR) formatting
  const stadd32 = encodeLse(2, 0, 0, 1, 0, 2, 31); // ldadd w1, wzr, [x2]
  const dStadd32 = Decoder.decode(stadd32);
  assert(dStadd32.disassembly === "ldadd w1, wzr, [x2]", `Got ${dStadd32.disassembly}`);

  console.log("[PASS] ARMv8.1-A LSE instruction decoders (CAS, SWP, LDADD, LDCLR, LDEOR, LDSET) verified.");
}

// --- Test 2: Execution of LSE Atomic Operations (Interpreter & JIT) ---
for (const jitEnabled of [false, true]) {
  const mode = jitEnabled ? "JIT" : "Interpreter";
  const emu = new MiniQEMU({ jitEnabled });

  const testAddr = 0x00410000;
  emu.memory.write64(testAddr, 0x100n);

  function runRaw(instrRaw) {
    emu.loadProgram([instrRaw], 0x00400000);
    emu.step(false);
  }

  // 1. CAS success: expected 0x100, replace with 0x200
  emu.cpu.setReg(0, 0x100n); // expected
  emu.cpu.setReg(1, 0x200n); // new value
  emu.cpu.setReg(2, BigInt(testAddr));
  runRaw(encodeCas(3, 0, 0, 0, 2, 1)); // cas x0, x1, [x2]
  assert(emu.memory.read64(testAddr) === 0x200n, `${mode}: CAS success memory must be 0x200`);
  assert(emu.cpu.getReg(0) === 0x100n, `${mode}: CAS must return previous value 0x100 in X0`);

  // 2. CAS failure: expected 0x999, memory has 0x200
  emu.cpu.setReg(0, 0x999n);
  emu.cpu.setReg(1, 0x555n);
  runRaw(encodeCas(3, 0, 0, 0, 2, 1)); // cas x0, x1, [x2]
  assert(emu.memory.read64(testAddr) === 0x200n, `${mode}: CAS failure memory must remain 0x200`);
  assert(emu.cpu.getReg(0) === 0x200n, `${mode}: CAS failure must return actual memory value 0x200 in X0`);

  // 3. SWP: swap 0x300 into testAddr
  emu.cpu.setReg(3, 0x300n);
  runRaw(encodeLse(3, 0, 0, 3, 8, 2, 4)); // swp x3, x4, [x2]
  assert(emu.memory.read64(testAddr) === 0x300n, `${mode}: SWP memory must be 0x300`);
  assert(emu.cpu.getReg(4) === 0x200n, `${mode}: SWP must return previous value 0x200 in X4`);

  // 4. LDADD: add 50 to testAddr (0x300 = 768 -> 818)
  emu.cpu.setReg(5, 50n);
  runRaw(encodeLse(3, 0, 0, 5, 0, 2, 6)); // ldadd x5, x6, [x2]
  assert(emu.memory.read64(testAddr) === 818n, `${mode}: LDADD memory must be 818`);
  assert(emu.cpu.getReg(6) === 768n, `${mode}: LDADD must return previous value 768 in X6`);

  // 5. LDCLR: clear bit 1 (818 = 0b1100110010 & ~2 = 816)
  emu.cpu.setReg(7, 2n);
  runRaw(encodeLse(3, 0, 0, 7, 1, 2, 8)); // ldclr x7, x8, [x2]
  assert(emu.memory.read64(testAddr) === 816n, `${mode}: LDCLR memory must be 816`);
  assert(emu.cpu.getReg(8) === 818n, `${mode}: LDCLR must return previous value 818 in X8`);

  // 6. LDEOR: toggle bit 0 (816 ^ 1 = 817)
  emu.cpu.setReg(9, 1n);
  runRaw(encodeLse(3, 0, 0, 9, 2, 2, 10)); // ldeor x9, x10, [x2]
  assert(emu.memory.read64(testAddr) === 817n, `${mode}: LDEOR memory must be 817`);
  assert(emu.cpu.getReg(10) === 816n, `${mode}: LDEOR must return previous value 816 in X10`);

  // 7. LDSET: set bit 2 (817 | 4 = 821)
  emu.cpu.setReg(11, 4n);
  runRaw(encodeLse(3, 0, 0, 11, 3, 2, 12)); // ldset x11, x12, [x2]
  assert(emu.memory.read64(testAddr) === 821n, `${mode}: LDSET memory must be 821`);
  assert(emu.cpu.getReg(12) === 817n, `${mode}: LDSET must return previous value 817 in X12`);

  console.log(`[PASS] Atomic memory mutation primitives (${mode}) verified.`);
}

// --- Test 3: Linux sys_clone Thread Creation & Context Isolation ---
{
  const emu = new MiniQEMU({ jitEnabled: false });

  // Initial state: TID 1000
  emu.cpu.setReg(8, 178n); // sys_gettid
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 1000n, "Initial main thread TID must be 1000");

  // Call sys_clone (syscall 220):
  // X0: flags = 0x10700 (CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_THREAD)
  // X1: stack = 0x00420000
  // X2: parent_tidptr = 0x00411000
  // X3: tls = 0x00412000
  // X4: child_tidptr = 0x00413000
  const parentTidAddr = 0x00411000;
  const childTidAddr = 0x00413000;
  const tlsAddr = 0x00412000n;
  const childStack = 0x00420000n;

  emu.cpu.setReg(0, 0x10700n | 0x00080000n | 0x00100000n | 0x00200000n); // with SETTLS, PARENT_SETTID, CHILD_CLEARTID
  emu.cpu.setReg(1, childStack);
  emu.cpu.setReg(2, BigInt(parentTidAddr));
  emu.cpu.setReg(3, tlsAddr);
  emu.cpu.setReg(4, BigInt(childTidAddr));
  emu.cpu.setReg(8, 220n); // sys_clone

  const res = emu.handleSyscall();
  assert(res.yielded === true, "sys_clone must request a thread yield");
  assert(emu.cpu.getReg(0) === 1001n, "Parent must receive child TID 1001 in X0");
  assert(emu.memory.read32(parentTidAddr) === 1001, "CLONE_PARENT_SETTID must write child TID 1001");

  const childCtx = emu.threads.get(1001);
  assert(childCtx !== undefined, "Child thread 1001 must be registered in thread map");
  assert(childCtx.cpuState.x[0] === 0n, "Child thread X0 must be 0n");
  assert(childCtx.cpuState.sp === childStack, "Child thread SP must match requested stack");
  assert(childCtx.cpuState.tpidr_el0 === tlsAddr, "Child thread TLS must match requested pointer");
  assert(childCtx.clear_child_tid === childTidAddr, "CLONE_CHILD_CLEARTID must record tid address");

  // Switch to child thread
  emu.scheduleNextThread();
  assert(emu.currentThreadId === 1001, "Scheduler must switch to child thread 1001");
  assert(emu.cpu.getReg(0) === 0n, "Active CPU X0 must be 0n for child");
  assert(emu.cpu.sp === childStack, "Active CPU SP must be child stack");

  // Call sys_gettid in child
  emu.cpu.setReg(8, 178n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 1001n, "Child sys_gettid must return 1001");

  console.log("[PASS] Linux sys_clone thread creation, register/stack isolation, and TLS setup verified.");
}

// --- Test 4: Linux sys_futex Synchronization (WAIT, WAKE, Robust Clear TID) ---
{
  const emu = new MiniQEMU({ jitEnabled: false });

  // Spawn child thread so we have multi-thread environment
  emu.cpu.setReg(0, 0x10700n | 0x00200000n); // CLONE_CHILD_CLEARTID
  emu.cpu.setReg(1, 0x00420000n);
  emu.cpu.setReg(2, 0n);
  emu.cpu.setReg(3, 0n);
  emu.cpu.setReg(4, 0x00414000n);
  emu.cpu.setReg(8, 220n);
  emu.handleSyscall();

  // Child thread is TID 1001, Parent is TID 1000
  const futexAddr = 0x00415000;
  // Test high-bit unsigned futex word (e.g. FUTEX_WAITERS = 0x80000000)
  emu.memory.write32(futexAddr, 0x80000000);

  // Set canary register in Parent before waiting
  emu.cpu.setReg(19, 0x12345678n);

  // Parent calls FUTEX_WAIT on futexAddr with expected 0x80000000 -> suspends!
  emu.cpu.setReg(0, BigInt(futexAddr));
  emu.cpu.setReg(1, 0n); // FUTEX_WAIT
  emu.cpu.setReg(2, 0x80000000n); // expected 0x80000000
  emu.cpu.setReg(8, 98n);
  emu.handleSyscall();

  const parentCtx = emu.threads.get(1000);
  assert(parentCtx.status === "WAITING" && parentCtx.waitAddr === futexAddr, "Parent must be WAITING on futexAddr");

  // Switch to child thread 1001
  emu.scheduleNextThread();
  assert(emu.currentThreadId === 1001, "Scheduler must activate child thread");

  // Mutate canary register in Child
  emu.cpu.setReg(19, 0x87654321n);

  // Child calls FUTEX_WAKE on futexAddr -> wakes parent
  emu.cpu.setReg(0, BigInt(futexAddr));
  emu.cpu.setReg(1, 1n); // FUTEX_WAKE
  emu.cpu.setReg(2, 1n); // wake 1 waiter
  emu.cpu.setReg(8, 98n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 1n, "FUTEX_WAKE must report 1 waiter woken");
  assert(parentCtx.status === "READY", "Parent must transition to READY");

  // Child exits via sys_exit (93): clear_child_tid (0x00414000) must be cleared to 0
  emu.memory.write32(0x00414000, 1001);
  emu.cpu.setReg(0, 0n);
  emu.cpu.setReg(8, 93n);
  const exitRes = emu.handleSyscall();
  assert(exitRes.threadExited === true, "Child thread must be marked as exited");
  assert(emu.threads.get(1001).status === "DEAD", "Child thread status must be DEAD");
  assert(emu.memory.read32(0x00414000) === 0, "clear_child_tid address must be cleared to 0 on exit");

  // Parent resumes
  assert(emu.currentThreadId === 1000, "Scheduler must switch back to parent");
  assert(emu.cpu.getReg(19) === 0x12345678n, "Parent canary register X19 must be preserved across FUTEX_WAIT");
  console.log("[PASS] Linux sys_futex (FUTEX_WAIT, FUTEX_WAKE) and clear_child_tid lifecycle verified.");
}

// --- Test 5: End-to-End Multi-Threaded ELF Execution (threads.elf) ---
{
  const elfBuffer = generateThreadsElf();

  // 1. Interpreter execution
  const emuInterp = new MiniQEMU({ jitEnabled: false });
  emuInterp.loadElf(elfBuffer, "threads.elf");
  const exitInterp = emuInterp.run(500, false);
  assert(emuInterp.cpu.halted === true, "Interpreter: program must halt cleanly");
  assert(exitInterp === 42, `Interpreter: Expected exitCode 42, got ${exitInterp}`);
  assert(emuInterp.memory.read32(0x00410000) === 10, "shared_counter must equal 10");

  // 2. Dynamic JIT execution
  const emuJit = new MiniQEMU({ jitEnabled: true });
  emuJit.loadElf(elfBuffer, "threads.elf");
  const exitJit = emuJit.run(500, false);
  assert(emuJit.cpu.halted === true, "JIT: program must halt cleanly");
  assert(exitJit === 42, `JIT: Expected exitCode 42, got ${exitJit}`);
  assert(emuJit.memory.read32(0x00410000) === 10, "shared_counter must equal 10");

  // Verify 100% Bit-Exact Execution Parity
  assert(emuInterp.cycleCount === emuJit.cycleCount, `Cycle count mismatch: Interp=${emuInterp.cycleCount}, JIT=${emuJit.cycleCount}`);
  assert(exitInterp === exitJit, "Exit codes must match");

  console.log(`[PASS] End-to-end execution of threads.elf verified with 100% Interpreter vs JIT parity (Exit: 42, Counter: 10, Cycles: ${emuInterp.cycleCount}).`);
}

console.log("\nAll ARMv8.1-A LSE Atomics & Multi-Threading Tests Passed Successfully!");
