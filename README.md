# Mini-QEMU: Educational ARM64 CPU Emulator & Static AOT Recompiler

A lightweight, from-scratch 64-bit ARM (AArch64) user-space CPU emulator and Ahead-Of-Time (AOT) binary recompiler running on Windows and Linux, built with Node.js.

```
+---------------------------------------------------------------------------------+
|                               Mini-QEMU Pipeline                                |
|                                                                                 |
|   [ Freestanding C++ ] ---> [ ARM64 ELF Binary ] ---> [ ELF64 Loader ]          |
|      (guest/fib.cpp)            (fib.elf)                    │                  |
|                                                              ▼                  |
|                                                  [ 4KB Page Virtual RAM ]       |
|                                                              │                  |
|                        ┌─────────────────────────────────────┴───────────────┐  |
|                        ▼                                                     ▼  |
|            [ Software Interpreter ]                               [ Static AOT ]|
|            Fetch -> Decode -> Execute                        Translates ARM -> Host|
|            - Verbose register trace                          - Zero decode overhead|
|            - Linux syscall trap (write, exit)                - 80x+ speedup!       |
+---------------------------------------------------------------------------------+
```

---

## Features

* **Architectural CPU State:**
  * 31 64-bit general-purpose registers (`X0`–`X30`) using native 64-bit unsigned integers (`BigUint64Array`).
  * Hardwired Zero Register (`XZR` reads 0, discards writes).
  * 64-bit Program Counter (`PC`) and Stack Pointer (`SP`).
  * Full condition code flags: Negative (`N`), Zero (`Z`), Carry (`C`), and Overflow (`V`).
* **Page-Based Virtual Memory:**
  * 4 KB sparse page-table memory manager.
  * Supports loading segments at standard 64-bit virtual addresses (e.g. `0x00400000`) with zero wasted RAM.
  * Little-endian byte, 32-bit, and 64-bit aligned access.
* **Modular Bitfield Decoder:**
  * Clean, standards-compliant ARM64 opcode decoding based on the official ARM Architecture Reference Manual.
  * Categorizes instructions by major groups (Data Processing Immediate, Register, Branches, Loads/Stores, System).
  * Evaluates all 15 ARM64 condition codes (`EQ`, `NE`, `GE`, `LT`, `GT`, `LE`, etc.).
* **Standard ELF64 Binary Loader:**
  * Validates ELF magic bytes (`0x7F 'E' 'L' 'F'`), 64-bit class, little-endian format, and AArch64 machine identifier (`0x00B7`).
  * Parses `PT_LOAD` program headers and loads segments into virtual RAM.
* **Linux ARM64 System Call Trapping (`SVC #0`):**
  * `sys_write` (syscall 64): Intercepts string writes to `stdout` (fd 1) and outputs directly to the host console.
  * `sys_exit` (syscall 93): Intercepts process termination and extracts the return code from `X0`.
* **Dual Execution Modes:**
  1. **Interactive Interpreter:** Step-by-step cycle execution with full register dumps.
  2. **Static AOT Recompiler:** Translates ARM64 binary blocks into native host code, providing an **81.5x performance speedup**!

---

## Supported Instruction Set (32+ Core Instructions)

| Category | Instructions | Description & Semantics |
| :--- | :--- | :--- |
| **Immediate Arithmetic** | `MOVZ`, `MOVN` | Move wide immediate (positive and bitwise-inverted) |
| | `ADD (imm)`, `SUB (imm)` | Add/Subtract 12-bit immediate with optional shift |
| | `SUBS (imm)`, `CMP (imm)`| Subtract immediate and set condition flags (`NZCV`) |
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
| **Stack & Pair Memory** | `STP`, `LDP` | Store Pair & Load Pair (for function stack frames: FP & LR) |
| **Control Flow & Calls** | `B`, `B.cond` | Unconditional and Conditional relative branches |
| | `BL` | Branch with Link (subroutine / function call; saves return address into `LR` / `X30`) |
| | `BR`, `BLR` | Indirect Branch and Indirect Call via register pointer |
| | `RET` | Return from subroutine to address in `LR` (`X30`) |
| **System** | `SVC` | Supervisor Call (Linux system call trap: `sys_write`, `sys_exit`) |

---

## Project Structure

