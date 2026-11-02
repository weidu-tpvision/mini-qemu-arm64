# Emulator Fundamentals & Architecture Guide

A comprehensive summary and guide based on foundational concepts, industry implementations (PS5, Nintendo Switch, Android, QEMU), and the architectural roadmap for building an ARM64 user-space CPU emulator from scratch.

---

## 1. Core Concepts: Running Foreign Code

At the lowest level, all CPUs execute a continuous state-machine loop:
$$\text{Fetch} \longrightarrow \text{Decode} \longrightarrow \text{Execute}$$

Depending on how different the guest platform (the software being run) is from the host platform (the physical machine running it), the industry uses four distinct approaches:

| Technique | Example | How It Works | Performance |
| :--- | :--- | :--- | :--- |
| **API Compatibility Layer** | Wine, Proton, PS5 emulators (*shadPS4*, *Kyty*) | **Same CPU architecture ($x86 \to x86$).** CPU instructions run natively on the host processor without translation. The layer intercepts Operating System system calls and translates proprietary graphics/audio APIs (e.g., PS5 GNM/AGC $\to$ Vulkan/DirectX). | Near Native (~98–100%) |
| **Hardware Virtualization** | Modern Android Studio x86 AVD, WSL2, KVM, VMware | **Same CPU architecture ($x86 \to x86$).** Relies on hardware CPU extensions (Intel VT-x / AMD-V) via a hypervisor (KVM on Linux, WHPX/Hyper-V on Windows) to execute guest code directly on physical cores. | Near Native (~95–99%) |
| **Dynamic Binary Translation (JIT)** | Nintendo Switch (*Ryujinx*, *Yuzu*), Apple Rosetta 2 | **Different CPU architectures (ARM64 $\to$ x86-64).** Analyzes blocks of foreign machine code at runtime, translates them into equivalent native host machine code, caches them in memory, and jumps to them. | Very Fast (~70–90%) |
| **Software Interpretation** | CHIP-8, QEMU TCG (default), early Android emulators | **Different CPU architectures.** Uses a software `while` loop with `switch` statements to decode and simulate every single instruction one-by-one. | Slower, but simpler to build and debug |

---

## 2. Real-World Case Studies

### 2.1. The PS5 Emulator Mystery (Why is it not a CPU emulator?)
* **Hardware:** The PlayStation 5 uses an **AMD Zen 2 (x86-64)** CPU and an **AMD RDNA 2** GPU.
* **Operating System:** Prospero OS (derived from FreeBSD).
* **Implication:** Because modern PCs already use x86-64 processors, a PS5 emulator running on a PC **does not need to emulate the CPU instruction set**. It is essentially an advanced **compatibility layer** (similar to Wine for Windows on Linux) translating FreeBSD kernel calls and PlayStation graphics calls to Windows/Vulkan.

### 2.2. The Nintendo Switch Emulator
* **Hardware:** Nvidia Tegra X1 containing an **ARM64 (Cortex-A57)** CPU.
* **Implication:** Because an x86 PC cannot understand ARM64 machine code, Switch emulators (Ryujinx, Yuzu) must use **Dynamic Binary Translation (JIT)** to convert ARM64 machine instructions into x86-64 instructions on the fly.

### 2.3. The Android Studio Emulator
Modern Android emulation is a hybrid system built on **QEMU**:
1. **The Old Days (2008–2014):** Android system images were ARM-only. Running them on an x86 PC required full software CPU instruction translation via QEMU's Tiny Code Generator (TCG). This made booting and running apps extremely slow (5–10 minutes to boot).
2. **Modern Setup (Hardware Virtualization):** Google compiles Android x86_64 system images. On Windows (via WHPX/Hyper-V) and Ubuntu (via KVM), Android runs inside a hardware hypervisor at native speed.
3. **The Hybrid Solution (`libndk_translation` / Houdini):** If an Android app contains pre-compiled native ARM C/C++ libraries (`.so` files), the x86 Android OS dynamically translates only those ARM instructions while running the rest of the OS and Java/Kotlin code natively via the hypervisor.

---

## 3. QEMU: The Industry Standard

* **Open Source:** Licensed under **GPLv2**, created in 2003 by **Fabrice Bellard** (creator of FFmpeg, TinyCC, QuickJS).
* **Two Operating Modes:**
  1. **Full System Emulation (`qemu-system-aarch64`):**
     * Emulates the complete machine: motherboard, CPU, MMU, RAM, timers, disks, and display.
     * Can boot complete guest operating systems (Linux ARM, Windows 11 ARM) on either Windows or Linux hosts.
  2. **User-Space Emulation (`qemu-aarch64`):**
     * Emulates **only the CPU and application process**.
     * Does not boot an OS; executes a single compiled ARM ELF binary.
     * Intercepts Linux system calls (`svc #0`) and forwards them to the host OS.

