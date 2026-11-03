// tests/test_graphics.js - Unit & Integration Tests for Level 1 MMIO Graphics Framebuffer
import assert from "assert";
import { MiniQEMU } from "../src/emulator.js";
import { Memory, VRAM_BASE, FB_WIDTH, FB_HEIGHT, FB_BPP, FB_SIZE, VRAM_END } from "../src/memory.js";
import { StaticRecompiler } from "../src/static_recompiler.js";
import { Arm2X86Translator } from "../src/arm2x86.js";

console.log("Running Level 1 MMIO Graphics Framebuffer Tests...\n");

// 1. Test Framebuffer Constants and Dimensions
assert.strictEqual(VRAM_BASE, 0x00800000, "VRAM_BASE must be 0x00800000");
assert.strictEqual(FB_WIDTH, 320, "FB_WIDTH must be 320");
assert.strictEqual(FB_HEIGHT, 240, "FB_HEIGHT must be 240");
assert.strictEqual(FB_BPP, 4, "FB_BPP must be 4 (32-bit RGBA)");
assert.strictEqual(FB_SIZE, 307200, "FB_SIZE must be 307,200 bytes");
assert.strictEqual(VRAM_END, 0x0084b000, "VRAM_END must be 0x0084B000");
console.log("[PASS] Framebuffer dimensions & address space verified: 320x240 @ 32-bit RGBA (307.2 KB)");

// 2. Test VRAM Dirty Tracking & Fast Block Reads
{
  const mem = new Memory();
  assert.strictEqual(mem.isVramDirty(), false, "Initial VRAM should not be dirty");

  // Write outside VRAM (e.g. general RAM at 0x00402000)
  mem.write32(0x00402000, 0x12345678);
  assert.strictEqual(mem.isVramDirty(), false, "Non-VRAM writes must not trigger vramDirty");

  // Write inside VRAM
  mem.write32(VRAM_BASE + 16, 0xff00ff00);
  assert.strictEqual(mem.isVramDirty(), true, "VRAM write must set vramDirty to true");

  // Clear dirty flag
  mem.clearVramDirty();
  assert.strictEqual(mem.isVramDirty(), false, "clearVramDirty() must reset flag to false");

  // Fast block read into typed array
  const vramBuffer = new Uint8ClampedArray(FB_SIZE);
  mem.readVram(vramBuffer);
  assert.strictEqual(vramBuffer[16], 0x00, "R channel at byte 16");
  assert.strictEqual(vramBuffer[17], 0xff, "G channel at byte 17");
  assert.strictEqual(vramBuffer[18], 0x00, "B channel at byte 18");
  assert.strictEqual(vramBuffer[19], 0xff, "A channel at byte 19");
  console.log("[PASS] VRAM dirty tracking and fast page-by-page block copy verified");
}

// 3. Test MiniQEMU Pixel Helpers
{
  const qemu = new MiniQEMU();
  const info = qemu.getVramInfo();
  assert.strictEqual(info.base, 0x00800000);
  assert.strictEqual(info.width, 320);
  assert.strictEqual(info.height, 240);

  // Write test pixel at (10, 20) with (255, 128, 64, 255)
  qemu.writeVramPixel(10, 20, 255, 128, 64, 255);
  assert.strictEqual(qemu.isVramDirty(), true);
  const px = qemu.readVramPixel(10, 20);
  assert.deepStrictEqual(px, { r: 255, g: 128, b: 64, a: 255 });
  console.log("[PASS] MiniQEMU pixel get/set helpers verified");
}