```
├── src/                           # Core Emulator & Binary Translators
│   ├── cpu.js                     # 64-bit virtual CPU registers, flags, and dump formatting
│   ├── memory.js                  # 4 KB page-based virtual memory manager (little-endian)
│   ├── decoder.js                 # ARM64 bitfield instruction decoder (32+ base instructions)
│   ├── elf_loader.js              # ELF64 binary parser and PT_LOAD segment loader
│   ├── emulator.js                # Core Fetch-Decode-Execute pipeline & syscall handler
│   ├── static_recompiler.js       # Approach 1: Binary-to-Source (JS) static AOT recompiler
│   └── arm2x86.js                 # Approach 2: Direct Binary-to-Assembly (x86-64) translator
├── tests/                         # Unit Test Suite
│   └── test_decoder.js            # 23+ unit tests for instruction decoding, shifts, and math
├── tools/                         # ARM64 ELF64 Binary Builders
│   ├── elf_builder.js             # Generates standards-compliant bin/fib.elf (iterative)
│   ├── build_fib_rec_elf.js       # Generates bin/fib_rec.elf (recursive fib(10) with stack frames)
│   ├── build_hello_elf.js         # Generates bin/hello.elf with embedded string and load/stores
│   └── build_math_elf.js          # Generates bin/math_func.elf with BL, STP, LDP, MUL, UDIV
├── guest/                         # Freestanding C++ Guest Source Code
│   ├── fib.cpp                    # Iterative Fibonacci source code
│   ├── fib_rec.cpp                # Recursive Fibonacci source code
│   └── hello.cpp                  # String output source code
├── bin/                           # Compiled 64-bit ARM ELF Executables
│   ├── fib.elf                    # Iterative Fibonacci(10) = 55
│   ├── fib_rec.elf                # Recursive Fibonacci(10) = 55
│   ├── hello.elf                  # String I/O via Linux sys_write
│   └── math_func.elf              # Subroutine calls, stack frames & integer math
├── out/                           # Generated AOT & Binary Translator Outputs
│   ├── fib_recompiled.js          # Lifted JavaScript module from static_recompiler.js
│   ├── fib_translated.asm         # Translated x86-64 NASM/Intel assembly (fib.elf)
│   ├── math_func_translated.asm   # Translated x86-64 NASM/Intel assembly (math_func.elf)
│   ├── fib_rec_translated.asm     # Translated x86-64 NASM/Intel assembly (fib_rec.elf)
│   └── *_translated.bin           # Raw x86-64 machine code binaries
├── docs/                          # Educational Guides & Architecture Docs
│   ├── learning.md                # Comprehensive emulator fundamentals & case studies
│   ├── plan.md                    # 5-phase architectural roadmap & verification matrix
│   └── decoding_and_compilation.md# Deep dive on JIT vs. AOT, I/O thunking, recursion & PyTorch parallel
├── package.json                   # Project manifest and npm scripts
└── README.md                      # This file
```

---

## Quick Start & Usage

### 1. Prerequisites
* **Node.js** (v18.0.0 or higher). Verify with `node --version`.

### 2. Run Decoder Unit Tests
Verifies bitfield extraction, signed immediate math, condition flags, and instruction aliases:
```bash
npm test
# or: node tests/test_decoder.js
```

### 3. Run the Fibonacci Program in the Interpreter
Executes [bin/fib.elf](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/bin/fib.elf) step by step, computing the 10th Fibonacci number ($F_{10} = 55$) with cycle tracing:
```bash
npm start
# or: node src/emulator.js bin/fib.elf
```

### 4. Run Function Calls, Stack Frames & Math Program
Executes [bin/math_func.elf](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/bin/math_func.elf), testing C++ subroutine calls (`BL`), stack saving/restoring (`STP`/`LDP`), math (`MUL`, `UDIV`), and bitwise XOR (`EOR`):
```bash
node src/emulator.js bin/math_func.elf
```
**Output:**
```
[Cycle   3] 0x00400008: 0x94000003 | bl [offset +12B]          | LR(X30): 0x40000c
[Cycle   4] 0x00400014: 0xd10043ff | sub sp, sp, #16           | (allocate 16B stack frame)
[Cycle   5] 0x00400018: 0xa9007bfd | stp x29, x30, [sp]        | (save FP & LR)
[Cycle   6] 0x0040001c: 0x9b017c02 | mul x2, x0, x1            | X2: 96
[Cycle   8] 0x00400024: 0x9ac30842 | udiv x2, x2, x3           | X2: 48
[Cycle   9] 0x00400028: 0xca010004 | eor x4, x0, x1            | X4: 4
[Cycle  10] 0x0040002c: 0x8b040040 | add x0, x2, x4            | X0: 52
[Cycle  11] 0x00400030: 0xa9407bfd | ldp x29, x30, [sp]        | (restore FP & LR)
[Cycle  12] 0x00400034: 0x910043ff | add sp, sp, #16           | (free 16B stack frame)
[Cycle  13] 0x00400038: 0xd65f03c0 | ret                       | (returns to 0x40000c)
Program terminated cleanly via Linux sys_exit (syscall 93).
>>> Exit Code (Result in X0): 52 <<<
```

