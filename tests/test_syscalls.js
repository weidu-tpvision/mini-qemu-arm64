// tests/test_syscalls.js - Unit tests for Level 1 Linux system calls (sys_brk, sys_mmap, sys_read, sys_clock_gettime)
import { MiniQEMU } from "../src/emulator.js";

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
}

console.log("Running Level 1 Linux ARM64 System Call Unit Tests...\n");

// --- Test 1: sys_brk (Dynamic Heap Management) ---
{
  const emu = new MiniQEMU();
  // Assemble instructions:
  // 1. movz x0, #0 (query brk)
  // 2. movz x8, #214 (sys_brk)
  // 3. svc #0
  // 4. movz x1, #4096 (add 4KB)
  // 5. add x0, x0, x1 (new break request)
  // 6. movz x8, #214 (sys_brk)
  // 7. svc #0
  // 8. movz x2, #0x55aa (test value)
  // 9. str x2, [x0, #-8] (store to heap)
  // 10. ldr x3, [x0, #-8] (load back from heap)
  // 11. movz x8, #93 (sys_exit)
  // 12. svc #0
  const instructions = [
    0xd2800000, // movz x0, #0
    0xd2801ac8, // movz x8, #214
    0xd4000001, // svc #0
    0xd2820001, // movz x1, #4096
    0x8b010000, // add x0, x0, x1
    0xd2801ac8, // movz x8, #214
    0xd4000001, // svc #0
    0xd28ab542, // movz x2, #21930 (0x55aa)
    0xf81f8002, // stur x2, [x0, #-8] -> or str x2, [x0]
    0xf85f8003, // ldur x3, [x0, #-8]
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.heapStart = 0x00500000n;
  emu.brk = 0x00500000n;

  // Step 1-3: query brk
  emu.step(false);
  emu.step(false);
  emu.step(false);
  assert(emu.cpu.getReg(0) === 0x00500000n, `Initial brk should be 0x00500000, got 0x${emu.cpu.getReg(0).toString(16)}`);

  // Step 4-7: allocate 4KB heap
  emu.step(false);
  emu.step(false);
  emu.step(false);
  emu.step(false);
  assert(emu.cpu.getReg(0) === 0x00501000n, `Expanded brk should be 0x00501000, got 0x${emu.cpu.getReg(0).toString(16)}`);
  assert(emu.brk === 0x00501000n, "Emulator brk state updated");

  // Step 8-12: write and read back at [x0, #-8] (0x00500ff8) via STUR/LDUR, then exit
  emu.run(10, false);
  assert(emu.cpu.getReg(3) === 0x55aan, `STUR/LDUR on expanded heap should read back 0x55aa, got 0x${emu.cpu.getReg(3).toString(16)}`);
  assert(emu.memory.read64(0x00500ff8) === 0x55aan, "Heap memory at 0x00500ff8 must hold 0x55aa");

  console.log("[PASS] sys_brk (query, expand heap & STUR/LDUR negative offset) verified successfully");
}

// --- Test 2: sys_mmap (Anonymous Virtual Memory Allocation) ---
{
  const emu = new MiniQEMU();
  // 1. movz x0, #0 (addr = 0, kernel chooses)
  // 2. movz x1, #8192 (len = 8KB)
  // 3. movz x8, #222 (sys_mmap)
  // 4. svc #0
  // 5. movz x8, #93 (sys_exit)
  // 6. svc #0
  const instructions = [
    0xd2800000, // movz x0, #0
    0xd2840001, // movz x1, #8192
    0xd2801bc8, // movz x8, #222
    0xd4000001, // svc #0
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(10, false);
  const allocatedAddr = emu.cpu.getReg(0);
  assert(allocatedAddr === 0x10000000n, `sys_mmap should allocate at 0x10000000, got 0x${allocatedAddr.toString(16)}`);
  assert(emu.mmapCurrent === 0x10002000n, `sys_mmap pointer advanced by 8KB to 0x10002000, got 0x${emu.mmapCurrent.toString(16)}`);

  console.log("[PASS] sys_mmap (anonymous memory mapping) verified successfully");
}

// --- Test 3: sys_read (Standard Input / stdin) ---
{
  const emu = new MiniQEMU();
  // Feed input stream
  emu.feedStdin("ARM64!\n");

  // 1. movz x0, #0 (fd = 0: stdin)
  // 2. movz x1, #0x40, lsl #16 (buf = 0x00402000)
  // 3. add x1, x1, #2, lsl #12
  // 4. movz x2, #7 (read 7 bytes)
  // 5. movz x8, #63 (sys_read)
  // 6. svc #0
  // 7. movz x8, #93 (sys_exit)
  // 8. svc #0
  const instructions = [
    0xd2800000, // movz x0, #0
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91400821, // add x1, x1, #2, lsl #12 -> 0x00402000
    0xd28000e2, // movz x2, #7
    0xd28007e8, // movz x8, #63 (sys_read)
    0xd4000001, // svc #0
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(10, false);

  const bytesRead = Number(emu.cpu.getReg(0));
  assert(bytesRead === 7, `sys_read should return 7 bytes read, got ${bytesRead}`);

  const readBytes = [];
  for (let i = 0; i < 7; i++) {
    readBytes.push(emu.memory.read8(0x00402000 + i));
  }
  const text = new TextDecoder().decode(new Uint8Array(readBytes));
  assert(text === "ARM64!\n", `Expected "ARM64!\\n", got "${text}"`);

  console.log("[PASS] sys_read (stdin reading) verified successfully");
}

// --- Test 4: sys_clock_gettime ---
{
  const emu = new MiniQEMU();
  // 1. movz x0, #0 (CLOCK_REALTIME)
  // 2. movz x1, #0x40, lsl #16 (buf = 0x00403000)
  // 3. add x1, x1, #3, lsl #12
  // 4. movz x8, #113 (sys_clock_gettime)
  // 5. svc #0
  // 6. movz x8, #93
  // 7. svc #0
  const instructions = [
    0xd2800000, // movz x0, #0
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91400c21, // add x1, x1, #3, lsl #12 -> 0x00403000
    0xd2800e28, // movz x8, #113 (sys_clock_gettime)
    0xd4000001, // svc #0
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(10, false);

  const ret = Number(emu.cpu.getReg(0));
  assert(ret === 0, `clock_gettime should return 0, got ${ret}`);

  const sec = emu.memory.read64(0x00403000);
  const nsec = emu.memory.read64(0x00403008);
  assert(sec > 1700000000n, `tv_sec should be a valid Unix timestamp, got ${sec}`);
  assert(nsec >= 0n && nsec < 1000000000n, `tv_nsec should be within range, got ${nsec}`);

  console.log(`[PASS] sys_clock_gettime verified: sec=${sec}, nsec=${nsec}`);
}

// --- Test 5: sys_uname ---
{
  const emu = new MiniQEMU();
  // 1. movz x0, #0x40, lsl #16 (buf = 0x00404000)
  // 2. add x0, x0, #4, lsl #12
  // 3. movz x8, #160 (sys_uname)
  // 4. svc #0
  // 5. movz x8, #93
  // 6. svc #0
  const instructions = [
    0xd2a00800, // movz x0, #0x40, lsl #16
    0x91401000, // add x0, x0, #4, lsl #12 -> 0x00404000
    0xd2801408, // movz x8, #160 (sys_uname)
    0xd4000001, // svc #0
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(10, false);

  const ret = Number(emu.cpu.getReg(0));
  assert(ret === 0, `uname should return 0, got ${ret}`);

  const sysnameBytes = [];
  for (let i = 0; i < 5; i++) sysnameBytes.push(emu.memory.read8(0x00404000 + i));
  const sysname = new TextDecoder().decode(new Uint8Array(sysnameBytes));
  assert(sysname === "Linux", `Expected sysname "Linux", got "${sysname}"`);

  console.log("[PASS] sys_uname verified successfully");
}

// --- Test 6: sys_writev (Scatter-Gather I/O used by musl/glibc printf) & sys_exit_group ---
{
  const emu = new MiniQEMU();
  let capturedStdout = "";
  emu.onWrite = (text) => { capturedStdout += text; };

  // Write two strings at 0x00405000 ("Hello, ") and 0x00405100 ("writev!\n")
  const str1 = new TextEncoder().encode("Hello, ");
  const str2 = new TextEncoder().encode("writev!\n");
  for (let i = 0; i < str1.length; i++) emu.memory.write8(0x00405000 + i, str1[i]);
  for (let i = 0; i < str2.length; i++) emu.memory.write8(0x00405100 + i, str2[i]);

  // Create struct iovec array at 0x00406000:
  // iov[0] = { iov_base: 0x00405000, iov_len: 7 }
  // iov[1] = { iov_base: 0x00405100, iov_len: 8 }
  emu.memory.write64(0x00406000, 0x00405000n);
  emu.memory.write64(0x00406008, 7n);
  emu.memory.write64(0x00406010, 0x00405100n);
  emu.memory.write64(0x00406018, 8n);

  const instructions = [
    0xd2800020, // movz x0, #1 (stdout)
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91401821, // add x1, x1, #6, lsl #12 -> 0x00406000 (iov)
    0xd2800042, // movz x2, #2 (iovcnt = 2)
    0xd2800848, // movz x8, #66 (sys_writev)
    0xd4000001, // svc #0
    0xd2800540, // movz x0, #42 (exit code 42)
    0xd2800bc8, // movz x8, #94 (sys_exit_group)
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(20, false);

  assert(capturedStdout === "Hello, writev!\n", `Expected "Hello, writev!\\n", got "${capturedStdout}"`);
  assert(emu.cpu.halted === true && emu.cpu.exitCode === 42, `sys_exit_group should halt with exitCode 42, got ${emu.cpu.exitCode}`);
  console.log("[PASS] sys_writev (scatter-gather I/O) & sys_exit_group verified successfully");
}

// --- Test 7: sys_getrandom (Entropy for malloc & stack canaries) ---
{
  const emu = new MiniQEMU();
  const instructions = [
    0xd2a00800, // movz x0, #0x40, lsl #16
    0x91401c00, // add x0, x0, #7, lsl #12 -> 0x00407000 (buf)
    0xd2800201, // movz x1, #16 (buflen = 16)
    0xd2800002, // movz x2, #0 (flags = 0)
    0xd28022c8, // movz x8, #278 (sys_getrandom)
    0xd4000001, // svc #0
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];
  emu.loadProgram(instructions, 0x00400000);
  emu.run(15, false);

  assert(emu.cpu.getReg(0) === 16n, `sys_getrandom should return 16 bytes filled, got ${emu.cpu.getReg(0)}`);
  const val1 = emu.memory.read64(0x00407000);
  const val2 = emu.memory.read64(0x00407008);
  assert(val1 !== 0n && val2 !== 0n && val1 !== val2, "sys_getrandom must populate non-zero entropy bytes");
  console.log("[PASS] sys_getrandom verified successfully");
}

// --- Test 8: Gap C - File System Syscalls (sys_openat, sys_lseek, sys_read, sys_write, sys_fstat, sys_close, sys_unlinkat) ---
{
  const emu = new MiniQEMU();
  // Mount an initial file in VFS: "level1.txt" -> "HEADER:GLIDER_PATTERN" (21 bytes)
  emu.mountFile("level1.txt", "HEADER:GLIDER_PATTERN");

  // Write filename "level1.txt\0" at 0x00405000 and "save.txt\0" at 0x00405100
  const writeGuestStr = (addr, str) => {
    const bytes = new TextEncoder().encode(str + "\0");
    for (let i = 0; i < bytes.length; i++) emu.memory.write8(addr + i, bytes[i]);
  };
  writeGuestStr(0x00405000, "level1.txt");
  writeGuestStr(0x00405100, "save.txt");

  const instructions = [
    // 1. fd_in = sys_openat(AT_FDCWD=-100, "level1.txt" @ 0x405000, O_RDONLY=0, 0) -> syscall 56
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91401421, // add x1, x1, #5, lsl #12 -> x1 = 0x00405000 ("level1.txt")
    0xd2800002, // movz x2, #0 (O_RDONLY)
    0xd2800708, // movz x8, #56 (sys_openat)
    0xd4000001, // svc #0 -> x0 = fd (3)
    0xaa0003f3, // mov x19, x0 (save fd_in in x19)

    // 2. sys_fstat(fd_in=x19, statbuf=0x00406000) -> syscall 80
    0xaa1303e0, // mov x0, x19
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91401821, // add x1, x1, #6, lsl #12 -> x1 = 0x00406000 (statbuf)
    0xd2800a08, // movz x8, #80 (sys_fstat)
    0xd4000001, // svc #0

    // 3. sys_lseek(fd_in=x19, offset=7, SEEK_SET=0) -> skip "HEADER:" -> syscall 62
    0xaa1303e0, // mov x0, x19
    0xd28000e1, // movz x1, #7
    0xd2800002, // movz x2, #0 (SEEK_SET)
    0xd28007c8, // movz x8, #62 (sys_lseek)
    0xd4000001, // svc #0

    // 4. sys_read(fd_in=x19, buf=0x00407000, count=14) -> reads "GLIDER_PATTERN" -> syscall 63
    0xaa1303e0, // mov x0, x19
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91401c21, // add x1, x1, #7, lsl #12 -> x1 = 0x00407000
    0xd28001c2, // movz x2, #14
    0xd28007e8, // movz x8, #63 (sys_read)
    0xd4000001, // svc #0 -> x0 = 14

    // 5. sys_close(fd_in=x19) -> syscall 57
    0xaa1303e0, // mov x0, x19
    0xd2800728, // movz x8, #57 (sys_close)
    0xd4000001, // svc #0

    // 6. fd_out = sys_openat(AT_FDCWD, "save.txt" @ 0x405100, O_RDWR|O_CREAT|O_TRUNC = 0x242, 0644) -> syscall 56
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91401421, // add x1, x1, #5, lsl #12
    0x91040021, // add x1, x1, #0x100 -> x1 = 0x00405100 ("save.txt")
    0xd2804842, // movz x2, #0x242 (O_RDWR=2 | O_CREAT=0x40 | O_TRUNC=0x200)
    0xd2800708, // movz x8, #56 (sys_openat)
    0xd4000001, // svc #0 -> x0 = fd_out
    0xaa0003f4, // mov x20, x0

    // 7. sys_write(fd_out=x20, buf=0x00407000, count=14) -> writes "GLIDER_PATTERN" to "save.txt" -> syscall 64
    0xaa1403e0, // mov x0, x20
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91401c21, // add x1, x1, #7, lsl #12 -> x1 = 0x00407000
    0xd28001c2, // movz x2, #14
    0xd2800808, // movz x8, #64 (sys_write)
    0xd4000001, // svc #0

    // 8. sys_close(fd_out=x20) -> syscall 57
    0xaa1403e0, // mov x0, x20
    0xd2800728, // movz x8, #57 (sys_close)
    0xd4000001, // svc #0

    // 9. sys_exit(0)
    0xd2800000, // movz x0, #0
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];

  emu.loadProgram(instructions, 0x00400000);
  emu.run(60, false);

  // Check fstat st_size at 0x00406000 + 48 = 21 bytes
  const statSize = emu.memory.read64(0x00406000 + 48);
  assert(statSize === 21n, `sys_fstat st_size should be 21, got ${statSize}`);

  // Check that "save.txt" was created in VFS with "GLIDER_PATTERN"
  const savedContent = emu.readVfsFile("save.txt", true);
  assert(savedContent === "GLIDER_PATTERN", `Expected VFS "save.txt" to contain "GLIDER_PATTERN", got "${savedContent}"`);

  console.log("[PASS] Gap C: File system syscalls (sys_openat, sys_fstat, sys_lseek, sys_read, sys_write, sys_close) verified!");
}

// --- Test 9: File-backed sys_mmap, BigInt memory reads, shifted logical ops, and 32-bit STP/LDP ---
{
  const emu = new MiniQEMU();
  emu.mountFile("rom.bin", new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x11, 0x22, 0x33, 0x44]));

  // Verify BigInt address coercion in memory.read8/16/32/64
  emu.memory.write32(0x00409000n, 0x12345678);
  assert(emu.memory.read8(0x00409000n) === 0x78, "read8 must accept BigInt address");
  assert(emu.memory.read16(0x00409000n) === 0x5678, "read16 must accept BigInt address");
  assert(emu.memory.read32(0x00409000n) === 0x12345678, "read32 must accept BigInt address");
  assert(emu.memory.read64(0x00409000n) === 0x12345678n, "read64 must accept BigInt address");

  // Write "rom.bin\0" at 0x00405000
  const nameBytes = new TextEncoder().encode("rom.bin\0");
  for (let i = 0; i < nameBytes.length; i++) emu.memory.write8(0x00405000 + i, nameBytes[i]);

  const instructions = [
    // 1. Open "rom.bin" -> fd in x0 (3)
    0xd2a00801, // movz x1, #0x40, lsl #16
    0x91401421, // add x1, x1, #5, lsl #12 -> 0x00405000
    0xd2800002, // movz x2, #0 (O_RDONLY)
    0xd2800708, // movz x8, #56 (sys_openat)
    0xd4000001, // svc #0 -> x0 = 3

    // 2. sys_mmap(addr=0, len=8, prot=1, flags=2, fd=x0 (in x4), offset=0 (in x5)) -> syscall 222
    0xaa0003e4, // mov x4, x0 (fd = 3)
    0xd2800000, // movz x0, #0 (addr = NULL)
    0xd2800101, // movz x1, #8 (len = 8)
    0xd2800022, // movz x2, #1 (PROT_READ)
    0xd2800043, // movz x3, #2 (MAP_PRIVATE)
    0xd2800005, // movz x5, #0 (offset = 0)
    0xd2801bc8, // movz x8, #222 (sys_mmap)
    0xd4000001, // svc #0 -> x0 = 0x10000000

    // 3. Test 32-bit LDP w1, w2, [x0] (loads 0xefbeadde into w1 and 0x44332211 into w2)
    0x29400801, // ldp w1, w2, [x0]
    // 4. Test 32-bit STP w1, w2, [sp, #-16]! and LDP w3, w4, [sp], #16
    0x29be0be1, // stp w1, w2, [sp, #-16]!
    0x28c213e3, // ldp w3, w4, [sp], #16
    // 5. Test shifted logical instruction: orr x5, x3, x4, lsl #32
    0xaa048065, // orr x5, x3, x4, lsl #32
    // 6. Exit
    0xd2800ba8, // movz x8, #93
    0xd4000001  // svc #0
  ];

  emu.loadProgram(instructions, 0x00400000);
  emu.run(30, false);

  assert(emu.cpu.getReg(3) === 0xefbeadden, `32-bit LDP w3 should be 0xefbeadde, got 0x${emu.cpu.getReg(3).toString(16)}`);
  assert(emu.cpu.getReg(4) === 0x44332211n, `32-bit LDP w4 should be 0x44332211, got 0x${emu.cpu.getReg(4).toString(16)}`);
  assert(emu.cpu.getReg(5) === 0x44332211efbeadden, `Shifted ORR_REG x5 should be 0x44332211efbeadde, got 0x${emu.cpu.getReg(5).toString(16)}`);
  console.log("[PASS] File-backed sys_mmap, BigInt memory reads, shifted logical ops, and 32-bit STP/LDP verified!");
}

// --- Test 10: Extended Static Libc Linux Syscalls (futex, prlimit64, robust_list, sigaction, gettimeofday, credentials, readv, dup, fallback) ---
{
  const emu = new MiniQEMU();

  // 1. sys_set_robust_list (99)
  emu.cpu.setReg(8, 99n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "sys_set_robust_list must return 0");

  // 2. sys_prlimit64 (261)
  const limitAddr = 0x00408000;
  emu.cpu.setReg(8, 261n);
  emu.cpu.setReg(0, 0n); // pid = 0
  emu.cpu.setReg(1, 3n); // RLIMIT_STACK
  emu.cpu.setReg(2, 0n);
  emu.cpu.setReg(3, BigInt(limitAddr));
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "sys_prlimit64 must return 0");
  assert(emu.memory.read64(limitAddr) === 8n * 1024n * 1024n, "rlim_cur must be 8MB");

  // 3. sys_futex (98)
  const futexAddr = 0x00408100;
  emu.memory.write32(futexAddr, 42);
  emu.cpu.setReg(8, 98n);
  emu.cpu.setReg(0, BigInt(futexAddr));
  emu.cpu.setReg(1, 0n); // FUTEX_WAIT
  emu.cpu.setReg(2, 42n); // expected 42
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "FUTEX_WAIT matching value must succeed (0)");

  // FUTEX_WAIT value mismatch -> -EAGAIN (-11)
  emu.cpu.setReg(8, 98n);
  emu.cpu.setReg(0, BigInt(futexAddr));
  emu.cpu.setReg(1, 0n); // FUTEX_WAIT
  emu.cpu.setReg(2, 99n); // expected 99, but memory has 42
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt.asUintN(64, -11n), "FUTEX_WAIT mismatch must return -EAGAIN (-11)");

  // FUTEX_WAKE (1)
  emu.cpu.setReg(8, 98n);
  emu.cpu.setReg(0, BigInt(futexAddr));
  emu.cpu.setReg(1, 1n); // FUTEX_WAKE
  emu.cpu.setReg(2, 1n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "FUTEX_WAKE must return 0");

  // 4. Signals: sys_rt_sigaction (134), sys_rt_sigprocmask (135), sys_sigaltstack (132)
  emu.cpu.setReg(8, 134n);
  emu.cpu.setReg(0, 2n); // SIGINT
  emu.cpu.setReg(1, 0n);
  emu.cpu.setReg(2, BigInt(limitAddr));
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "sys_rt_sigaction must return 0");

  emu.cpu.setReg(8, 135n);
  emu.cpu.setReg(0, 0n);
  emu.cpu.setReg(1, 0n);
  emu.cpu.setReg(2, BigInt(limitAddr));
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "sys_rt_sigprocmask must return 0");

  emu.cpu.setReg(8, 132n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "sys_sigaltstack must return 0");

  // 5. Credentials: getppid (173), getuid (174), geteuid (175), getgid (176), getegid (177)
  emu.cpu.setReg(8, 173n); emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 1n, "sys_getppid must return 1");
  emu.cpu.setReg(8, 174n); emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 1000n, "sys_getuid must return 1000");

  // 6. Time & Memory: sys_gettimeofday (169), sys_madvise (233)
  const tvAddr = 0x00408200;
  emu.cpu.setReg(8, 169n);
  emu.cpu.setReg(0, BigInt(tvAddr));
  emu.cpu.setReg(1, 0n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "sys_gettimeofday must return 0");
  assert(emu.memory.read64(tvAddr) > 1700000000n, "sys_gettimeofday must populate valid epoch seconds");

  emu.cpu.setReg(8, 233n); emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "sys_madvise must return 0");

  // 7. Scatter-gather I/O: sys_readv (65)
  emu.mountFile("vec_data.txt", "ABCDEF123456");
  emu.cpu.setReg(8, 56n); // openat
  const nameAddr = 0x00408300;
  const nameBytes = new TextEncoder().encode("vec_data.txt\0");
  for (let i = 0; i < nameBytes.length; i++) emu.memory.write8(nameAddr + i, nameBytes[i]);
  emu.cpu.setReg(1, BigInt(nameAddr));
  emu.cpu.setReg(2, 0n); // O_RDONLY
  emu.handleSyscall();
  const openedFd = emu.cpu.getReg(0);
  assert(openedFd >= 3n, "openat should return valid fd");

  // Prepare 2 iovec chunks: 6 bytes to 0x408400, 6 bytes to 0x408500
  const iovAddr = 0x00408380;
  emu.memory.write64(iovAddr, 0x00408400n);
  emu.memory.write64(iovAddr + 8, 6n);
  emu.memory.write64(iovAddr + 16, 0x00408500n);
  emu.memory.write64(iovAddr + 24, 6n);

  emu.cpu.setReg(8, 65n); // sys_readv
  emu.cpu.setReg(0, openedFd);
  emu.cpu.setReg(1, BigInt(iovAddr));
  emu.cpu.setReg(2, 2n); // iovcnt = 2
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 12n, `sys_readv must read 12 bytes total, got ${emu.cpu.getReg(0)}`);
  const chunk1 = emu.readGuestCString(0x00408400, 6);
  const chunk2 = emu.readGuestCString(0x00408500, 6);
  assert(chunk1 === "ABCDEF", `chunk1 should be "ABCDEF", got "${chunk1}"`);
  assert(chunk2 === "123456", `chunk2 should be "123456", got "${chunk2}"`);

  // 8. sys_dup (23) & sys_fcntl (25) & sys_ioctl (29)
  emu.cpu.setReg(8, 23n);
  emu.cpu.setReg(0, openedFd);
  emu.handleSyscall();
  const dupFd = emu.cpu.getReg(0);
  assert(dupFd > openedFd, "sys_dup should allocate new fd");

  emu.cpu.setReg(8, 25n); // sys_fcntl F_GETFL
  emu.cpu.setReg(0, openedFd);
  emu.cpu.setReg(1, 3n); // F_GETFL
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "F_GETFL for O_RDONLY should return 0");

  const wsAddr = 0x00408600;
  emu.cpu.setReg(8, 29n); // sys_ioctl TIOCGWINSZ
  emu.cpu.setReg(0, 1n); // stdout
  emu.cpu.setReg(1, 0x5413n);
  emu.cpu.setReg(2, BigInt(wsAddr));
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "TIOCGWINSZ must return 0");
  assert(emu.memory.read16(wsAddr) === 24, "ws_row must be 24");
  assert(emu.memory.read16(wsAddr + 2) === 80, "ws_col must be 80");

  // 9. Standard Linux -ENOSYS Fallback: sys_statx (291), sys_rseq (293), and unknown syscall 999
  emu.cpu.setReg(8, 291n); emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt.asUintN(64, -38n), "sys_statx must return -ENOSYS (-38)");

  emu.cpu.setReg(8, 293n); emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt.asUintN(64, -38n), "sys_rseq must return -ENOSYS (-38)");

  emu.cpu.setReg(8, 999n); emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt.asUintN(64, -38n), "Unknown syscall 999 must return -ENOSYS (-38)");

  console.log("[PASS] Extended static libc syscalls (futex, prlimit64, robust_list, readv, signals, dup, ioctl, -ENOSYS fallback) verified!");
}

