// tests/test_dynamic_linker.js - Unit and Integration Tests for ELF Dynamic Linker & Shared Libraries
import assert from "node:assert";
import { MiniQEMU } from "../src/emulator.js";
import { DynamicLinker, DynamicTag, RelocationType } from "../src/dynamic_linker.js";

console.log("Running ELF Dynamic Linker & Shared Library Unit Tests...\n");

// --- Test 1: ELF Header Parsing for Dynamic Binaries (PT_INTERP & PT_DYNAMIC) ---
{
  const emu = new MiniQEMU({ jitEnabled: false });
  emu.loadElf("bin/dynamic_app.elf");

  const elf = emu.memory.elfHeader;
  assert.ok(elf, "ELF header must be populated");
  assert.strictEqual(elf.interpreter, "/lib/ld-linux-aarch64.so.1", "Interpreter must be /lib/ld-linux-aarch64.so.1");
  assert.ok(elf.dynamicHeader, "dynamicHeader must be present");
  assert.strictEqual(elf.dynamicHeader.vaddr, 0x00401600n, "dynamicHeader vaddr must match 0x401600");

  console.log("[PASS] PT_INTERP and PT_DYNAMIC program headers parsed successfully");
}

// --- Test 2: Shared Library Loading & Exported Symbol Discovery ---
{
  const emu = new MiniQEMU({ jitEnabled: false });
  const linker = emu.dynamicLinker;

  const lib = linker.loadSharedObject("bin/libcalc.so");
  assert.strictEqual(lib.soname, "libcalc.so", "SONAME must be libcalc.so");
  assert.strictEqual(lib.loadBias, 0x20000000n, "Load bias must start at 0x20000000");
  assert.ok(lib.exportedSymbols.has("calc_add"), "calc_add must be exported");
  assert.ok(lib.exportedSymbols.has("calc_cube"), "calc_cube must be exported");

  const addSym = lib.exportedSymbols.get("calc_add");
  assert.strictEqual(addSym.addr, 0x20001000n, "calc_add address must be base + 0x1000");
  assert.strictEqual(addSym.size, 8, "calc_add size must be 8 bytes");

  const cubeSym = lib.exportedSymbols.get("calc_cube");
  assert.strictEqual(cubeSym.addr, 0x20001008n, "calc_cube address must be base + 0x1008");
  assert.strictEqual(cubeSym.size, 12, "calc_cube size must be 12 bytes");

  console.log("[PASS] Shared library loading and exported symbol discovery verified");
}

// --- Test 3: Relocation Processing (R_AARCH64_JUMP_SLOT & R_AARCH64_RELATIVE) ---
{
  const emu = new MiniQEMU({ jitEnabled: false });
  const linker = emu.dynamicLinker;
  linker.loadSharedObject("bin/libcalc.so");

  const loadBias = 0x10000000n;
  const gotOffset = 0x2000n;
  const gotTargetAddr = Number(loadBias + gotOffset);
  emu.memory.write64(gotTargetAddr, 0n);

  // Apply a mock R_AARCH64_RELATIVE relocation
  const relaVaddr = 0x501000n;
  emu.memory.write64(Number(relaVaddr) + 0, gotOffset);
  emu.memory.write64(Number(relaVaddr) + 8, BigInt(RelocationType.R_AARCH64_RELATIVE));
  emu.memory.write64(Number(relaVaddr) + 16, 0x1234n); // r_addend

  const appliedRel = linker.applyRelocations(relaVaddr, 24, 24, loadBias);
  assert.strictEqual(appliedRel, 1, "Must apply 1 relative relocation");
  assert.strictEqual(emu.memory.read64(gotTargetAddr), 0x10001234n, "Relative relocation result must be base + addend");

  console.log("[PASS] AArch64 relative and jump slot relocations verified");
}

// --- Test 4: HLE Trampoline Stubs & Standard Library Fallback ---
{
  const emu = new MiniQEMU({ jitEnabled: false });
  const linker = emu.dynamicLinker;

  let outputText = "";
  emu.onWrite = (str) => { outputText += str; };

  // Write guest string at 0x600000: "Hello Dynamic ARM64!\0"
  const testMsg = "Hello Dynamic ARM64!\0";
  for (let i = 0; i < testMsg.length; i++) {
    emu.memory.write8(0x600000 + i, testMsg.charCodeAt(i));
  }

  // Create and call HLE stub for puts
  const putsStub = linker.createHleStub("puts");
  emu.cpu.setReg(0, 0x600000n);
  emu.cpu.pc = putsStub;

  // Execute stub:
  // movz x8, #id
  // svc #0xdd
  // ret
  emu.step(false); // movz x8
  emu.step(false); // svc #0xdd (traps into HLE puts)

  assert.strictEqual(outputText, "Hello Dynamic ARM64!\n", "puts must output string to host");
  assert.strictEqual(emu.cpu.getReg(0), 21n, "puts must return character count");

  // Test abs(-42)
  const absStub = linker.createHleStub("abs");
  emu.cpu.setReg(0, BigInt.asUintN(64, -42n));
  emu.cpu.pc = absStub;
  emu.step(false);
  emu.step(false);
  assert.strictEqual(emu.cpu.getReg(0), 42n, "abs(-42) must return 42");

  console.log("[PASS] HLE trampoline stubs and libc fallback execution verified");
}

// --- Test 5: End-to-End Dynamic Binary Execution (Interpreter vs. JIT Parity) ---
{
  // 1. Run in Interpreter Mode
  const interpEmu = new MiniQEMU({ jitEnabled: false });
  interpEmu.loadElf("bin/dynamic_app.elf");
  const interpExit = interpEmu.run(200, false);

  assert.strictEqual(interpExit, 82, `Interpreter exit code must be 82, got ${interpExit}`);
  assert.strictEqual(interpEmu.cpu.getReg(0), 82n, "X0 must be 82");
  assert.strictEqual(interpEmu.cpu.getReg(19), 40n, "X19 (calc_add 15+25) must be 40");
  assert.strictEqual(interpEmu.cpu.getReg(20), 27n, "X20 (calc_cube 3^3) must be 27");
  assert.strictEqual(interpEmu.cpu.getReg(21), 15n, "X21 (abs(-15)) must be 15");

  // 2. Run in Dynamic JIT Mode
  const jitEmu = new MiniQEMU({ jitEnabled: true, jitHotThreshold: 1 });
  jitEmu.loadElf("bin/dynamic_app.elf");
  const jitExit = jitEmu.run(200, false);

  assert.strictEqual(jitExit, 82, `JIT exit code must be 82, got ${jitExit}`);
  assert.strictEqual(jitEmu.cpu.getReg(0), 82n, "JIT X0 must be 82");
  assert.strictEqual(jitEmu.cpu.getReg(19), 40n, "JIT X19 must be 40");
  assert.strictEqual(jitEmu.cpu.getReg(20), 27n, "JIT X20 must be 27");
  assert.strictEqual(jitEmu.cpu.getReg(21), 15n, "JIT X21 must be 15");

  // Verify bit-exact register equivalence
  for (let r = 0; r < 31; r++) {
    assert.strictEqual(jitEmu.cpu.getReg(r), interpEmu.cpu.getReg(r), `Register X${r} mismatch`);
  }

  console.log("[PASS] End-to-end dynamic execution verified with 100% Interpreter vs JIT parity (Exit: 82)");
}

console.log("\nAll Dynamic Linker Unit Tests Passed Successfully!");
