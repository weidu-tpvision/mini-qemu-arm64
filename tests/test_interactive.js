// tests/test_interactive.js - Unit & Integration Tests for Interactive Input MMIO & Yield
import assert from "assert";
import { MiniQEMU } from "../src/emulator.js";
import {
  INPUT_BASE, INPUT_REG_KEY_STATE, INPUT_REG_LAST_KEY, INPUT_REG_POINTER_X,
  INPUT_REG_POINTER_Y, INPUT_REG_POINTER_BTN, INPUT_REG_FRAME_COUNT,
  KEY_MASK_UP, KEY_MASK_DOWN, KEY_MASK_LEFT, KEY_MASK_RIGHT,
  KEY_MASK_ACTION_A, KEY_MASK_ACTION_B, KEY_MASK_RESET
} from "../src/memory.js";
import { StaticRecompiler } from "../src/static_recompiler.js";
import { Arm2X86Translator } from "../src/arm2x86.js";

console.log("Running Interactive MMIO Input & VSync Frame-Yield Tests...\n");

// 1. Verify Input MMIO Constants
assert.strictEqual(INPUT_BASE, 0x00850000, "INPUT_BASE must be 0x00850000");
assert.strictEqual(INPUT_REG_KEY_STATE, 0x00850000);
assert.strictEqual(INPUT_REG_LAST_KEY, 0x00850004);
assert.strictEqual(INPUT_REG_POINTER_X, 0x00850008);
assert.strictEqual(INPUT_REG_POINTER_Y, 0x0085000C);
assert.strictEqual(INPUT_REG_POINTER_BTN, 0x00850010);
assert.strictEqual(INPUT_REG_FRAME_COUNT, 0x00850014);
console.log("[PASS] Input MMIO register layout verified (0x00850000 - 0x00850014)");

// 2. Test Input Helpers (Key Mask & Pointer Coordinates)
{
  const emu = new MiniQEMU();
  assert.strictEqual(emu.getKeyState(), 0, "Initial key state must be 0");

  emu.setKeyState(KEY_MASK_UP | KEY_MASK_ACTION_A, 0x20);
  assert.strictEqual(emu.getKeyState(), KEY_MASK_UP | KEY_MASK_ACTION_A);
  assert.strictEqual(emu.memory.read32(INPUT_REG_LAST_KEY), 0x20);

  emu.setPointerState(120, 80, 1);
  const ptr = emu.getPointerState();
  assert.strictEqual(ptr.x, 120);
  assert.strictEqual(ptr.y, 80);
  assert.strictEqual(ptr.buttons, 1);

  // Clamping
  emu.setPointerState(999, -50, 0);
  const clamped = emu.getPointerState();
  assert.strictEqual(clamped.x, 319);
  assert.strictEqual(clamped.y, 0);
  console.log("[PASS] MiniQEMU setKeyState() and setPointerState() verified with clamping");
}

// 3. Test sys_sched_yield (syscall 124)
{
  const emu = new MiniQEMU();
  // Instructions:
  // movz x8, #124 (sys_sched_yield)
  // svc #0
  // movz x8, #93 (sys_exit)
  // svc #0
  const instructions = [
    0xd2800f88, // movz x8, #124
    0xd4000001, // svc #0
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);

  // Step 1: movz
  let res = emu.step(false);
  assert.strictEqual(res.yielded, false);

  // Step 2: svc #0 (yield)
  res = emu.step(false);
  assert.strictEqual(res.yielded, true, "Syscall 124 must set yielded = true");
  assert.strictEqual(emu.memory.read32(INPUT_REG_FRAME_COUNT), 1, "FRAME_COUNT must increment to 1");
  assert.strictEqual(emu.cpu.halted, false, "Yield must not halt CPU");

  // Step 3-4: sys_exit
  emu.step(false);
  res = emu.step(false);
  assert.strictEqual(res.halted, true, "Program halts after sys_exit");
  console.log("[PASS] sys_sched_yield (syscall 124) correctly yields and increments VSync counter");
}

// 4. Test bin/interactive_paint.elf execution with simulated inputs
{
  const emu = new MiniQEMU();
  emu.loadElf("bin/interactive_paint.elf");

  // Run through clear-screen initialization until first yield
  let firstYield = false;
  for (let i = 0; i < 300000; i++) {
    const res = emu.step(false);
    if (res.yielded) {
      firstYield = true;
      break;
    }
  }
  assert.ok(firstYield, "interactive_paint.elf must reach first frame yield");

  // Simulate holding RIGHT + ACTION_A (Move right and paint)
  emu.setKeyState(KEY_MASK_RIGHT | KEY_MASK_ACTION_A);

  // Run 3 frames of interactive movement and painting
  for (let frame = 0; frame < 3; frame++) {
    for (let i = 0; i < 1000; i++) {
      const res = emu.step(false);
      if (res.yielded) break;
    }
  }

  // Cursor moved right from 160 -> 162 -> 164 -> 166 at y=120
  // Brush right pixel at (163, 120) should have cyan color (0xff38bdf8: byte0=r=248, byte1=g=189, byte2=b=56, byte3=a=255)
  const brushPx = emu.readVramPixel(163, 120);
  assert.strictEqual(brushPx.a, 255, "Alpha channel must be 255");
  assert.strictEqual(brushPx.r, 248, "Red byte must be 248 (0xf8)");
  assert.strictEqual(brushPx.g, 189, "Green byte must be 189 (0xbd)");
  assert.strictEqual(brushPx.b, 56, "Blue byte must be 56 (0x38)");

  // Cursor pixel at (166, 120) should be white (255, 255, 255, 255)
  const cursorPx = emu.readVramPixel(166, 120);
  assert.deepStrictEqual(cursorPx, { r: 255, g: 255, b: 255, a: 255 }, "Cursor must be white crosshair");

  // Simulate Exit Key (bit 7 = 0x80)
  emu.setKeyState(0x80);
  let halted = false;
  for (let i = 0; i < 100; i++) {
    const res = emu.step(false);
    if (res.halted) {
      halted = true;
      assert.strictEqual(res.exitCode, 0, "Exit code must be 0");
      break;
    }
  }
  assert.ok(halted, "interactive_paint.elf must halt cleanly upon exit key");
  console.log("[PASS] bin/interactive_paint.elf interactive loop, paint strokes & clean exit verified");
}

// 5. Test Translator Coverage (StaticRecompiler & Arm2X86Translator) on interactive_paint.elf
{
  const aot = new StaticRecompiler("bin/interactive_paint.elf");
  const jsCode = aot.recompile(false);
  assert.ok(jsCode.includes("x[8] = 93n;"), "AOT must reach exit syscall");
  assert.ok(!jsCode.includes("UNHANDLED"), "AOT must have 0 unhandled instructions");

  const x86 = new Arm2X86Translator("bin/interactive_paint.elf");
  const fullAsm = x86.translate(false);
  assert.ok(!fullAsm.includes("[untranslated"), "x86-64 translator must have 0 untranslated instructions");
  assert.ok(fullAsm.includes("syscall"), "x86-64 translator must include syscall");
  console.log("[PASS] StaticRecompiler and Arm2X86Translator 100% coverage on interactive_paint.elf verified");
}

console.log("\nAll Interactive MMIO Input & VSync Frame-Yield Tests Passed Successfully!");