// 4. Test graphics_pattern.elf Execution & Color Bar Accuracy
{
  const qemu = new MiniQEMU();
  let stdout = "";
  qemu.onWrite = (txt) => { stdout += txt; };
  qemu.loadElf("bin/graphics_pattern.elf");

  const start = Date.now();
  qemu.run(2000000, false);
  const elapsed = Date.now() - start;

  assert.strictEqual(qemu.cpu.halted, true, "Program must halt cleanly");
  assert.strictEqual(qemu.cpu.exitCode, 0, "Exit code must be 0");
  assert.ok(stdout.includes("Level 1 MMIO Test Pattern rendered to VRAM"), "Must output completion message");

  // Verify all 8 SMPTE Color Bars across scanline y = 40:
  // Bar 0: x = 20 (White: 255, 255, 255, 255)
  assert.deepStrictEqual(qemu.readVramPixel(20, 40), { r: 255, g: 255, b: 255, a: 255 }, "Bar 0 must be White");
  // Bar 1: x = 60 (Yellow: 255, 255, 0, 255)
  assert.deepStrictEqual(qemu.readVramPixel(60, 40), { r: 255, g: 255, b: 0, a: 255 }, "Bar 1 must be Yellow");
  // Bar 2: x = 100 (Cyan: 0, 255, 255, 255)
  assert.deepStrictEqual(qemu.readVramPixel(100, 40), { r: 0, g: 255, b: 255, a: 255 }, "Bar 2 must be Cyan");
  // Bar 3: x = 140 (Green: 0, 255, 0, 255)
  assert.deepStrictEqual(qemu.readVramPixel(140, 40), { r: 0, g: 255, b: 0, a: 255 }, "Bar 3 must be Green");
  // Bar 4: x = 180 (Magenta: 255, 0, 255, 255)
  assert.deepStrictEqual(qemu.readVramPixel(180, 40), { r: 255, g: 0, b: 255, a: 255 }, "Bar 4 must be Magenta");
  // Bar 5: x = 220 (Red: 255, 0, 0, 255)
  assert.deepStrictEqual(qemu.readVramPixel(220, 40), { r: 255, g: 0, b: 0, a: 255 }, "Bar 5 must be Red");
  // Bar 6: x = 260 (Blue: 0, 0, 255, 255)
  assert.deepStrictEqual(qemu.readVramPixel(260, 40), { r: 0, g: 0, b: 255, a: 255 }, "Bar 6 must be Blue");
  // Bar 7: x = 300 (Dark Gray: 26, 26, 26, 255)
  assert.deepStrictEqual(qemu.readVramPixel(300, 40), { r: 26, g: 26, b: 26, a: 255 }, "Bar 7 must be Dark Gray");

  console.log(`[PASS] bin/graphics_pattern.elf executed in ${elapsed} ms (${qemu.cycleCount} cycles) -> All 8 SMPTE color bars verified`);
}

// 5. Test plasma.elf Execution & Full 76,800 Pixel VRAM Coverage
{
  const qemu = new MiniQEMU();
  let stdout = "";
  qemu.onWrite = (txt) => { stdout += txt; };
  qemu.loadElf("bin/plasma.elf");

  const start = Date.now();
  qemu.run(2000000, false);
  const elapsed = Date.now() - start;

  assert.strictEqual(qemu.cpu.halted, true, "Plasma program must halt cleanly");
  assert.strictEqual(qemu.cpu.exitCode, 0, "Exit code must be 0");
  assert.ok(stdout.includes("76,800 pixels into VRAM"), "Must output 76,800 pixels message");

  // Verify corner and center pixels
  assert.deepStrictEqual(qemu.readVramPixel(0, 0), { r: 0, g: 0, b: 0, a: 255 });
  assert.deepStrictEqual(qemu.readVramPixel(160, 120), { r: 216, g: 24, b: 224, a: 255 });
  console.log(`[PASS] bin/plasma.elf executed in ${elapsed} ms (${qemu.cycleCount} cycles) -> 76,800 pixels procedural plasma verified`);
}

// 6. Test Translator Coverage (StaticRecompiler AOT & Arm2X86Translator) on Graphics Binaries
{
  for (const elfPath of ["bin/graphics_pattern.elf", "bin/plasma.elf"]) {
    const aot = new StaticRecompiler(elfPath);
    const jsCode = aot.recompile(false);
    assert.ok(jsCode.includes("x[8] = 93n;") && jsCode.includes("if (x[8] === 93n || x[8] === 94n) return Number(x[0]);"), `${elfPath} AOT must reach final sys_exit svc #0`);
    assert.ok(!jsCode.includes("UNHANDLED"), `${elfPath} AOT must not have unhandled instructions`);

    const x86 = new Arm2X86Translator(elfPath);
    const fullAsm = x86.translate(false);
    assert.ok(!fullAsm.includes("[untranslated"), `${elfPath} x86-64 translation must have 0 untranslated instructions`);
    assert.ok(fullAsm.includes("syscall") && fullAsm.includes("svc #0"), `${elfPath} x86-64 translation must reach final svc #0`);
  }
  console.log("[PASS] StaticRecompiler (AOT JS) & Arm2X86Translator (x86-64) 100% coverage on graphics binaries verified");
}

console.log("\nAll Level 1 MMIO Graphics Framebuffer Tests Passed Successfully!");
