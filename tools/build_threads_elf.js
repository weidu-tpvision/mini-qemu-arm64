// tools/build_threads_elf.js - Builds Multi-Threaded Coroutine & ARMv8.1-A LSE Atomics ELF Binary
// Generates: bin/threads.elf
// Features:
// 1. Multi-threaded worker creation via Linux sys_clone (syscall 220) with CLONE_VM | CLONE_THREAD.
// 2. Worker thread runs with an independent isolated stack frame at 0x00420000.
// 3. Concurrent shared memory counter mutations using ARMv8.1-A LSE LDADD (ldadd w1, wzr, [x2]).
// 4. Memory barrier state transition via ARMv8.1-A LSE SWP (swp w1, wzr, [x6]).
// 5. Thread synchronization and barrier wakeups via Linux sys_futex (syscall 98, FUTEX_WAIT & FUTEX_WAKE).
// 6. Cooperative round-robin context switching via sys_sched_yield (syscall 124).
// 7. Verification of atomic counter = 10, exiting with status code 42 via sys_exit_group (syscall 94).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Decoder } from "../src/decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT_DIR, "bin");

// Helper to encode ARMv8.1-A LSE atomic memory operations:
// size[31:30] 111000 A R 1 Rs[20:16] opc[15:12] 00 Rn[9:5] Rt[4:0]
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

// Helper to assemble standard ELF64
function buildElfWithPayload(instructions, dataBuffer = Buffer.alloc(0), entryAddr = 0x00400000n) {
  const payload = Buffer.concat([
    Buffer.from(new Uint32Array(instructions).buffer),
    dataBuffer
  ]);

  const codeOffset = 0x1000; // 4KB page aligned
  const totalFileSize = codeOffset + payload.length;
  const buffer = Buffer.alloc(totalFileSize, 0);

  // 1. ELF Header (64 bytes)
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46; // Magic
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // Little-Endian
  buffer[6] = 1; // Version
  buffer[7] = 0; // Linux ABI
  buffer.writeUInt16LE(2, 16);             // ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18);         // EM_AARCH64 (183)
  buffer.writeUInt32LE(1, 20);              // Version 1
  buffer.writeBigUInt64LE(entryAddr, 24);   // Entry point
  buffer.writeBigUInt64LE(64n, 32);         // Program header offset
  buffer.writeBigUInt64LE(0n, 40);          // Section header offset
  buffer.writeUInt32LE(0, 48);              // Flags
  buffer.writeUInt16LE(64, 52);             // ELF header size
  buffer.writeUInt16LE(56, 54);             // Program header entry size
  buffer.writeUInt16LE(1, 56);              // Number of program headers
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(0, 60);
  buffer.writeUInt16LE(0, 62);

  // 2. Program Header (PT_LOAD)
  const phOffset = 64;
  buffer.writeUInt32LE(1, phOffset + 0);                    // PT_LOAD
  buffer.writeUInt32LE(7, phOffset + 4);                    // PF_R | PF_W | PF_X = 7
  buffer.writeBigUInt64LE(BigInt(codeOffset), phOffset + 8); // File offset
  buffer.writeBigUInt64LE(entryAddr, phOffset + 16);        // Virtual address
  buffer.writeBigUInt64LE(entryAddr, phOffset + 24);        // Physical address
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 32); // File size
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 40); // Memory size
  buffer.writeBigUInt64LE(0x1000n, phOffset + 48);          // 4KB alignment

  // 3. Write payload at codeOffset
  payload.copy(buffer, codeOffset);

  return buffer;
}