// --- Test 9: File Descriptors, Pipes, Redirection & Terminal Controls ---
{
  const emu = new MiniQEMU();

  // 1. pipe2 (59) write-then-read round trip
  const pipeBufAddr = 0x00409000;
  emu.cpu.setReg(8, 59n); // sys_pipe2
  emu.cpu.setReg(0, BigInt(pipeBufAddr));
  emu.cpu.setReg(1, 0n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "pipe2 must return 0");
  const rFd = emu.memory.read32(pipeBufAddr);
  const wFd = emu.memory.read32(pipeBufAddr + 4);
  assert(rFd >= 3 && wFd >= 3 && rFd !== wFd, `pipe2 must allocate distinct fds, got ${rFd}, ${wFd}`);

  // Write to pipe
  const writeText = "Hello pipe!";
  const writeBytes = new TextEncoder().encode(writeText);
  const msgAddr = 0x00409100;
  for (let i = 0; i < writeBytes.length; i++) emu.memory.write8(msgAddr + i, writeBytes[i]);
  emu.cpu.setReg(8, 64n); // sys_write
  emu.cpu.setReg(0, BigInt(wFd));
  emu.cpu.setReg(1, BigInt(msgAddr));
  emu.cpu.setReg(2, BigInt(writeBytes.length));
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt(writeBytes.length), `write to pipe must write ${writeBytes.length} bytes`);

  // Read from pipe
  const readBufAddr = 0x00409200;
  emu.cpu.setReg(8, 63n); // sys_read
  emu.cpu.setReg(0, BigInt(rFd));
  emu.cpu.setReg(1, BigInt(readBufAddr));
  emu.cpu.setReg(2, 64n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt(writeBytes.length), `read from pipe must return ${writeBytes.length} bytes`);
  const pipeReadStr = emu.readGuestCString(readBufAddr, writeBytes.length);
  assert(pipeReadStr === writeText, `pipe read expected "${writeText}", got "${pipeReadStr}"`);

  // Close pipe ends
  emu.cpu.setReg(8, 57n); emu.cpu.setReg(0, BigInt(rFd)); emu.handleSyscall();
  emu.cpu.setReg(8, 57n); emu.cpu.setReg(0, BigInt(wFd)); emu.handleSyscall();

  // 2. dup(1) then write to the new fd goes to console (use emu.onWrite + emu.suppressStdout = true)
  emu.suppressStdout = true;
  let capturedOutput = "";
  emu.onWrite = (str, fd) => {
    capturedOutput += str;
  };
  emu.cpu.setReg(8, 23n); // sys_dup
  emu.cpu.setReg(0, 1n); // stdout
  emu.handleSyscall();
  const dupStdoutFd = emu.cpu.getReg(0);
  assert(dupStdoutFd >= 3n, `dup(1) must allocate fd >= 3, got ${dupStdoutFd}`);

  const testConsoleMsg = "Captured via dup(1)!";
  const consoleBytes = new TextEncoder().encode(testConsoleMsg);
  const consoleMsgAddr = 0x00409300;
  for (let i = 0; i < consoleBytes.length; i++) emu.memory.write8(consoleMsgAddr + i, consoleBytes[i]);
  emu.cpu.setReg(8, 64n); // sys_write
  emu.cpu.setReg(0, dupStdoutFd);
  emu.cpu.setReg(1, BigInt(consoleMsgAddr));
  emu.cpu.setReg(2, BigInt(consoleBytes.length));
  emu.handleSyscall();
  assert(capturedOutput === testConsoleMsg, `capturedOutput expected "${testConsoleMsg}", got "${capturedOutput}"`);
  emu.onWrite = null;

  // 3. dup3(fileFd, 1) redirects a write on fd 1 into the VFS file (after close, readVfsFile has content)
  emu.mountFile("redirected.txt", "");
  emu.cpu.setReg(8, 56n); // openat
  const fnameAddr = 0x00409400;
  const fnameBytes = new TextEncoder().encode("redirected.txt\0");
  for (let i = 0; i < fnameBytes.length; i++) emu.memory.write8(fnameAddr + i, fnameBytes[i]);
  emu.cpu.setReg(1, BigInt(fnameAddr));
  emu.cpu.setReg(2, 2n); // O_RDWR
  emu.handleSyscall();
  const fileFd = emu.cpu.getReg(0);
  assert(fileFd >= 3n, "openat should return valid fd for redirected.txt");

  emu.cpu.setReg(8, 24n); // sys_dup3
  emu.cpu.setReg(0, fileFd);
  emu.cpu.setReg(1, 1n); // redirect stdout to fileFd
  emu.cpu.setReg(2, 0n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 1n, "dup3(fileFd, 1) must return 1");

  const redirText = "Written to stdout redirected to file!";
  const redirBytes = new TextEncoder().encode(redirText);
  const redirAddr = 0x00409500;
  for (let i = 0; i < redirBytes.length; i++) emu.memory.write8(redirAddr + i, redirBytes[i]);
  emu.cpu.setReg(8, 64n); // sys_write to fd 1
  emu.cpu.setReg(0, 1n);
  emu.cpu.setReg(1, BigInt(redirAddr));
  emu.cpu.setReg(2, BigInt(redirBytes.length));
  emu.handleSyscall();

  // Close fd 1 (which drops redirected file and flushes it)
  emu.cpu.setReg(8, 57n); // sys_close
  emu.cpu.setReg(0, 1n);
  emu.handleSyscall();

  const fileContent = emu.readVfsFile("redirected.txt", true);
  assert(fileContent === redirText, `redirected.txt expected "${redirText}", got "${fileContent}"`);

  // Close fileFd
  emu.cpu.setReg(8, 57n);
  emu.cpu.setReg(0, fileFd);
  emu.handleSyscall();

  // 4. dup shares offset (read 3 bytes from fd A then 3 from its dup B => consecutive)
  emu.mountFile("offset_test.txt", "1234567890");
  const ofNameAddr = 0x00409600;
  const ofNameBytes = new TextEncoder().encode("offset_test.txt\0");
  for (let i = 0; i < ofNameBytes.length; i++) emu.memory.write8(ofNameAddr + i, ofNameBytes[i]);
  emu.cpu.setReg(8, 56n); // openat
  emu.cpu.setReg(1, BigInt(ofNameAddr));
  emu.cpu.setReg(2, 0n); // O_RDONLY
  emu.handleSyscall();
  const fdA = emu.cpu.getReg(0);

  emu.cpu.setReg(8, 23n); // dup
  emu.cpu.setReg(0, fdA);
  emu.handleSyscall();
  const fdB = emu.cpu.getReg(0);

  const part1Addr = 0x00409700;
  emu.cpu.setReg(8, 63n); // read 3 bytes from fdA
  emu.cpu.setReg(0, fdA);
  emu.cpu.setReg(1, BigInt(part1Addr));
  emu.cpu.setReg(2, 3n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 3n, "read 3 bytes from fdA");
  const part1 = emu.readGuestCString(part1Addr, 3);
  assert(part1 === "123", `part1 expected "123", got "${part1}"`);

  const part2Addr = 0x00409710;
  emu.cpu.setReg(8, 63n); // read 3 bytes from fdB
  emu.cpu.setReg(0, fdB);
  emu.cpu.setReg(1, BigInt(part2Addr));
  emu.cpu.setReg(2, 3n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 3n, "read 3 bytes from fdB");
  const part2 = emu.readGuestCString(part2Addr, 3);
  assert(part2 === "456", `part2 expected "456", got "${part2}"`);

  emu.cpu.setReg(8, 57n); emu.cpu.setReg(0, fdA); emu.handleSyscall();
  emu.cpu.setReg(8, 57n); emu.cpu.setReg(0, fdB); emu.handleSyscall();

  // 5. F_DUPFD_CLOEXEC returns a new fd >= 3 (not 0)
  emu.cpu.setReg(8, 25n); // fcntl
  emu.cpu.setReg(0, 0n); // stdin
  emu.cpu.setReg(1, 1030n); // F_DUPFD_CLOEXEC
  emu.cpu.setReg(2, 0n); // minFd = 0
  emu.handleSyscall();
  const cloexecFd = emu.cpu.getReg(0);
  assert(cloexecFd >= 3n, `F_DUPFD_CLOEXEC must return fd >= 3, got ${cloexecFd}`);
  emu.cpu.setReg(8, 57n); emu.cpu.setReg(0, cloexecFd); emu.handleSyscall();

  // 6. ioctl TCGETS on a regular file fd => -ENOTTY (-25)
  emu.mountFile("regular.txt", "abc");
  const regNameAddr = 0x00409800;
  const regNameBytes = new TextEncoder().encode("regular.txt\0");
  for (let i = 0; i < regNameBytes.length; i++) emu.memory.write8(regNameAddr + i, regNameBytes[i]);
  emu.cpu.setReg(8, 56n); // openat
  emu.cpu.setReg(1, BigInt(regNameAddr));
  emu.cpu.setReg(2, 0n);
  emu.handleSyscall();
  const regFd = emu.cpu.getReg(0);

  emu.cpu.setReg(8, 29n); // ioctl
  emu.cpu.setReg(0, regFd);
  emu.cpu.setReg(1, 0x5401n); // TCGETS
  emu.cpu.setReg(2, 0x00409900n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt.asUintN(64, -25n), `ioctl TCGETS on regular file expected -ENOTTY (-25), got ${emu.cpu.getReg(0)}`);
  emu.cpu.setReg(8, 57n); emu.cpu.setReg(0, regFd); emu.handleSyscall();

  // 7. prlimit64 RLIMIT_NOFILE => 1024
  const nofileAddr = 0x00409a00;
  emu.cpu.setReg(8, 261n); // prlimit64
  emu.cpu.setReg(0, 0n);
  emu.cpu.setReg(1, 7n); // RLIMIT_NOFILE
  emu.cpu.setReg(2, 0n);
  emu.cpu.setReg(3, BigInt(nofileAddr));
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === 0n, "prlimit64 RLIMIT_NOFILE must return 0");
  assert(emu.memory.read64(nofileAddr) === 1024n, `RLIMIT_NOFILE cur limit must be 1024, got ${emu.memory.read64(nofileAddr)}`);
  assert(emu.memory.read64(nofileAddr + 8) === 4096n, `RLIMIT_NOFILE max limit must be 4096, got ${emu.memory.read64(nofileAddr + 8)}`);

  // 8. dup3(fd, fd) => -EINVAL (-22)
  emu.cpu.setReg(8, 24n); // dup3
  emu.cpu.setReg(0, 3n);
  emu.cpu.setReg(1, 3n); // old === new
  emu.cpu.setReg(2, 0n);
  emu.handleSyscall();
  assert(emu.cpu.getReg(0) === BigInt.asUintN(64, -22n), `dup3(fd, fd) expected -EINVAL (-22), got ${emu.cpu.getReg(0)}`);

  console.log("[PASS] File descriptor management (pipe2, dup console, dup3 redirect, shared offset, F_DUPFD_CLOEXEC, TCGETS ENOTTY, prlimit64 NOFILE, dup3 EINVAL) verified!");
}

console.log("\nAll Level 1 Linux ARM64 System Call Tests Passed Successfully!");
