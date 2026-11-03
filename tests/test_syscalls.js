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

console.log("\nAll Level 1 Linux ARM64 System Call Tests Passed Successfully!");