---

## 4. Why Build an Emulator from Scratch?

Building an emulator is where **Computer Architecture** and **Compilers** meet:

### System Architecture Insights:
* **The Heartbeat of a CPU:** Implementing the Fetch-Decode-Execute pipeline.
* **Registers & State:** Understanding general-purpose registers (`X0`–`X30`), the Program Counter (`PC`), Stack Pointer (`SP`), and condition flags (`NZCV`: Negative, Zero, Carry, Overflow).
* **Memory & ABI:** How the call stack grows, how function arguments and return values are passed according to calling conventions, and how return addresses are managed via the Link Register (`LR` / `X30`).
* **Bitwise Instruction Decoding:** Understanding how a 32-bit instruction is encoded and extracting opcodes, registers, and immediate values via bit masks and shifts.

### Compiler & Systems Insights:
* **What Compilers Actually Emit:** Seeing how high-level C++ loops and conditions translate to assembly jumps (`B.NE`, `CMP`, `SUBS`).
* **Binary Formats (ELF / Mach-O / PE):** Understanding headers, entry points, and memory section mappings (`.text` for code, `.rodata` for constants, `.data`/`.bss` for memory).
* **System Calls:** How applications cross the user-mode $\to$ kernel-mode boundary (`SVC` on ARM vs. `SYSCALL` on x86).
* **JIT / Dynamic Binary Translation:** Learning how dynamic compilers emit executable machine code directly into RAM (`VirtualAlloc` with `PAGE_EXECUTE_READWRITE`).

---

## 5. Our Project Roadmap: Building a "Mini-QEMU" ARM64 Emulator

We are building a user-space CPU emulator targeting **AArch64 (ARM64)** that runs a non-trivial guest program (computing the Fibonacci sequence).

### 5.1. The Guest Program: Fibonacci in C++
To run without requiring the entire C++ standard library runtime (glibc/libstdc++), we write **freestanding (bare-metal) C++**:

```cpp
// fib.cpp
extern "C" void _start() {
    int a = 0;
    int b = 1;
    int n = 10;
    while (n > 0) {
        int next = a + b;
        a = b;
        b = next;
        n--;
    }
    // Result (55) is in register X0.
    // Exit syscall to terminate and return the value:
    asm volatile(
        "mov x0, %0\n"
        "mov x8, #93\n"  // Linux sys_exit syscall number
        "svc #0\n"
        : : "r"((long)a) : "x0", "x8"
    );
}
```

### 5.2. Corresponding ARM64 Assembly
```armasm
    movz x0, #0         // a = 0
    movz x1, #1         // b = 1
    movz x2, #10        // n = 10 (loop counter)

loop:
    add  x3, x0, x1     // next = a + b
    orr  x0, xzr, x1    // a = b (move x1 into x0)
    orr  x1, xzr, x3    // b = next (move x3 into x1)
    subs x2, x2, #1     // n = n - 1 (updates Zero and Negative flags)
    b.ne loop           // if (n != 0) jump back to loop

    movz x8, #93        // Linux syscall: exit
    svc  #0             // Supervisor Call (trap to emulator)
```

### 5.3. The 32+ Base Integer Instruction Set

| Category | Instructions | Purpose & Semantics |
| :--- | :--- | :--- |
| **Immediate Arithmetic** | `MOVZ`, `MOVN` | Move wide immediate (positive and bitwise-inverted) |
| | `ADD (imm)`, `SUB (imm)` | Add/Subtract 12-bit immediate with optional shift |
| | `SUBS (imm)`, `CMP (imm)`| Subtract immediate and update condition flags (`NZCV`) |
| **Register Arithmetic** | `ADD (reg)`, `SUB (reg)` | 64-bit register addition and subtraction |
| | `SUBS (reg)`, `CMP (reg)`| Register subtraction setting flags (`NZCV`) |
| **Math (Mul & Div)** | `MUL` | 64-bit integer multiplication (`MADD Xd, Xn, Xm, XZR`) |
| | `SDIV`, `UDIV` | Signed and Unsigned 64-bit integer division |
| **Bitwise Logic** | `AND`, `ORR`, `EOR`, `MVN` | Bitwise AND, OR, XOR, and Bitwise NOT |
| **Bit Shifts** | `LSL`, `LSR`, `ASR` | Logical Left, Logical Right, Arithmetic (signed) Right shifts |
| **Single Memory Access** | `LDR`, `STR` | 64-bit register Load and Store |
| | `LDRW`, `STRW` | 32-bit word Load and Store |
| | `LDRB`, `STRB` | 8-bit byte Load and Store (for strings and chars) |
| | `ADR` | Form PC-relative address (for string/data pointers) |
| **Stack & Pair Memory** | `STP`, `LDP` | Store Pair & Load Pair with signed offset (`[sp, #16]`), pre-index (`[sp, #-32]!`), and post-index (`[sp], #32`) |
| **Control Flow & Calls** | `B`, `B.cond` | Unconditional and Conditional relative branches |
| | `BL` | Branch with Link (function call; saves return address into `LR` / `X30`) |
| | `BR`, `BLR` | Indirect Branch and Indirect Call via register pointer |
| | `RET` | Return from subroutine to address in `LR` (`X30`) |
| **System** | `SVC` | Supervisor Call (Linux system call trap: `sys_write`, `sys_exit`) |

