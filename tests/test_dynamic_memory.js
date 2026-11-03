// tests/test_dynamic_memory.js - Unit & Integration Tests for Dynamic Memory Management
import assert from "assert";
import { MiniQEMU } from "../src/emulator.js";
import { StaticRecompiler } from "../src/static_recompiler.js";
import { Arm2X86Translator } from "../src/arm2x86.js";

console.log("Running Dynamic Memory & Heap Allocator Tests...\n");

// 1. Test sys_brk expansion and contraction
{
  const emu = new MiniQEMU();
  emu.heapStart = 0x00500000n;
  emu.brk = 0x00500000n;

  // Query break
  emu.cpu.setReg(0, 0n);
  emu.cpu.setReg(8, 214n);
  emu.loadProgram([0xd4000001], 0x00400000); // svc #0
  emu.step(false);
  assert.strictEqual(emu.cpu.getReg(0), 0x00500000n, "sys_brk(0) must return initial break");

  // Expand break by 8192 bytes (2 pages)
  emu.cpu.pc = 0x00400000n;
  emu.cpu.setReg(0, 0x00502000n);
  emu.cpu.setReg(8, 214n);
  emu.step(false);
  assert.strictEqual(emu.brk, 0x00502000n, "brk must expand to 0x00502000");
  assert.strictEqual(emu.cpu.getReg(0), 0x00502000n);

  // Write to both heap pages
  emu.memory.write64(0x00500000, 0x1122334455667788n);
  emu.memory.write64(0x00501000, 0x99aabbccddeeff00n);
  assert.strictEqual(emu.memory.read64(0x00500000), 0x1122334455667788n);
  assert.strictEqual(emu.memory.read64(0x00501000), 0x99aabbccddeeff00n);

  const pagesBefore = emu.memory.getPageCount();

  // Contract break by 4096 bytes (freeing the second page)
  emu.cpu.pc = 0x00400000n;
  emu.cpu.setReg(0, 0x00501000n);
  emu.cpu.setReg(8, 214n);
  emu.step(false);
  assert.strictEqual(emu.brk, 0x00501000n, "brk must contract to 0x00501000");

  const pagesAfter = emu.memory.getPageCount();
  assert.strictEqual(pagesAfter, pagesBefore - 1, "Contracting brk must free deallocated physical pages");

  // Sub-page contraction (0x00500200 -> 0x00500100) must preserve lower half of page
  emu.memory.write64(0x00500000, 0xdeadbeefcafebaben);
  emu.memory.write64(0x00500150, 0x123456789abcdef0n);
  emu.cpu.pc = 0x00400000n;
  emu.cpu.setReg(0, 0x00500100n);
  emu.cpu.setReg(8, 214n);
  emu.step(false);
  assert.strictEqual(emu.brk, 0x00500100n, "brk must contract to 0x00500100");
  assert.strictEqual(emu.memory.read64(0x00500000), 0xdeadbeefcafebaben, "Sub-page brk contraction must preserve active lower bytes on page");
  assert.strictEqual(emu.memory.read64(0x00500150), 0n, "Sub-page brk contraction must zero out reclaimed upper bytes on page");
  console.log("[PASS] sys_brk expansion, full-page reclamation, and sub-page contraction verified");
}

// 2. Test sys_mmap and sys_munmap
{
  const emu = new MiniQEMU();

  // sys_mmap(0, 8192, PROT_READ|PROT_WRITE, MAP_ANON, -1, 0)
  emu.cpu.setReg(0, 0n);
  emu.cpu.setReg(1, 8192n);
  emu.cpu.setReg(2, 3n); // PROT_READ | PROT_WRITE
  emu.cpu.setReg(3, 0x22n); // MAP_PRIVATE | MAP_ANON
  emu.cpu.setReg(4, 0xffffffffffffffffn); // -1
  emu.cpu.setReg(5, 0n);
  emu.cpu.setReg(8, 222n); // sys_mmap
  emu.loadProgram([0xd4000001], 0x00400000);
  emu.step(false);

  const mmapAddr = emu.cpu.getReg(0);
  assert.strictEqual(mmapAddr, 0x10000000n, "sys_mmap must allocate at 0x10000000");
  assert.strictEqual(emu.mmapRegions.size, 1, "mmapRegions must track allocated region");

  // Write and verify data across mmap region
  emu.memory.write32(Number(mmapAddr), 0xfeedface);
  emu.memory.write32(Number(mmapAddr) + 4096, 0xcafebabe);
  assert.strictEqual(emu.memory.read32(Number(mmapAddr)), 0xfeedface);
  assert.strictEqual(emu.memory.read32(Number(mmapAddr) + 4096), 0xcafebabe);

  const pagesBeforeUnmap = emu.memory.getPageCount();

  // sys_munmap(0x10000000, 8192)
  emu.cpu.pc = 0x00400000n;
  emu.cpu.setReg(0, mmapAddr);
  emu.cpu.setReg(1, 8192n);
  emu.cpu.setReg(8, 215n); // sys_munmap
  emu.step(false);

  assert.strictEqual(emu.cpu.getReg(0), 0n, "sys_munmap must return 0");
  assert.strictEqual(emu.mmapRegions.size, 0, "mmapRegions must remove unmapped region");
  assert.strictEqual(emu.memory.getPageCount(), pagesBeforeUnmap - 2, "sys_munmap must free resident pages");
  console.log("[PASS] sys_mmap allocation and sys_munmap page deallocation verified");
}

