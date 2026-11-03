// tests/test_abi_and_compiler.js - Tests for Linux ABI Stack Setup and ADRP/CSEL/CSET execution
import { MiniQEMU } from "../src/emulator.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

console.log("Running Linux ABI Stack Frame & Compiler Primitives Unit Tests...\n");

// --- Test 1: Linux Initial Stack Frame (argc, argv, envp, auxv) ---
{
  const emu = new MiniQEMU();
  const entryPoint = emu.loadElf("bin/fib.elf");

  const sp = emu.cpu.sp;
  assert(sp < 0x00700000n && sp > 0x006f0000n, `SP should be in top stack area, got 0x${sp.toString(16)}`);
  assert(Number(sp) % 16 === 0, `SP must be 16-byte aligned per ARM64 ABI, got 0x${sp.toString(16)}`);

  // [SP + 0]: argc = 1
  const argc = emu.memory.read64(Number(sp));
  assert(argc === 1n, `argc must be 1, got ${argc}`);

  // [SP + 8]: argv[0] pointer
  const argv0Ptr = Number(emu.memory.read64(Number(sp + 8n)));
  assert(argv0Ptr > Number(sp) && argv0Ptr < 0x00700000, `argv0Ptr should point to string on stack`);

  // Read string at argv[0]
  const strBytes = [];
  for (let i = 0; i < 7; i++) strBytes.push(emu.memory.read8(argv0Ptr + i));
  const progName = new TextDecoder().decode(new Uint8Array(strBytes));
  assert(progName === "fib.elf", `argv[0] should be "fib.elf", got "${progName}"`);

  // [SP + 16]: argv[1] = NULL
  assert(emu.memory.read64(Number(sp + 16n)) === 0n, "argv[1] must be NULL");

  // [SP + 24]: envp[0] = NULL
  assert(emu.memory.read64(Number(sp + 24n)) === 0n, "envp[0] must be NULL");

  // [SP + 32..]: auxv vector entries
  const auxv = new Map();
  for (let offset = 32n; offset < 160n; offset += 16n) {
    const type = emu.memory.read64(Number(sp + offset));
    const val = emu.memory.read64(Number(sp + offset + 8n));
    if (type === 0n) break;
    auxv.set(Number(type), val);
  }
  assert(auxv.get(3) === 0x00400040n, `auxv AT_PHDR (3) should be 0x400040, got 0x${auxv.get(3)?.toString(16)}`);
  assert(auxv.get(4) === 56n, `auxv AT_PHENT (4) should be 56, got ${auxv.get(4)}`);
  assert(auxv.get(5) === 1n, `auxv AT_PHNUM (5) should be 1, got ${auxv.get(5)}`);
  assert(auxv.get(6) === 4096n, "auxv AT_PAGESZ (6) value 4096");
  assert(auxv.get(9) === entryPoint, "auxv AT_ENTRY (9) must match entryPoint");
  assert(auxv.get(25) > sp && auxv.get(25) < 0x00700000n, "auxv AT_RANDOM (25) must point to 16-byte stack seed");
  assert(emu.memory.read64(Number(auxv.get(25))) !== 0n, "AT_RANDOM seed bytes must be non-zero");

  console.log(`[PASS] Linux ABI initial stack frame validated (argc=1, argv[0]="fib.elf", AT_PHDR, AT_PAGESZ=4096, AT_ENTRY=0x${entryPoint.toString(16)}, AT_RANDOM)`);
}