---

## 6. Two Paradigms of Static Recompilation (AOT)

During this project, we implemented both major paradigms of Ahead-Of-Time static compilation:

### Approach 1: Binary-to-Source Lifting (`static_recompiler.js`)
* **How it works:** Reads the ARM instructions from an ELF binary, detects backward-branch loops (`b.ne` with negative offset), and lifts them into structured JavaScript (`do { ... } while (!flagZ);`) inside [`fib_recompiled.js`](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/fib_recompiled.js).
* **The Benefit:** You let an existing optimizing compiler (Clang, GCC, or Node.js V8) handle register allocation, loop unrolling, and dead code elimination.
* **Result:** **~20x–80x speedup** over software interpretation!
* **Industry Examples:** `N64Recomp` (statically decompiles N64 games into PC source code), *Sonic CD* decompilation.

### Approach 2: Direct Binary-to-Assembly / Binary-to-Binary (`arm2x86.js`)
* **How it works:** Disassembles the full `.text` segment of an ARM64 ELF binary and maps each ARM64 instruction and register into its **native x86-64 assembly instruction** and **raw x86 machine bytes** (using a two-pass assembler to patch exact relative jump/call byte displacements).
* **The Benefit:** No high-level language intermediary; operates at the pure machine ISA level.
* **Key Translations:**
  * Register mapping: ARM $X_0 \to \text{RAX}$, $X_1 \to \text{RBX}$, $X_2 \to \text{RCX}$, $X_3 \to \text{RDX}$, $X_{29} (\text{FP}) \to \text{RBP}$, $X_{30} (\text{LR}) \to \text{R11}$, $\text{SP} \to \text{RSP}$.
  * Instruction mapping:
    * `add x3, x0, x1` $\to$ `lea rdx, [rax + rbx]` (`48 8d 14 18` — single-cycle non-destructive addition in x86).
    * `b.ne` $\to$ `jnz` (`75 f0`).
    * `bl` (function call) $\to$ `call` (`e8 ...`).
    * `ret` $\to$ `ret` (`c3`).
    * `svc #0` $\to$ `syscall` (`0f 05` on Linux) / `call ExitProcess` (Windows).
* **Industry Examples:** Apple Rosetta 2 AOT cache, DEC FX!32.

---

## 7. Case Study: Recursive Fibonacci (`fib_rec.elf`)

To see how leaf base cases and non-leaf recursive stack frames work together, [`guest/fib_rec.cpp`](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/guest/fib_rec.cpp) (built via [`tools/build_fib_rec_elf.js`](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/tools/build_fib_rec_elf.js)) computes $\text{fib}(10) = 55$ recursively:
* **Base case ($n \le 1$):** Executes `cmp x0, #1`, `b.gt`, and `ret` directly without allocating a stack frame (a **leaf return**).
* **Recursive case ($n > 1$):**
  1. Executes `stp x29, x30, [sp, #-32]!` (**pre-indexed writeback**) to decrement `SP` by 32 bytes and save `FP` (`X29`) and `LR` (`X30`).
  2. Spills `n` (`[sp, #16]`) and the result of `fib(n - 1)` (`[sp, #24]`) onto its private stack frame across the two recursive `bl fib` calls.
  3. Executes `ldp x29, x30, [sp], #32` (**post-indexed writeback**) to restore `FP` and `LR` and pop the 32-byte frame before `ret`.
* Across 177 recursive calls (1,503 instruction cycles), `SP` grows downward by up to $10 \times 32 = 320\text{ bytes}$ and unwinds back to `0x00700000`, exiting cleanly with `X0 = 55`.