// 3. Test bin/dynamic_memory.elf execution, hole reuse & adjacent coalescing
{
  const emu = new MiniQEMU();
  let capturedStdout = "";
  emu.onWrite = (str) => { capturedStdout += str; };

  emu.loadElf("bin/dynamic_memory.elf");
  const exitCode = emu.run(20000, false);

  assert.strictEqual(exitCode, 42, "dynamic_memory.elf must exit cleanly with code 42");
  assert.ok(
    capturedStdout.includes("[Dynamic Memory] malloc, free, hole reuse & adjacent coalescing verified!"),
    "Captured stdout must confirm dynamic memory operations"
  );

  // Inspect heap stats and chunks
  const stats = emu.getHeapStats();
  assert.ok(stats.heapSize > 0, "Heap size must be greater than 0");
  assert.ok(stats.chunks.length >= 2, "Heap must have parsed chunks");
  assert.ok(stats.allocatedCount >= 2, "Heap must have multiple allocated chunks");
  assert.ok(stats.allocatedBytes > 0, "Allocated bytes must be tracked");

  console.log(`[PASS] dynamic_memory.elf executed cleanly (Exit 42). Heap size: ${stats.heapSize}B, ${stats.chunks.length} chunks`);
}

// 4. Test Static AOT Recompiler on dynamic_memory.elf
{
  const aot = new StaticRecompiler("bin/dynamic_memory.elf");
  const jsCode = aot.recompile(false);
  assert.ok(jsCode.includes("x[8] = 93n;"), "AOT must reach exit syscall");
  assert.ok(!jsCode.includes("UNHANDLED"), "AOT must have 0 unhandled instructions");

  const bodySource = jsCode.replace(/export\s+function\s+runNative\s*\(\)\s*\{/, "").replace(/\}\s*$/, "");
  const nativeFn = new Function(bodySource);
  assert.strictEqual(nativeFn(), 42, "Static AOT runNative() must return exit code 42");

  // Also test raw bump allocation & Static AOT on bin/heap_demo.elf
  const emuRaw = new MiniQEMU();
  emuRaw.loadElf("bin/heap_demo.elf");
  const rawExit = emuRaw.run(10000, false);
  assert.strictEqual(rawExit, 150, "heap_demo.elf must exit with sum 150");
  const rawStats = emuRaw.getHeapStats();
  assert.strictEqual(rawStats.heapStart, 0x00500000, "heapStart must default to 0x00500000");
  assert.strictEqual(rawStats.chunks.length, 1, "Raw bump heap must be classified as 1 raw block");
  assert.strictEqual(rawStats.chunks[0].isRaw, true, "Raw bump heap chunk must have isRaw = true");
  assert.strictEqual(rawStats.chunks[0].size, 40, "Raw bump heap chunk size must be 40 bytes");

  const aotHeapDemo = new StaticRecompiler("bin/heap_demo.elf");
  const jsHeapDemo = aotHeapDemo.recompile(false);
  const fnHeapDemo = new Function(jsHeapDemo.replace(/export\s+function\s+runNative\s*\(\)\s*\{/, "").replace(/\}\s*$/, ""));
  assert.strictEqual(fnHeapDemo(), 150, "Static AOT runNative() on heap_demo.elf must return 150");
  console.log("[PASS] StaticRecompiler & raw bump-heap inspector verified on dynamic_memory.elf (42) and heap_demo.elf (150)");
}

// 5. Test x86-64 Translator on dynamic_memory.elf
{
  const x86 = new Arm2X86Translator("bin/dynamic_memory.elf");
  const fullAsm = x86.translate(false);
  assert.ok(!fullAsm.includes("[untranslated"), "x86-64 translator must have 0 untranslated instructions");
  assert.ok(fullAsm.includes("syscall"), "x86-64 translator must include syscall");
  console.log("[PASS] Arm2X86Translator translates dynamic_memory.elf with 0 untranslated instructions");
}

console.log("\nAll Dynamic Memory & Heap Allocator Tests Passed Successfully!");