export function generateThreadsElf() {
  const instrs = [];

  // Opcodes for ARMv8.1-A LSE instructions:
  const ldadd_w1_wzr_x2 = encodeLse(2, 0, 0, 1, 0, 2, 31); // ldadd w1, wzr, [x2]
  const swp_w1_wzr_x6   = encodeLse(2, 0, 0, 1, 8, 6, 31); // swp w1, wzr, [x6]

  // Shared Memory Architecture:
  // 0x00410000: shared_counter (uint32)
  // 0x00410004: futex_barrier  (uint32)
  // 0x00420000: child stack top

  // --- Step 1: Initialization ---
  // 0: movz x0, #0x41, lsl #16 -> x0 = 0x00410000
  instrs.push(0xd2a00820);
  // 1: str xzr, [x0] -> clear shared_counter and futex_barrier
  instrs.push(0xf900001f);
  // 2: str xzr, [x0, #8]
  instrs.push(0xf900041f);

  // --- Step 2: Spawn Child Worker Thread via sys_clone (220) ---
  // 3: movz x0, #0x0700 (CLONE_VM | CLONE_FS | CLONE_FILES = 0x700)
  instrs.push(0xd280e000);
  // 4: movk x0, #0x0001, lsl #16 (CLONE_THREAD = 0x10000 -> flags = 0x10700)
  instrs.push(0xf2a00020);
  // 5: movz x1, #0x42, lsl #16 (stack_ptr = 0x00420000)
  instrs.push(0xd2a00841);
  // 6: movz x2, #0 (parent_tidptr = 0)
  instrs.push(0xd2800002);
  // 7: movz x3, #0 (tls_ptr = 0)
  instrs.push(0xd2800003);
  // 8: movz x4, #0 (child_tidptr = 0)
  instrs.push(0xd2800004);
  // 9: movz x8, #220 (sys_clone)
  instrs.push(0xd2801b88);
  // 10: svc #0
  instrs.push(0xd4000001);

  // 11: cbz w0, child (at index 38): offset = (38 - 11) * 4 = 108B
  const childIdx = 38;
  const cbzOffset = (childIdx - 11) * 4;
  const cbzInstr = (0x34000000 | ((cbzOffset >> 2) << 5) | 0) >>> 0;
  instrs.push(cbzInstr); // 11

  // --- Step 3: Parent Execution Pipeline (Index 12..37) ---
  // 12: movz x2, #0x41, lsl #16 (x2 = 0x00410000)
  instrs.push(0xd2a00822);
  // 13: movz x3, #5 (iterate 5 times)
  instrs.push(0xd28000a3);

  // parent_loop (14):
  // 14: movz x1, #1
  instrs.push(0xd2800021);
  // 15: ldadd w1, wzr, [x2] (atomic add 1 into shared_counter)
  instrs.push(ldadd_w1_wzr_x2);
  // 16: movz x8, #124 (sys_sched_yield)
  instrs.push(0xd2800f88);
  // 17: svc #0
  instrs.push(0xd4000001);
  // 18: sub x3, x3, #1
  instrs.push(0xd1000463);
  // 19: cbnz w3, parent_loop (offset = (14 - 19) * 4 = -20B)
  const cbnzImm19 = ((-5) & 0x7ffff) << 5;
  instrs.push((0x35000003 | cbnzImm19) >>> 0);

  // parent_wait (20):
  // 20: ldr w4, [x2, #4] (read futex_barrier)
  instrs.push(0xb9400444);
  // 21: cbnz w4, parent_check (at 28): offset = (28 - 21) * 4 = 28B -> imm19 = 7
  instrs.push((0x35000004 | (7 << 5)) >>> 0);
  // 22: add x0, x2, #4 (uaddr = 0x00410004)
  instrs.push(0x91001040);
  // 23: movz x1, #0 (FUTEX_WAIT = 0)
  instrs.push(0xd2800001);
  // 24: movz x2, #0 (expected val = 0)
  instrs.push(0xd2800002);
  // 25: movz x8, #98 (sys_futex)
  instrs.push(0xd2800c48);
  // 26: svc #0
  instrs.push(0xd4000001);
  // 27: b parent_wait (20): offset = (20 - 27) * 4 = -28B -> imm26 = -7
  const bImm26 = ((-7) & 0x3ffffff);
  instrs.push((0x14000000 | bImm26) >>> 0);

  // parent_check (28):
  // 28: movz x2, #0x41, lsl #16
  instrs.push(0xd2a00822);
  // 29: ldr w5, [x2] (read shared_counter)
  instrs.push(0xb9400045);
  // 30: cmp w5, #10 -> subs wzr, w5, #10
  instrs.push(0x710028bf);
  // 31: b.eq parent_success (35): offset = (35 - 31) * 4 = 16B -> imm19 = 4
  instrs.push((0x54000000 | (4 << 5)) >>> 0);

  // parent_failure (32):
  // 32: movz x0, #1
  instrs.push(0xd2800020);
  // 33: movz x8, #94 (sys_exit_group)
  instrs.push(0xd2800bc8);
  // 34: svc #0
  instrs.push(0xd4000001);

  // parent_success (35):
  // 35: movz x0, #42 (Success verification code 42)
  instrs.push(0xd2800540);
  // 36: movz x8, #94 (sys_exit_group)
  instrs.push(0xd2800bc8);
  // 37: svc #0
  instrs.push(0xd4000001);

  // --- Step 4: Child Worker Execution Pipeline (Index 38..56) ---
  // 38: movz x2, #0x41, lsl #16 (x2 = 0x00410000)
  instrs.push(0xd2a00822);
  // 39: movz x3, #5 (iterate 5 times)
  instrs.push(0xd28000a3);

  // child_loop (40):
  // 40: movz x1, #1
  instrs.push(0xd2800021);
  // 41: ldadd w1, wzr, [x2] (atomic add 1 into shared_counter)
  instrs.push(ldadd_w1_wzr_x2);
  // 42: movz x8, #124 (sys_sched_yield)
  instrs.push(0xd2800f88);
  // 43: svc #0
  instrs.push(0xd4000001);
  // 44: sub x3, x3, #1
  instrs.push(0xd1000463);
  // 45: cbnz w3, child_loop (40): offset = (40 - 45) * 4 = -20B
  instrs.push((0x35000003 | cbnzImm19) >>> 0);

  // 46: add x6, x2, #4 (x6 = 0x00410004: futex_barrier)
  instrs.push(0x91001046);
  // 47: movz x1, #1
  instrs.push(0xd2800021);
  // 48: swp w1, wzr, [x6] (atomic swap 1 into futex_barrier)
  instrs.push(swp_w1_wzr_x6);
  // 49: mov x0, x6 (uaddr = 0x00410004) -> orr x0, xzr, x6
  instrs.push(0xaa0603e0);
  // 50: movz x1, #1 (FUTEX_WAKE = 1)
  instrs.push(0xd2800021);
  // 51: movz x2, #1 (val = 1: wake up to 1 thread)
  instrs.push(0xd2800022);
  // 52: movz x8, #98 (sys_futex)
  instrs.push(0xd2800c48);
  // 53: svc #0
  instrs.push(0xd4000001);

  // 54: movz x0, #0 (child exit code 0)
  instrs.push(0xd2800000);
  // 55: movz x8, #93 (sys_exit)
  instrs.push(0xd2800ba8);
  // 56: svc #0
  instrs.push(0xd4000001);

  return buildElfWithPayload(instrs, Buffer.alloc(0), 0x00400000n);
}

// Generate ELF file when invoked directly
if (process.argv[1] && (process.argv[1].endsWith("build_threads_elf.js") || process.argv[1].includes("build_threads_elf"))) {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const elfBuffer = generateThreadsElf();
  const destPath = path.join(BIN_DIR, "threads.elf");
  fs.writeFileSync(destPath, elfBuffer);
  console.log(`[PASS] Successfully built "${destPath}" (${elfBuffer.length} bytes, 57 AArch64 instructions)`);
}
