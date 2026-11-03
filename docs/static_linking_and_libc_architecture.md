# Static Linking, Libc Architecture, and Linux ABI in CPU Emulators

A deep-dive engineering document on how CPU emulators support external libraries, the critical distinction between user-space library functions and kernel system calls, and how Mini-QEMU was extended to support statically-linked standard C libraries.

---

## 1. Overview: The Library Support Dilemma in Emulators

When building a CPU emulator, one of the earliest milestones is running simple freestanding binaries (like recursive Fibonacci or iterative math loops). But sooner or later, every emulator developer asks:

> *"How do I run real software that calls `printf()`, allocates memory with `malloc()`, or sorts data with `qsort()`? Do I have to re-implement every function in the C standard library?"*

The answer depends entirely on which **architectural approach** the emulator takes.

```
+-----------------------------------------------------------------------------------------+
|                        3 Approaches to External Library Support                         |
+--------------------------+------------------------------+-------------------------------+
| Level 1: Static Libc     | Level 2: Library Call Hooking| Level 3: Full Dynamic Linker  |
| (Statically Linked)      | (High-Level Emulation - HLE) | (.so + ld-linux-aarch64.so.1) |
+--------------------------+------------------------------+-------------------------------+
| • Binary embeds musl/libc| • Intercepts function symbols| • Loads real shared .so files |
| • Libc runs on virtual CPU   (printf, malloc) at PLT    | • Executes ld.so on virtual CPU|
| • Emulator implements    | • Runs on host JS/C++ side   | • Sets up TLS & dynamic relocs|
|   ~10-15 kernel syscalls | • Used by Wine, Box64, FEX   | • Used by full Linux QEMU     |
| [ Chosen for Mini-QEMU ] | [ High-Level Emulation ]     | [ High Complexity ]           |
+--------------------------+------------------------------+-------------------------------+
```

---

## 2. The Core Insight: Library Functions vs. System Calls

A common misconception when first studying emulators is believing that every library function requires emulator code:

