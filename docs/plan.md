# Project Blueprint: Mini-QEMU (ARM64 User-Space Emulator)

A complete architectural and implementation specification for building a lightweight user-space ARM64 (AArch64) CPU emulator running on Windows.

---

## 1. Project Objective & Scope

The goal of this project is to build an educational user-space CPU emulator ("Mini-QEMU") that:
1. Emulates the **64-bit ARM architecture (AArch64)** execution cycle.
2. Decodes real 32-bit ARM64 machine instructions into CPU state mutations.
3. Loads and executes a compiled freestanding C++ program (such as an iterative Fibonacci algorithm and string printing).
4. Emulates Linux ARM64 system calls (`SVC #0`) to allow the guest program to exit and output data to the host terminal.

```
+-------------------------------------------------------+
|                   Guest Space                         |
|   C++ Program (fib.cpp) ---> ARM64 ELF Executable     |
+-------------------------------------------------------+
                           │
                 [ELF Binary Loader]
                           │
                           ▼
+-------------------------------------------------------+
|             Mini-QEMU Virtual Machine                 |
|  ┌─────────────────────┐    ┌──────────────────────┐  |
|  |     CPU State       |    |    Virtual Memory    |  |
|  | - X0 - X30 (64-bit) |    | - RAM (64 KB / 1 MB) |  |
|  | - PC, SP            |    | - Stack Area         |  |
|  | - Flags (NZCV)      |    | - Text (.text) Area  |  |
|  └──────────┬──────────┘    └──────────▲───────────┘  |
|             │                          │              |
|             ▼                          │              |
|  ┌─────────────────────────────────────┴───────────┐  |
|  |             Execution Engine                    |  |
|  |  1. Fetch: Read 32-bit opcode at PC             |  |
|  |  2. Decode: Bitmask & extract fields            |  |
|  |  3. Execute: Perform arithmetic/jumps           |  |
|  |  4. Syscall: Trap SVC #0 -> Host OS action      |  |
|  └─────────────────────────────────────────────────┘  |
+-------------------------------------------------------+
                           │
                           ▼
+-------------------------------------------------------+
|                    Host Space                         |
|    Windows Terminal Output (Result: 55)               |
+-------------------------------------------------------+
```

---

## 2. Architecture Specifications

### 2.1. Virtual CPU State
The processor state consists of:
* **General-Purpose Registers:** `X0` through `X30` (each a 64-bit unsigned integer `uint64_t`).
  * `X0`–`X7`: Function arguments and return values.
  * `X8`: Linux syscall number register.
  * `X29`: Frame Pointer (`FP`).
  * `X30`: Link Register (`LR` / return address).
* **Zero Register (`XZR`):** Reads as `0`; writes are discarded.
* **Stack Pointer (`SP`):** 64-bit pointer pointing to the current stack top.
* **Program Counter (`PC`):** 64-bit address of the currently executing instruction.
* **Processor State / Condition Flags (PSTATE / NZCV):**
  * **N (Negative):** Bit 31 of condition flags (set if result is negative).
  * **Z (Zero):** Bit 30 (set if result is zero).
  * **C (Carry):** Bit 29 (set if an unsigned operation caused a carry/no borrow).
  * **V (oVerflow):** Bit 28 (set if a signed operation resulted in overflow).

### 2.2. Virtual Memory
* **Size:** 64 KB (expandable to 1 MB+).
* **Endianness:** Little-endian (ARM64 standard).
* **Primitives required:**
  * `read32(addr)`: Reads 4 bytes (instruction fetch).
  * `read64(addr)` / `write64(addr, val)`: Reads/writes 8 bytes (data load/store).
  * `read8(addr)` / `write8(addr, val)`: For byte-level I/O.

### 2.3. The 32+ Base Integer Instruction Set

| Category | Instructions | Description |
| :--- | :--- | :--- |
| **Immediate Math** | `MOVZ`, `MOVN` | Move wide immediate (positive and bitwise inverted) |
| | `ADD (imm)`, `SUB (imm)` | Add/Subtract 12-bit immediate |
| | `SUBS (imm)`, `CMP (imm)`| Subtract immediate and set flags (`NZCV`) |
| **Register Math** | `ADD (reg)`, `SUB (reg)` | 64-bit register addition and subtraction |
| | `SUBS (reg)`, `CMP (reg)`| 64-bit register comparison setting flags |
| **Math (Mul & Div)** | `MUL` | 64-bit integer multiplication (`MADD Xd, Xn, Xm, XZR`) |
| | `SDIV`, `UDIV` | Signed and Unsigned 64-bit integer division |
| **Bitwise Logic** | `AND`, `ORR`, `EOR`, `MVN` | Bitwise AND, OR, XOR, and Bitwise NOT |
| **Bit Shifts** | `LSL`, `LSR`, `ASR` | Logical Left, Logical Right, Arithmetic (signed) Right shifts |
| **Single Memory Access** | `LDR`, `STR` | 64-bit register Load and Store |
| | `LDRW`, `STRW` | 32-bit word Load and Store |
| | `LDRB`, `STRB` | 8-bit byte Load and Store |
| | `ADR` | Form PC-relative address (for string/data pointers) |
| **Stack & Pair Memory** | `STP`, `LDP` | Store Pair & Load Pair (for function stack frames: FP & LR) |
| **Control Flow & Calls** | `B`, `B.cond` | Unconditional and Conditional relative branches |
| | `BL` | Branch with Link (subroutine / function call) |
| | `BR`, `BLR` | Indirect Branch and Indirect Call via register pointer |
| | `RET` | Return from subroutine to address in `LR` (`X30`) |
| **System** | `SVC` | Supervisor Call (Linux system call trap: `sys_write`, `sys_exit`) |

