// test_ui_api.js - Verification of UI Hooks & Browser Compatibility APIs
import assert from "assert";
import fs from "fs";
import { MiniQEMU } from "../src/emulator.js";
import { ElfLoader } from "../src/elf_loader.js";
import { Arm2X86Translator } from "../src/arm2x86.js";
import { StaticRecompiler } from "../src/static_recompiler.js";

console.log("Testing UI Decoupling and API Hooks...");

// 1. Test loadFromBuffer
const buffer = fs.readFileSync("bin/fib.elf");
const emu = new MiniQEMU();
const entry = emu.loadElf(buffer, "fib.elf");
assert.strictEqual(entry, 0x00400000n, "Entry point should be 0x00400000");

// 2. Test breakpoints
// Add breakpoint at second instruction (0x00400004)
emu.addBreakpoint(0x00400004);
assert.strictEqual(emu.hasBreakpoint(0x00400004), true);

let stepsCount = 0;
emu.onStep = (res) => {
  stepsCount++;
};

const step1 = emu.step(false);
assert.strictEqual(step1.pc, 0x00400000);
assert.strictEqual(step1.nextPC, 0x00400004);
assert.strictEqual(step1.hitBreakpoint, true);

// 3. Test CPU snapshot
const snapshot = emu.cpu.getSnapshot();
assert.strictEqual(snapshot.regs.length, 31);
assert.strictEqual(typeof snapshot.sp, "bigint");
assert.strictEqual(typeof snapshot.flags.Z, "boolean");

// 4. Test Memory block read
const bytes = emu.memory.readBlock(0x00400000, 4);
assert.strictEqual(bytes.length, 4);
const firstInstr = emu.memory.read32(0x00400000);
assert.strictEqual(((bytes[0]) | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0, firstInstr);

// 5. Test Reset
emu.reset();
assert.strictEqual(emu.cycleCount, 0);
assert.strictEqual(emu.cpu.pc, 0x00400000n);

// 6. Test onWrite & onHalt with hello.elf
const helloBuffer = fs.readFileSync("bin/hello.elf");
const helloEmu = new MiniQEMU();
helloEmu.suppressStdout = true; // suppress console output in test
let writtenText = "";
let haltedExitCode = null;

helloEmu.onWrite = (text) => {
  writtenText += text;
};
helloEmu.onHalt = (code) => {
  haltedExitCode = code;
};

helloEmu.loadElf(helloBuffer, "hello.elf");
let totalMemWrites = 0;
helloEmu.onStep = (res) => {
  totalMemWrites += (res.changedMem ? res.changedMem.length : 0);
};
helloEmu.run(100, false);

assert.strictEqual(haltedExitCode, 0);
assert.strictEqual(totalMemWrites, 8, "STR 64-bit instruction in hello.elf should record 8 written bytes");
assert.ok(writtenText.includes("Hello from ARM64"), `Expected stdout text, got: "${writtenText}"`);

// 7. Test In-Memory Binary Translators (Browser mode: writeFiles = false)
const x86Translator = new Arm2X86Translator(buffer, "fib.elf");
const x86Asm = x86Translator.translate(false);
assert.ok(x86Asm.includes("global _start"), "Expected x86-64 NASM header");

const aotRecompiler = new StaticRecompiler(buffer, "fib.elf");
const aotJs = aotRecompiler.recompile(false);
assert.ok(aotJs.includes("export function runNative()"), "Expected lifted AOT JS function");

console.log("All UI Decoupling & Hook tests passed successfully!");