> **Misconception:** *"If my guest program calls `malloc()`, `strlen()`, or `qsort()`, I must write an implementation of each in my emulator."*
>
> **Reality:** **No.** You only write code for the **handful of underlying Linux Kernel System Calls (`SVC #0`)**. The standard C library itself contains the machine code for everything else.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             GUEST USER SPACE                                     │
│                                                                                  │
│   Your C/C++ Code:                                                               │
│     std::vector, malloc, free, calloc, realloc, qsort, strlen, sprintf           │
│                                │                                                 │
│                                ▼                                                 │
│   Statically Linked Libc (e.g., musl libc / dlmalloc / nolibc):                  │
│   • Free-list management, bucket allocation, chunk coalescing                    │
│   • String parsing, number formatting, sorting algorithms                        │
│   • Runs 100% as standard ARM64 CPU instructions (ADD, LDR, STR, B.cond)        │
│                                │                                                 │
│                                ▼ (Only when requesting raw OS pages or I/O)      │
│                     [ SVC #0 (Linux System Call) ]                               │
└────────────────────────────────┬─────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                   MINI-QEMU (Virtual Linux Kernel Boundary)                      │
│                                                                                  │
│   You ONLY write code for ~10 to 15 Linux Kernel Syscalls:                      │
│   • sys_brk / sys_mmap (gives raw memory blocks to libc)                         │
│   • sys_write / sys_read (sends/receives raw byte streams)                       │
│   • sys_clock_gettime (provides hardware clock ticks)                            │
│   • sys_exit (shuts down the VM)                                                 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Concrete Examples

#### 1. Dynamic Heap Memory: `malloc()`, `free()`, `realloc()`
* An emulator **does not implement an allocator**.
* Memory allocators (`dlmalloc`, `ptmalloc`, `jemalloc`) are complex algorithms written in C:
  * They maintain free-lists, bin trees, headers, chunk splitting, and coalescing.
  * When a program calls `malloc(32)`, the allocator searches its internal memory pool and returns a pointer. All of this runs as regular **ARM64 machine instructions** (`LDR`, `STR`, `ADD`).
* The **only** time libc talks to the emulator is when its internal pool runs out of memory. It issues a single system call:
  ```armasm
  mov x0, x_new_break   // Requested heap break address
  mov x8, #214          // sys_brk
  svc #0                // Trap to emulator kernel!
  ```
  The emulator simply expands its virtual memory break pointer and returns. Libc then handles carving up that 64 KB block for dozens of subsequent `malloc()` calls.

#### 2. Pure Computation: `strlen()`, `qsort()`, `memcpy()`, `sin()`
* **Emulator code needed:** **Zero lines.**
* These functions only manipulate CPU registers and read/write memory. Because Mini-QEMU already decodes ALU, memory, and branch instructions, these functions execute natively inside the virtual CPU with zero operating system intervention.

#### 3. Formatted I/O: `printf("Value: %d\n", 42)` and Scatter-Gather `sys_writev`
* Converting the binary integer `42` into the characters `'4'` and `'2'`, parsing `%d`, padding spaces, and assembling the output buffer is done **entirely in ARM64 user-space by `printf`**.
* Only after the string buffer is formatted does `libc` flush its internal `FILE*` stream to the kernel.
* **Real-World Libc Detail (`sys_write` vs. `sys_writev`):** While simple programs call `sys_write` (syscall 64), real C standard libraries (`musl` and `glibc`) use **scatter-gather I/O** (`sys_writev`, syscall 66) to flush buffered `stdout` alongside the newly formatted string in a single kernel trap without copying them into a temporary buffer first:
  ```c
  struct iovec {
      void  *iov_base; // Pointer to buffer (8 bytes on ARM64)
      size_t iov_len;  // Length of buffer  (8 bytes on ARM64)
  };
  ```
  Mini-QEMU implements both `sys_write` (64) and `sys_writev` (66), iterating through the `struct iovec` array in guest RAM and streaming each chunk to `stdout`.

---

## 3. Why Level 2 (HLE) Differs from Level 1 (Static Libc)

In **Level 2 (High-Level Emulation / HLE)**, such as used by **Wine** (running Windows binaries on Linux) or **Box64** (running x86-64 binaries on ARM64):
* The guest binary **does not** include the C library implementation in its machine code.
* Instead, the binary contains an import table (`.plt` / Procedure Linkage Table).
* When the guest calls `malloc(size)`, the emulator catches the jump to the `malloc` symbol, halts CPU interpretation, calls the **host's native** `malloc()`, writes the resulting pointer into `X0`, and simulates a `RET`.
* **Tradeoff:** In Level 2, you *do* have to write a custom host wrapper for every single API function you want to support. In Level 1, the guest binary brings its own C library, so ~10 system calls cover hundreds of library functions.

---

## 4. The 3 Gaps: What Stands Between an Emulator and "Any Static Binary"?

If you compile a real program with `aarch64-linux-gnu-gcc -static main.c -o main.elf`, the standard C library runtime executes **thousands of startup instructions** (`_start` $\to$ `__libc_start_main`) before `main()` is ever called.

Before Mini-QEMU could run compiler-generated static binaries, **three specific gaps** had to be resolved:

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│              What Happens Before main() in a Real Static Binary                 │
│                                                                                 │
│   1. Linux Kernel ABI: Kernel sets up stack [argc, argv, envp, auxv]            │
│      ==> Gap 1: Stack Initialization (SP currently points to empty RAM)         │
│                                                                                 │
│   2. Libc Startup (_start -> __libc_start_main):                                │
│      • Computes global variable addresses via ADRP                              │
│      • Sets conditional variables via CSEL / CSET                               │
│      ==> Gap 2: Core Compiler Primitives (ADRP, CSEL, CSINC, CSET)               │
│                                                                                 │
│   3. Standard Library Optimizations (memcpy, memset):                           │
│      • Modern glibc uses 128-bit vector registers (Q0-Q31) to copy memory fast  │
│      ==> Gap 3: SIMD / Floating-Point Registers (NEON)                          │
│                                                                                 │
│   4. main() is finally reached!                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

### Gap 1: The Linux Initial Process Stack ABI (`argc`, `argv`, `auxv`) & `.bss` Zeroing

#### The Problem
1. **Empty Stack at `_start`:** In an educational emulator, the Stack Pointer (`SP`) is typically initialized to point to an empty block of memory (e.g. `0x00700000`). However, according to the official **System V Application Binary Interface (AArch64)**, when the Linux kernel transfers control to a program's `_start` entry point, the stack **must contain** the process argument vector, environment vector, and **Kernel Auxiliary Vector (`auxv`)**:

```
Low Address                                                         High Address
[ SP ] ──> [ argc ] [ argv[0] ] [ NULL ] [ envp[0] ] [ auxv... ] ──> [ String & Canary Data ]
```

If `argc` or `auxv` is missing:
* `libc` reads garbage for `argc` or dereferences a null pointer in `argv[0]`.
* `glibc`/`musl` reads `AT_RANDOM` (type 25) to initialize the **stack protector canary** (`__stack_chk_guard`) and `AT_PHDR`/`AT_PHNUM` (types 3–5) to locate Thread-Local Storage (`PT_TLS`) and exception tables. A missing `AT_RANDOM` pointer causes an immediate null-pointer crash during `__libc_start_main`.
2. **Uninitialized Globals (`.bss`):** In ELF64 files, zero-initialized C globals (`static int buffer[1024];`) occupy space in virtual memory (`p_memsz`) without taking up disk space in the ELF binary (`p_filesz`). The ELF loader must explicitly zero-fill `[p_vaddr + p_filesz, p_vaddr + p_memsz)` so C globals and `libc` internal locks start at `0`.

#### The Mini-QEMU Implementation
In [src/elf_loader.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/elf_loader.js), `ElfLoader.load()` zero-initializes `.bss` whenever `p_memsz > p_filesz` and records the ELF program header metadata (`memory.elfHeader`).

In [src/emulator.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/emulator.js), `setupLinuxStack(entryPoint, programName)` constructs the complete 16-byte aligned Linux ABI frame:

```javascript
setupLinuxStack(entryPoint, programName = "program") {
  const stackTop = 0x00700000;
  // 1. Write 16-byte random seed for AT_RANDOM (stack canary initialization)
  const randomAddr = stackTop - 32;
  this.memory.write64(randomAddr, 0x9e3779b97f4a7c15n);
  this.memory.write64(randomAddr + 8, 0xbf58476d1ce4e5b9n);

  // 2. Write program name string for argv[0]
  const progNameBytes = new TextEncoder().encode(programName + "\0");
  const stringAddr = stackTop - 128;
  for (let i = 0; i < progNameBytes.length; i++) {
    this.memory.write8(stringAddr + i, progNameBytes[i]);
  }

  // 3. 16-byte aligned stack frame with full auxiliary vector (auxv)
  const elfHdr = this.memory.elfHeader || { phdrVaddr: 0x00400040, phentsize: 56, phnum: 1 };
  const spAddr = stringAddr - 144;
  const words = [
    1n,                          // argc = 1
    BigInt(stringAddr),          // argv[0] -> pointer to programName string
    0n,                          // argv[1] = NULL
    0n,                          // envp[0] = NULL
    3n, BigInt(elfHdr.phdrVaddr),// auxv: AT_PHDR (3)
    4n, BigInt(elfHdr.phentsize),// auxv: AT_PHENT (4)
    5n, BigInt(elfHdr.phnum),    // auxv: AT_PHNUM (5)
    6n, 4096n,                   // auxv: AT_PAGESZ (6) = 4096
    9n, BigInt(entryPoint),      // auxv: AT_ENTRY (9) = entryPoint
    25n, BigInt(randomAddr),     // auxv: AT_RANDOM (25) -> 16-byte stack canary seed
    0n, 0n                       // auxv: AT_NULL (0)
  ];

  for (let i = 0; i < words.length; i++) {
    this.memory.write64(spAddr + i * 8, words[i]);
  }
  this.cpu.sp = BigInt(spAddr);
}
```

---

### Gap 2: Compiler Code Generation Primitives & LP64 32-Bit Semantics

Modern compilers (GCC and Clang) targeting the **ARM64 LP64 ABI** (`int` is 32-bit `W0`–`W30`, `long`/pointers are 64-bit `X0`–`X30`) emit optimized instruction idioms everywhere:

#### 1. `ADRP` (Address Page) & `MOVK` (Move Wide with Keep)
* **`ADRP`:** Forms a PC-relative 4 KB page address (`(PC & ~0xfff) + (imm21 << 12)`). Compilers pair `ADRP` with `ADD` or `LDR` to address globals and string literals across $\pm 4\text{ GB}$ in Position-Independent Code (PIC):
  ```armasm
  adrp x0, #0x400000           // X0 = 4KB base page of data section
  add  x0, x0, :lo12:my_string // X0 = exact pointer to string
  ```
* **`MOVK`:** Inserts a 16-bit immediate into bits `[15:0]`, `[31:16]`, `[47:32]`, or `[63:48]` of a register **without clearing the other bits**, allowing compilers to synthesize arbitrary 32-bit or 64-bit constants in 2–4 instructions (`MOVZ` followed by `MOVK`).

#### 2. `CSEL` (Conditional Select), `CSINC` / `CSET`, `CSINV`, `CSNEG`
* Selects between two registers based on `NZCV` flags without branching:
  $$\text{Xd} = \text{cond} \; ? \; \text{Xn} : \text{Xm}$$
* Branch instructions (`B.cond`) risk stalling CPU branch predictors. Compilers convert ternary expressions (`a == b ? 10 : 20`) and boolean assignments (`cset x0, eq`) into branchless conditional selects.

#### 3. `CBZ` & `CBNZ` (Compare and Branch on Zero / Non-Zero)
* Tests whether a 32-bit (`Wt`) or 64-bit (`Xt`) register is zero and branches in a **single instruction without modifying `NZCV` flags**. Almost every `if (ptr == NULL)` or `while (*str)` in compiled C code uses `CBZ`/`CBNZ`.

#### 4. Unscaled (`LDUR`/`STUR`), Pre/Post-Indexed, and Halfword (`LDRH`/`STRH`) Memory Ops
* Standard `LDR`/`STR` immediate instructions scale a 12-bit unsigned offset (`imm12 * 8`). When accessing negative offsets from a frame pointer (e.g., `stur x0, [x29, #-8]`) or unaligned byte offsets on the heap (`stur x2, [x0, #-8]`), compilers emit **unscaled 9-bit signed offset instructions (`LDUR`/`STUR`)** where bit 24 is `0` and bits `[11:10]` are `00`.
* Mini-QEMU's [src/decoder.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/decoder.js) distinguishes scaled unsigned offsets (`bit 24 == 1`) from unscaled (`00`), post-indexed (`01`), and pre-indexed (`11`) single-register loads and stores across 64-bit, 32-bit, 16-bit (`LDRH`/`STRH`), and 8-bit (`LDRB`/`STRB`) widths.

#### 5. 32-bit `W` Register Operations (`sf = 0`) & Bitfield Moves (`UBFM` / `SBFM`)
* Under the ARM64 architecture, writing to a 32-bit register (`W0`–`W30`, encoded with `sf = 0` in bit 31) **automatically zero-extends the upper 32 bits** of the 64-bit `X` register (`Xd = result & 0xffffffff`), and flag-setting instructions (`SUBS`/`CMP w0, w1`) compute `N` (Sign), `C` (Carry), and `V` (Overflow) from **bit 31** rather than bit 63.
* **Immediate Shifts & Sign/Zero Extensions (`UBFM` / `SBFM`):** In ARM64, immediate shifts (`LSL #imm`, `LSR #imm`, `ASR #imm`) and integer promotions (`UXTB`, `UXTH`, `SXTB`, `SXTH`, `SXTW`) are all aliases of two hardware instructions: **Unsigned Bitfield Move (`UBFM`)** and **Signed Bitfield Move (`SBFM`)**. For example, whenever C code indexes a 64-bit array with a signed 32-bit `int i`, the compiler emits `sxtw x0, w1` (`sbfm x0, x1, #0, #31`).

#### 6. 2D Array Indexing (`MADD`/`MSUB`), Register-Offset Loads/Stores, Sign-Extending Loads & `TBZ`/`TBNZ`
* **`MADD` / `MSUB`:** Compilers compile 2D grid lookups like `grid[y * WIDTH + x]` into a single **Multiply-Add** instruction (`madd x0, x1, x2, x3`, computing `x3 + x1 * x2`).
* **Register-Offset Loads/Stores (`[Xn, Xm, lsl #3]` / `[Xn, Wm, sxtw #2]`):** Compilers load array elements `arr[i]` in a single instruction by scaling the index register `Rm` by the element size (`1`, `2`, `4`, or `8` bytes) with optional `uxtw`/`sxtw` extension.
* **Sign-Extending Loads (`LDRSW`, `LDRSH`, `LDRSB`):** Loads a 32-bit, 16-bit, or 8-bit signed integer from memory and hardware sign-extends it to 32 or 64 bits.
* **`TBZ` / `TBNZ` (Test Bit and Branch):** Tests any single bit (`0`–`63`) in a register and branches without modifying `NZCV` flags (used for bitwise flag checks `if (flags & 8)` and sign checks `if (val < 0)`).

#### 7. Thread-Local Storage (`TPIDR_EL0` via `MRS` / `MSR`)
* Even in single-threaded static C programs, `musl` and `glibc` store per-thread globals—such as **`errno`**, the **`__stack_chk_guard` stack canary**, and `stdio` locks—in Thread-Local Storage (TLS) pointed to by the hardware system register **`TPIDR_EL0`**.
* During `__libc_start_main`, `libc` initializes TLS via `msr tpidr_el0, x0` and reads it via `mrs x0, tpidr_el0`. Mini-QEMU implements `tpidr_el0` on [`CPU`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/cpu.js) and decodes `MRS`/`MSR` in [`Decoder`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/decoder.js).

---

### Gap 3: SIMD / NEON Vector Registers (Future Phase)

* Modern `glibc` implementations optimize `memcpy()`, `memset()`, and string operations by moving 16 or 32 bytes at a time using **ARM NEON vector registers** (`Q0`–`Q31` or `V0`–`V31`).
* If an emulator only implements integer registers (`X0`–`X30`), an unhandled opcode exception will occur when a vector instruction is encountered.
* **How to bypass this today:**
  * Compile with `-mgeneral-regs-only` (tells GCC/Clang never to emit vector instructions).
  * Use lightweight C libraries like **musl libc** or the Linux kernel's single-header **`nolibc.h`**, which use standard 64-bit integer registers for all memory operations.

---

## 5. Summary of Mini-QEMU Static Linking Capabilities

With Level 1 Syscalls, the Linux ABI Stack, `.bss` zero-filling, and Compiler Primitives implemented, Mini-QEMU supports:

| Subsystem | Implemented Features |
| :--- | :--- |
| **Linux Syscalls** | `sys_getcwd` (17), `sys_fcntl` (25), `sys_ioctl` (29), `sys_unlinkat` (35), `sys_openat` (56), `sys_close` (57), `sys_lseek` (62), `sys_read` (63), `sys_write` (64), `sys_writev` (66, scatter-gather `iovec`), `sys_newfstatat` (79), `sys_fstat` (80), `sys_exit` (93), `sys_exit_group` (94), `sys_set_tid_address` (96), `sys_clock_gettime` (113), `sys_uname` (160), `sys_getpid` (172), `sys_gettid` (178), `sys_brk` (214), `sys_munmap` (215), `sys_mmap` (222), `sys_mprotect` (226), `sys_getrandom` (278) |
| **Virtual File System**| In-memory VFS (`mountFile`, `readVfsFile`) & Linux File Descriptor table (`fd >= 3`) supporting `O_RDONLY`, `O_WRONLY`, `O_RDWR`, `O_CREAT`, `O_TRUNC`, `O_APPEND`, `SEEK_SET`/`CUR`/`END`, and 128-byte AArch64 `struct stat` |
| **Process ABI & TLS** | `.bss` zero-initialization (`p_memsz > p_filesz`); 16-byte aligned initial stack frame (`argc`, `argv`, `envp`, and `auxv` with `AT_PHDR`, `AT_PHENT`, `AT_PHNUM`, `AT_PAGESZ`, `AT_ENTRY`, `AT_RANDOM`); Thread Pointer register `TPIDR_EL0` (`MRS` / `MSR`) |
| **Compiler Primitives**| `ADRP` (4KB page), `MOVK`, `CSEL`/`CSINC`/`CSET`/`CSINV`/`CSNEG`, `CBZ`/`CBNZ`, `TBZ`/`TBNZ`, `MADD`/`MSUB`, `UBFM`/`SBFM` (immediate `LSL`/`LSR`/`ASR` & `UXTB`/`UXTH`/`SXTB`/`SXTH`/`SXTW`), `LDUR`/`STUR`, `LDRSW`/`LDRSH`/`LDRSB`, register-offset `[Xn, Rm, lsl/sxtw #scale]`, and 32-bit `W` (`sf = 0`) semantics |
| **Verification** | Verified with [guest/heap_demo.cpp](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/guest/heap_demo.cpp) ([bin/heap_demo.elf](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/bin/heap_demo.elf)), [tests/test_syscalls.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/tests/test_syscalls.js), and [tests/test_abi_and_compiler.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/tests/test_abi_and_compiler.js) |