---

## 3. Phased Implementation Roadmap

### Phase 1: Virtual CPU Core & Hardcoded Loop Execution
* **Goal:** Run the Fibonacci program directly from an in-memory machine code byte array and produce the correct output ($X_0 = 55$).
* **Deliverables:**
  1. `Cpu` and `Memory` data structures.
  2. The Fetch-Decode-Execute dispatch loop.
  3. Implementation of the 6 core instructions (`MOVZ`, `ADD`, `ORR`, `SUBS`, `B.NE`, `SVC`).
  4. Verbose execution logger showing step-by-step register states (`PC`, `X0`..`X3`, Flags).
  5. Interception of `SVC #0` (with `X8 = 93` for `sys_exit`), extracting $X_0$ as the exit code.

### Phase 2: Systematic Bit-Field Decoding Engine
* **Goal:** Transition from hardcoded pattern checks to clean, standards-compliant bitmask extraction.
* **ARM64 Encoding Layouts to implement:**
  * **Immediate Move (`MOVZ`):**
    * Bits 31: `sf` (1 for 64-bit)
    * Bits 30-29: `opc` (`10` for MOVZ)
    * Bits 22-21: `hw` (shift amount: 0, 16, 32, 48)
    * Bits 20-5: `imm16` (16-bit immediate value)
    * Bits 4-0: `Rd` (destination register index)
  * **Add/Sub Register (`ADD`):**
    * Bits 31: `sf` (1)
    * Bits 28-24: `01011` (Data processing - register)
    * Bits 20-16: `Rm` (second source register)
    * Bits 9-5: `Rn` (first source register)
    * Bits 4-0: `Rd` (destination register)
  * **Conditional Branch (`B.cond`):**
    * Bits 31-24: `01010100` (Branch conditional)
    * Bits 23-5: `imm19` (Signed offset relative to PC)
    * Bits 3-0: `cond` (`0001` for Not Equal `NE`)

### Phase 3: The Freestanding Guest C++ Program
* **Goal:** Write the C++ program, inspect its generated assembly, and produce the machine code binary.
* **Deliverables:**
  1. `guest/fib.cpp`: Freestanding C++ code with bare-metal `_start()` and inline assembly for the exit syscall.
  2. Compilation pipeline:
     * Using `clang++ --target=aarch64-linux-gnu -nostdlib -O2 fib.cpp -o fib.elf` (or an equivalent cross-compiler / Godbolt generation).
  3. Extraction of `.text` section bytes or verification of disassembly using `objdump`.

### Phase 4: Minimal ELF64 Binary Loader
* **Goal:** Enable the emulator to read a real `.elf` file directly from disk rather than hardcoded bytes.
* **Deliverables:**
  1. ELF64 Header Parser:
     * Validate magic bytes (`0x7F 'E' 'L' 'F'`).
     * Verify architecture (`e_machine == 0xB7` for AArch64).
     * Extract Entry Point Address (`e_entry`).
     * Extract Program Header Table offset (`e_phoff`) and count (`e_phnum`).
  2. Program Header Parser:
     * Identify `PT_LOAD` segments.
     * Read segment file offset (`p_offset`), virtual memory address (`p_vaddr`), and segment size (`p_filesz`, `p_memsz`).
     * Copy segment bytes into virtual RAM at `p_vaddr`.
  3. Set `CPU.pc = e_entry` and begin execution.

### Phase 5: I/O & String Output (`sys_write`)
* **Goal:** Enable the guest program to print "Hello from ARM64!" or formatted text to the Windows console.
* **Deliverables:**
  1. Memory load/store support: `LDR` and `STR` instructions.
  2. Implement Linux syscall 64 (`sys_write`):
     * $X_0$: File descriptor (1 for `stdout`).
     * $X_1$: Virtual memory buffer address containing the string.
     * $X_2$: String length in bytes.
     * Action: Mini-QEMU reads the string from virtual memory and writes it to the host terminal.

