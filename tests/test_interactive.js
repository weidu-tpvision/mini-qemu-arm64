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

  const runOneFrame = (maxSteps = 300000) => {
    for (let i = 0; i < maxSteps; i++) {
      const res = emu.step(false);
      if (res.yielded || res.halted) return res;
    }
    throw new Error("Frame did not yield within maxSteps");
  };

  // Frame 1: Run through clear-screen initialization until first yield
  let res = runOneFrame(300000);
  assert.strictEqual(res.yielded, true, "interactive_paint.elf must reach first frame yield");
  // Initial cursor at (160, 120) must be white
  assert.deepStrictEqual(emu.readVramPixel(160, 120), { r: 255, g: 255, b: 255, a: 255 });

  // Frame 2: Move RIGHT without holding ACTION_A (non-destructive cursor move: 160 -> 162)
  emu.setKeyState(KEY_MASK_RIGHT);
  runOneFrame(1000);
  // Old cursor position (160, 120) must be restored to Dark Slate (#0F172A -> r:15, g:23, b:42)
  assert.deepStrictEqual(
    emu.readVramPixel(160, 120),
    { r: 15, g: 23, b: 42, a: 255 },
    "Moving cursor without ACTION_A must restore background pixel (no white trail)"
  );
  assert.deepStrictEqual(
    emu.readVramPixel(162, 120),
    { r: 255, g: 255, b: 255, a: 255 },
    "New cursor position (162, 120) must show white cursor"
  );

  // Frames 3..5: Hold RIGHT + ACTION_A (Move right 162 -> 164 -> 166 -> 168 and paint Cyan #38BDF8)
  emu.setKeyState(KEY_MASK_RIGHT | KEY_MASK_ACTION_A);
  for (let frame = 0; frame < 3; frame++) {
    runOneFrame(1000);
  }

  // Brush pixel at (164, 120) must be Cyan (#38BDF8 -> r:56, g:189, b:248, a:255)
  const cyanPx = emu.readVramPixel(164, 120);
  assert.deepStrictEqual(
    cyanPx,
    { r: 56, g: 189, b: 248, a: 255 },
    "Painted brush pixel must be Little-Endian RGBA Cyan (#38BDF8)"
  );

  // Test rising-edge [B] Color (KEY_MASK_ACTION_B): hold across 3 frames, must cycle only once (Cyan -> Amber #F59E0B)
  emu.setKeyState(KEY_MASK_ACTION_B | KEY_MASK_ACTION_A);
  for (let frame = 0; frame < 3; frame++) {
    runOneFrame(1000);
  }
  // Neighbouring brush pixel (169, 120) should be Amber (#F59E0B -> r:245, g:158, b:11, a:255)
  const amberPx = emu.readVramPixel(169, 120);
  assert.deepStrictEqual(
    amberPx,
    { r: 245, g: 158, b: 11, a: 255 },
    "Holding KEY_MASK_ACTION_B across 3 frames must cycle palette once to Amber (#F59E0B)"
  );

  // Test [R] Clear (KEY_MASK_RESET): clears painted canvas back to Dark Slate (#0F172A)
  emu.setKeyState(KEY_MASK_RESET);
  runOneFrame(300000);
  assert.deepStrictEqual(
    emu.readVramPixel(164, 120),
    { r: 15, g: 23, b: 42, a: 255 },
    "KEY_MASK_RESET must clear painted strokes back to #0F172A"
  );

  // Simulate Exit Key (bit 7 = 0x80)
  emu.setKeyState(0x80);
  res = runOneFrame(100);
  assert.strictEqual(res.halted, true, "interactive_paint.elf must halt cleanly upon exit key");
  assert.strictEqual(res.exitCode, 0, "Exit code must be 0");
  console.log("[PASS] bin/interactive_paint.elf non-destructive cursor, RGBA palette, rising-edge color & reset verified");
}

// 5. Test Translator Coverage (StaticRecompiler & Arm2X86Translator) on interactive_paint.elf
{
  const aot = new StaticRecompiler("bin/interactive_paint.elf");
  const jsCode = aot.recompile(false);
  assert.ok(jsCode.includes("x[8] = 93n;"), "AOT must reach exit syscall");
  assert.ok(jsCode.includes("<< 6n"), "AOT must preserve shifted register operand (lsl #6)");
  assert.ok(!jsCode.includes("UNHANDLED"), "AOT must have 0 unhandled instructions");

  // Verify AOT function executes 1 VSync frame and returns cleanly without infinite loop
  const bodySource = jsCode.replace(/export\s+function\s+runNative\s*\(\)\s*\{/, "").replace(/\}\s*$/, "");
  const nativeFn = new Function(bodySource);
  assert.strictEqual(nativeFn(), 0, "Static AOT runNative() must return 0 at VSync frame yield");

  const x86 = new Arm2X86Translator("bin/interactive_paint.elf");
  const fullAsm = x86.translate(false);
  assert.ok(!fullAsm.includes("[untranslated"), "x86-64 translator must have 0 untranslated instructions");
  assert.ok(fullAsm.includes("<< 6"), "x86-64 translator must preserve shifted register operand");
  assert.ok(fullAsm.includes("syscall"), "x86-64 translator must include syscall");
  console.log("[PASS] StaticRecompiler and Arm2X86Translator 100% coverage & VSync return on interactive_paint.elf verified");
}

console.log("\nAll Interactive MMIO Input & VSync Frame-Yield Tests Passed Successfully!");