// --- Test 2: ADRP (Address Page Formation) ---
{
  const emu = new MiniQEMU();
  // Instructions:
  // PC at 0x00400000:
  // 1. adrp x0, [page +16384B] (0x90000020: immhi=1, immlo=0 -> imm21=4) -> 0x00400000 + 0x4000 = 0x00404000
  // 2. movz x8, #93
  // 3. svc #0
  const instructions = [
    0x90000020, // adrp x0, [page +16384B] (imm21 = 4)
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.step(false);

  const adrpResult = emu.cpu.getReg(0);
  assert(adrpResult === 0x00404000n, `ADRP should produce 0x00404000, got 0x${adrpResult.toString(16)}`);
  console.log(`[PASS] ADRP execution verified: PC=0x400000 + 4 pages -> 0x${adrpResult.toString(16)}`);
}

// --- Test 3: CSEL (Conditional Select) & CSET ---
{
  const emu = new MiniQEMU();
  // 1. movz x1, #100
  // 2. movz x2, #200
  // 3. subs xzr, x1, #100 (sets Z=1 because 100 - 100 = 0)
  // 4. csel x0, x1, x2, eq (since Z=1, chooses x1 = 100)
  // 5. subs xzr, x1, #50  (sets Z=0 because 100 - 50 != 0)
  // 6. csel x3, x1, x2, eq (since Z=0, chooses x2 = 200)
  // 7. cset x4, eq (since Z=0, sets x4 = 0)
  // 8. subs xzr, x1, #100 (sets Z=1)
  // 9. cset x5, eq (since Z=1, sets x5 = 1)
  // 10. movz x8, #93
  // 11. svc #0
  const instructions = [
    0xd2800c81, // movz x1, #100
    0xd2801902, // movz x2, #200
    0xf101903f, // subs xzr, x1, #100 (cmp x1, #100)
    0x9a820020, // csel x0, x1, x2, eq
    0xf100c83f, // subs xzr, x1, #50 (cmp x1, #50)
    0x9a820023, // csel x3, x1, x2, eq
    0x9a9f17e4, // cset x4, eq (csinc x4, xzr, xzr, ne: since Z=0, sets x4 = 0)
    0xf101903f, // subs xzr, x1, #100 (cmp x1, #100 -> Z=1)
    0x9a9f17e5, // cset x5, eq (csinc x4, xzr, xzr, ne: since Z=1, sets x5 = 1)
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(20, false);

  assert(emu.cpu.getReg(0) === 100n, `CSEL when true should select x1 (100), got ${emu.cpu.getReg(0)}`);
  assert(emu.cpu.getReg(3) === 200n, `CSEL when false should select x2 (200), got ${emu.cpu.getReg(3)}`);
  assert(emu.cpu.getReg(4) === 0n, `CSET when false should set 0, got ${emu.cpu.getReg(4)}`);
  assert(emu.cpu.getReg(5) === 1n, `CSET when true should set 1, got ${emu.cpu.getReg(5)}`);

  console.log(`[PASS] CSEL (true path = 100, false path = 200) verified successfully`);
  console.log(`[PASS] CSET (condition false = 0, condition true = 1) verified successfully`);
}

// --- Test 4: MOVK, CBZ/CBNZ, STRH/LDRH, and 32-bit W Register Truncation ---
{
  const emu = new MiniQEMU();
  const instructions = [
    // Build 0x12345678 in x0 using MOVZ + MOVK
    0xd28acf00, // movz x0, #0x5678
    0xf2a24680, // movk x0, #0x1234, lsl #16 -> x0 = 0x12345678
    // Test 32-bit W register wrapping: 0xffffffff + 2 = 1 in 32-bit (w1)
    0x52800001, // movz w1, #0
    0x12800001, // movn w1, #0 -> w1 = 0xffffffff
    0x52800042, // movz w2, #2
    0x0b020023, // add w3, w1, w2 -> w3 = (0xffffffff + 2) & 0xffffffff = 1
    // Test STRH / LDRH at 0x00402000
    0xd2a00804, // movz x4, #0x40, lsl #16
    0x91400884, // add x4, x4, #2, lsl #12 -> x4 = 0x00402000
    0x79000080, // strh w0, [x4, #0] -> stores lower 16 bits (0x5678)
    0x79400085, // ldrh w5, [x4, #0] -> loads 0x5678 into w5
    // Test CBZ / CBNZ
    0xd2800006, // movz x6, #0
    0xb4000046, // cbz x6, +8 (skips next instruction)
    0xd2801f26, // movz x6, #999 (skipped!)
    0xb5000043, // cbnz x3, +8 (since x3 == 1, skips next instruction)
    0xd2801f23, // movz x3, #999 (skipped!)
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(30, false);

  assert(emu.cpu.getReg(0) === 0x12345678n, `MOVZ+MOVK should produce 0x12345678, got 0x${emu.cpu.getReg(0).toString(16)}`);
  assert(emu.cpu.getReg(3) === 1n, `32-bit ADD (w3 = 0xffffffff + 2) should wrap to 1, got 0x${emu.cpu.getReg(3).toString(16)}`);
  assert(emu.cpu.getReg(5) === 0x5678n, `STRH/LDRH should store/load 16-bit halfword 0x5678, got 0x${emu.cpu.getReg(5).toString(16)}`);
  assert(emu.cpu.getReg(6) === 0n, `CBZ should have skipped movz x6, #999`);
  console.log("[PASS] MOVK, 32-bit W register wrapping, STRH/LDRH, and CBZ/CBNZ verified successfully");
}

// --- Test 5: Gap A (TPIDR_EL0 Thread Pointer via MSR/MRS) & Gap B (MADD/MSUB, TBZ/TBNZ, UBFM/SBFM, Register-Offset & LDRSW) ---
{
  const emu = new MiniQEMU();
  const instructions = [
    // 1. Gap A: Set TPIDR_EL0 = 0x00600000 via MSR and read back into x1 via MRS
    0xd2a00c00, // movz x0, #0x60, lsl #16 (0x00600000)
    0xd51bd040, // msr tpidr_el0, x0
    0xd53bd041, // mrs x1, tpidr_el0 -> x1 = 0x00600000

    // 2. Gap B: 2D Grid Index via MADD (x5 = x4 + x2 * x3 = 7 + 5 * 10 = 57) and MSUB (x6 = 100 - 5 * 10 = 50)
    0xd28000a2, // movz x2, #5 (y = 5)
    0xd2800143, // movz x3, #10 (WIDTH = 10)
    0xd28000e4, // movz x4, #7 (x = 7)
    0x9b031045, // madd x5, x2, x3, x4 -> x5 = 7 + 5*10 = 57
    0xd2800c86, // movz x6, #100
    0x9b039846, // msub x6, x2, x3, x6 -> x6 = 100 - 5*10 = 50

    // 3. Gap B: UBFM (lsl x7, x2, #4 -> 5 << 4 = 80) & SBFM (sxtw x13, w9 where w9 = -12)
    0xd37cec47, // lsl x7, x2, #4 (ubfm x7, x2, #60, #59) -> x7 = 80
    0x12800169, // movn w9, #11 -> w9 = -12 (0xfffffff4)
    0x93407d2d, // sxtw x13, w9 (sbfm x13, x9, #0, #31) -> x13 = -12 in 64-bit (0xfffffffffffffff4)

    // 4. Gap B: Register-Offset Store/Load ([x1, x2, lsl #3] = [0x00600000 + 5*8]) & LDRSW
    0xf8227825, // str x5, [x1, x2, lsl #3] -> stores 57 at 0x00600028
    0xf862782a, // ldr x10, [x1, x2, lsl #3] -> loads 57 into x10
    0xb9000029, // str w9, [x1] -> stores 32-bit -12 (0xfffffff4) at 0x00600000
    0xb980002b, // ldrsw x11, [x1] -> loads and sign-extends -12 to 64-bit in x11

    // 5. Gap B: TBZ / TBNZ (test bit 63 of negative x13 -> bit 63 is 1, so tbnz jumps over movz x12, #999)
    0xd280008c, // movz x12, #4
    0xb7f8004d, // tbnz x13, #63, +8 (since x13 is negative, bit 63 == 1 -> branch taken!)
    0xd2807cec, // movz x12, #999 (skipped!)
    0x3600004c, // tbz w12, #0, +8 (since w12 == 4, bit 0 == 0 -> branch taken!)
    0xd2807cec, // movz x12, #999 (skipped!)

    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(40, false);

  assert(emu.cpu.tpidr_el0 === 0x00600000n && emu.cpu.getReg(1) === 0x00600000n, "MSR/MRS tpidr_el0 must set and read 0x00600000");
  assert(emu.cpu.getReg(5) === 57n, `MADD should compute 7 + 5*10 = 57, got ${emu.cpu.getReg(5)}`);
  assert(emu.cpu.getReg(6) === 50n, `MSUB should compute 100 - 5*10 = 50, got ${emu.cpu.getReg(6)}`);
  assert(emu.cpu.getReg(7) === 80n, `UBFM (lsl #4) should compute 5 << 4 = 80, got ${emu.cpu.getReg(7)}`);
  assert(BigInt.asIntN(64, emu.cpu.getReg(13)) === -12n, `SBFM (sxtw) should sign-extend -12 to 64-bit, got ${BigInt.asIntN(64, emu.cpu.getReg(13))}`);
  assert(emu.cpu.getReg(10) === 57n, `Register-offset STR/LDR [x1, x2, lsl #3] should load 57, got ${emu.cpu.getReg(10)}`);
  assert(BigInt.asIntN(64, emu.cpu.getReg(11)) === -12n, `LDRSW should sign-extend 32-bit -12 to 64-bit, got ${BigInt.asIntN(64, emu.cpu.getReg(11))}`);
  assert(emu.cpu.getReg(12) === 4n, `TBNZ and TBZ should both take their branches, keeping x12 = 4, got ${emu.cpu.getReg(12)}`);

  console.log("[PASS] Gap A (MSR/MRS tpidr_el0) & Gap B (MADD/MSUB, UBFM/SBFM, Reg-Offset LDR/STR, LDRSW, TBZ/TBNZ) verified!");
}

console.log("\nAll Linux ABI & Compiler Primitive Tests Passed Successfully!");