### Phase 6: Interactive Web UI & Visual Debugger
* **Goal:** Deliver an interactive visual debugger and execution dashboard running directly in the browser with zero heavy native dependencies.
* **Deliverables:**
  1. **Core Decoupling & Browser Compatibility:**
     * Refactored `ElfLoader` using standard `DataView` for `Uint8Array` in-memory buffers.
     * Added lifecycle hooks (`onStep`, `onWrite`, `onHalt`), `reset()`, and `breakpoints` set.
     * Memory block reading (`readBlock`) and CPU snapshot generation (`getSnapshot`).
  2. **Zero-Dependency Dev Server (`tools/server.js`):**
     * Built-in HTTP server providing binary catalog (`/api/binaries`) and streaming raw ELF binaries.
     * Configured `npm run ui` command with automatic port fallback.
  3. **Visual Debugger Frontend (`ui/`):**
     * **CPU State Inspector:** Live registers (`X0`–`X30`), `PC`, `SP`, `FP`, `LR`, condition flags (`NZCV`), and real-time diff pulse highlighting.
     * **Disassembly & Breakpoints:** Automatic `.text` disassembly with current PC pointer and clickable breakpoint gutters.
     * **Memory & Stack Hex Viewer:** 256-byte hex dump with ASCII previews and address jumps.
     * **Guest Terminal:** Live Linux syscall output viewer with exit code reporting.
     * **Custom Binary Loader:** Drag-and-drop custom ELF upload and speed slider (1 Hz to Turbo).

---

## 4. Verification & Testing Strategy

| Test Case | Description | Expected Outcome | Status |
| :--- | :--- | :--- | :--- |
| **Arithmetic Verification** | Execute `movz x0, #15; movz x1, #25; add x2, x0, x1` | $X_2 = 40$ | **PASS** |
| **Flag Setting & Branching** | Execute `movz x0, #5; subs x0, x0, #1; b.ne loop` | Loops exactly 5 times, exits when $Z = 1$ | **PASS** |
| **Fibonacci End-to-End** | Run 10-iteration loop via raw bytecode | $X_0 = 55$, exit syscall intercepted with code 55 | **PASS** |
| **ELF Loader Test** | Load compiled `fib.elf` from disk | Successfully parses headers, loads `.text`, and executes to completion | **PASS** |
| **Static AOT Recompilation** | Decompile `fib.elf` to native JavaScript and benchmark | 81.5x speedup over interpreter | **PASS** |
| **Memory Store & Load** | Execute `STR` to memory and `LDR` back to register | Register matches stored value ($0x1234$) | **PASS** |
| **String I/O (`sys_write`)** | Execute `hello.elf`, print string via Linux syscall 64 | "Hello from ARM64 running on Windows via Mini-QEMU!" printed | **PASS** |
| **Web UI & Debugger API** | Breakpoints, stepping, memory block reads, and program reset | All UI hooks and server tests passing | **PASS** |
| **Direct Block Chaining (Option A)** | Direct jump patching between hot JIT blocks (`linkTaken`/`linkFallthrough`) with clean unlinking on invalidation | 140x+ benchmark speedup over interpreter | **PASS** |
| **MMIO Audio & Synthesizer (Option B)** | 3-channel Chiptune PSG (Pulse, Triangle, Noise), PCM ring buffer (0x00870000), WAV export & oscilloscope | Bit-exact parity between interpreter & JIT on `audio_synth.elf` | **PASS** |
| **Multi-threading & LSE Atomics (Option C)** | ARMv8.1-A LSE atomics (`CAS`, `SWP`, `LDADD`, `LDCLR`, `LDEOR`, `LDSET`), `sys_clone`, `sys_futex`, round-robin scheduler | Bit-exact parity between interpreter & JIT on `threads.elf` (94 cycles, exitCode 42) | **PASS** |
| **Dynamic Linker & Shared Libraries (Option D)** | Load `libcalc.so`, parse `PT_DYNAMIC`, apply `R_AARCH64_JUMP_SLOT` / `RELATIVE`, HLE `SVC #0xdd` | Bit-exact parity between interpreter & JIT on `dynamic_app.elf` | **PASS** |

---

## 5. Technology Stack

* **Emulator Host Language:** JavaScript/TypeScript (running natively on **Node.js v24** available on this machine) or **C++**.
  * *Recommendation:* Node.js / TypeScript allows immediate development with zero compiler configuration issues on Windows, built-in `Buffer` and typed arrays (`BigUint64Array`, `Uint8Array`) for clean low-level memory modeling, and instant execution.
* **Guest Architecture:** AArch64 (ARM64).
* **Binary Format:** Standard 64-bit ELF (Executable and Linkable Format).