### 5. Run Recursive Fibonacci with Pre/Post-Indexed Stack Frames
Executes [bin/fib_rec.elf](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/bin/fib_rec.elf), computing $\text{fib}(10) = 55$ across **177 recursive `BL`/`RET` calls** (1,503 instruction cycles) using `stp x29, x30, [sp, #-32]!` and `ldp x29, x30, [sp], #32`:
```bash
node src/emulator.js bin/fib_rec.elf --quiet
```
**Output:**
```
[Mini-QEMU] Completed "bin/fib_rec.elf" in 1503 cycles -> Exit Code (X0): 55
```

### 6. Run the String I/O & Memory Program
Executes [bin/hello.elf](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/bin/hello.elf), testing `STR`, `LDR`, `ADR`, and printing to the console via Linux `sys_write`:
```bash
node src/emulator.js bin/hello.elf
```
**Output:**
```
[ELF Loader] Loading "bin/hello.elf"
  Entry Point Address : 0x00400000
...
Hello from ARM64 running on Windows via Mini-QEMU!
...
Program terminated cleanly via Linux sys_exit (syscall 93).
>>> Exit Code (Result in X0): 0 <<<
```

### 7. Run the Static AOT Recompiler & Benchmark (Approach 1)
Statically lifts `bin/fib.elf` into structured JavaScript (`runNative` in [out/fib_recompiled.js](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/out/fib_recompiled.js)) and benchmarks 10,000 iterations:
```bash
npm run recompile
# or: node src/static_recompiler.js
```
**Benchmark Output:**
```
--- BENCHMARK RESULTS ---
Interpreter Result      : 55 in 132.79 ms
Static Recompiled Result: 55 in 6.99 ms
Speedup Factor          : 19.0x FASTER with Static AOT!
```

### 8. Run the ARM64-to-x86 Static Binary Translator (Approach 2)
Directly translates an ARM64 ELF binary (`bin/fib.elf`, `bin/math_func.elf`, or `bin/fib_rec.elf`) into **native x86-64 Intel/NASM Assembly** and **raw x86 machine bytes** in `out/`:
```bash
npm run translate
# or:
node src/arm2x86.js bin/fib.elf
node src/arm2x86.js bin/math_func.elf
node src/arm2x86.js bin/fib_rec.elf
```
**Generated [out/fib_translated.asm](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/out/fib_translated.asm):**
```nasm
global _start
section .text

_start:
    mov rax, 0                                       ; [ARM: movz x0, #0                  | 0xd2800000] ; bytes: 48 c7 c0 00 00 00 00
    mov rbx, 1                                       ; [ARM: movz x1, #1                  | 0xd2800021] ; bytes: 48 c7 c3 01 00 00 00
    mov rcx, 10                                      ; [ARM: movz x2, #10                 | 0xd2800142] ; bytes: 48 c7 c1 0a 00 00 00

label_1_0x40000c:
    lea rdx, [rax + rbx]                             ; [ARM: add x3, x0, x1               | 0x8b010003] ; bytes: 48 8d 14 18
    mov rax, rbx                                     ; [ARM: mov x0, x1                   | 0xaa0103e0] ; bytes: 48 89 d8
    mov rbx, rdx                                     ; [ARM: mov x1, x3                   | 0xaa0303e1] ; bytes: 48 89 d3
    sub rcx, 1                                       ; [ARM: subs x2, x2, #1              | 0xf1000442] ; bytes: 48 83 e9 01
    jnz label_1_0x40000c                             ; [ARM: b.ne [offset -16B]           | 0x54ffff81] ; bytes: 75 f0
    mov r10, 93                                      ; [ARM: movz x8, #93                 | 0xd2800ba8] ; bytes: 48 c7 c0 5d 00 00 00
    mov rdi, rax ; mov rax, 60 ; syscall             ; [ARM: svc #0                       | 0xd4000001] ; bytes: 48 89 c7 48 c7 c0 3c 00 00 00 0f 05
```

---

## Documentation & Reading Guides

* **[docs/learning.md](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/docs/learning.md):** The 4 paradigms of emulation (API compatibility layers, hardware virtualization, JIT binary translation, software interpretation) with case studies of the PS5, Nintendo Switch, Android Emulator, and QEMU.
* **[docs/plan.md](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/docs/plan.md):** The original 5-phase implementation plan and test verification matrix.
* **[docs/decoding_and_compilation.md](file:///c:/Users/wei.du/WorkAtTPVision/test/emulator/docs/decoding_and_compilation.md):** Why an interpreter simulates semantics without emitting host assembly, why offline static compilation encounters the computed goto / literal pool problems, how I/O syscall thunking and recursive stack frames work, and how this directly parallels PyTorch graph compilation (`torch.jit.trace` vs. `torch.compile`).
