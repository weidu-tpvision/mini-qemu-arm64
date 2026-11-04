# ARM64 (AArch64) Instruction Set Architecture Reference

This document provides a comprehensive reference for all ARM64 (AArch64) instructions implemented in Mini-QEMU. Each instruction is detailed with its assembly syntax, bitfield encoding patterns, architectural semantics, condition flag effects, and mappings in both execution engines: the **Static AOT Recompiler** (Binary-to-JavaScript) and the **ARM-to-x86-64 Translator** (Binary-to-Assembly/SSE).

---

## Table of Contents

1. [Architectural State & Register Model](#1-architectural-state--register-model)
2. [Instruction Summary by Group](#2-instruction-summary-by-group)
   - [Data Processing - Immediate](#data-processing---immediate)
   - [Data Processing - Register](#data-processing---register)
   - [Integer Math (Multiply & Divide)](#integer-math-multiply--divide)
   - [Shifts, Bitfield Extraction & Extensions](#shifts-bitfield-extraction--extensions)
   - [Conditional Selection & Inversion](#conditional-selection--inversion)
   - [Memory Access: Single Integer Load & Store](#memory-access-single-integer-load--store)
   - [Memory Access: Pair Load & Store (Stack Frames)](#memory-access-pair-load--store-stack-frames)
   - [Branches & Control Flow](#branches--control-flow)
   - [System Calls & Thread Local Storage](#system-calls--thread-local-storage)
   - [Scalar Floating-Point (VFP)](#scalar-floating-point-vfp)
   - [NEON Advanced SIMD (Vector Operations)](#neon-advanced-simd-vector-operations)
   - [Floating-Point & Vector Memory Operations](#floating-point--vector-memory-operations)
3. [Condition Code Evaluation (NZCV)](#3-condition-code-evaluation-nzcv)
4. [Instruction Decoding Architecture](#4-instruction-decoding-architecture)
5. [Dual Execution & Binary Translation Mapping](#5-dual-execution--binary-translation-mapping)

---

## 1. Architectural State & Register Model

### General-Purpose Integer Registers (GPR)
Mini-QEMU models 31 64-bit general-purpose registers (`X0`–`X30`), aliased to 32-bit lower halves (`W0`–`W30`):
* `X0`–`X7`: Function argument passing and return value registers (Linux ABI). `X8` holds the syscall number for `SVC #0`.
* `X9`–`X15`: Caller-saved scratch temporary registers.
* `X16`–`X17`: Intra-procedure call scratch registers (`IP0`, `IP1`).
* `X18`: Platform register (reserved in Linux ABI).
* `X19`–`X28`: Callee-saved preserved registers.
* `X29` (`FP`): Frame Pointer for call stack frame chains.
* `X30` (`LR`): Link Register, stores subroutine return address on `BL` / `BLR`.
* `SP`: 64-bit Stack Pointer (must be 16-byte aligned on memory access).
* `XZR` / `WZR`: Hardwired Zero Register. Reads return `0`; writes are silently discarded.
* `PC`: 64-bit Program Counter, advances by 4 bytes on every instruction cycle unless branched.

### Vector & Floating-Point Registers (VFP / NEON)
32 128-bit vector registers (`V0`–`V31`), accessible via overlapping scalar views:
* `Q0`–`Q31`: 128-bit quadword vector view (4×Float32, 2×Float64, 4×Int32, 8×Int16, 16×Int8).
* `D0`–`D31`: Lower 64-bit double-precision floating-point view.
* `S0`–`S31`: Lower 32-bit single-precision floating-point view.
* *Scalar Zeroing Rule:* Writing to `Sn` zeroes bits `[127:32]`; writing to `Dn` zeroes bits `[127:64]`.

### Status & Control Registers
* `NZCV`: Negative (`N`), Zero (`Z`), Carry (`C`), and Overflow (`V`) condition code flags.
* `FPCR`: Floating-Point Control Register (controls rounding mode and flush-to-zero).
* `FPSR`: Floating-Point Status Register (records cumulative IEEE-754 exception flags: IOC, DZC, OFC, UFC, IXC).
* `TPIDR_EL0`: Thread Pointer / TLS Base Register (accessed via `MRS` / `MSR`).

---

## 2. Instruction Summary by Group

### Data Processing - Immediate

| Mnemonic | Syntax | Description | Bitfield Encoding | Flags | AOT JS Lifting | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `MOVZ` | `movz Xd, #imm, lsl #shift` | Move 16-bit wide immediate to register, zeroing other bits | `sf 10 100101 hw imm16 Rd` | None | `cpu.setReg(d, imm)` | `mov r64, imm` |
| `MOVN` | `movn Xd, #imm, lsl #shift` | Move bitwise-inverted 16-bit immediate to register | `sf 00 100101 hw imm16 Rd` | None | `cpu.setReg(d, ~imm)` | `mov r64, ~imm` |
| `MOVK` | `movk Xd, #imm, lsl #shift` | Move 16-bit immediate, keeping existing bits unchanged | `sf 11 100101 hw imm16 Rd` | None | `cpu.setReg(d, (val & mask) \| imm)` | `mov reg16, imm` |
| `ADD` (imm) | `add Xd, Xn, #imm` | Add 12-bit unsigned immediate (optional LSL #12) | `sf 0 0 100010 sh imm12 Rn Rd` | None | `cpu.setReg(d, cpu.getReg(n) + imm)` | `add r64, imm` / `lea` |
| `SUB` (imm) | `sub Xd, Xn, #imm` | Subtract 12-bit unsigned immediate (optional LSL #12) | `sf 1 0 100010 sh imm12 Rn Rd` | None | `cpu.setReg(d, cpu.getReg(n) - imm)` | `sub r64, imm` |
| `SUBS` (imm)| `subs Xd, Xn, #imm`| Subtract immediate and set condition flags (`NZCV`) | `sf 1 1 100010 sh imm12 Rn Rd` | NZCV | Evaluates borrow, sign, zero, overflow | `cmp r64, imm` |
| `CMP` (imm) | `cmp Xn, #imm` | Alias of `subs xzr, Xn, #imm` | `sf 1 1 100010 sh imm12 Rn 11111` | NZCV | Updates condition flags without storing result | `cmp r64, imm` |
| `ADR` | `adr Xd, label` | Form PC-relative address (±1 MB range) | `0 immlo 10000 immhi Rd` | None | `cpu.setReg(d, pc + offset)` | `lea r64, [rip + offset]` |
| `ADRP` | `adrp Xd, label` | Form PC-relative 4 KB page base address (±4 GB range) | `1 immlo 10000 immhi Rd` | None | `cpu.setReg(d, (pc & ~0xFFF) + (imm<<12))` | `lea r64, [rip + page_off]` |

---

### Data Processing - Register

| Mnemonic | Syntax | Description | Bitfield Encoding | Flags | AOT JS Lifting | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `ADD` (reg) | `add Xd, Xn, Xm` | Add register values (32-bit `W` or 64-bit `X`) | `sf 0 0 01011 00 Rm 000000 Rn Rd` | None | `cpu.setReg(d, rn + rm)` | `add r64, r64` / `lea` |
| `SUB` (reg) | `sub Xd, Xn, Xm` | Subtract register values (32-bit `W` or 64-bit `X`) | `sf 1 0 01011 00 Rm 000000 Rn Rd` | None | `cpu.setReg(d, rn - rm)` | `sub r64, r64` |
| `SUBS` (reg)| `subs Xd, Xn, Xm`| Subtract register values and set condition flags | `sf 1 1 01011 00 Rm 000000 Rn Rd` | NZCV | Evaluates borrow, sign, zero, overflow | `sub r64, r64` / `cmp` |
| `CMP` (reg) | `cmp Xn, Xm` | Alias of `subs xzr, Xn, Xm` | `sf 1 1 01011 00 Rm 000000 Rn 11111`| NZCV | Compares registers, sets flags | `cmp r64, r64` |
| `AND` (reg) | `and Xd, Xn, Xm` | Bitwise AND | `sf 0 0 01010 00 Rm 000000 Rn Rd` | None | `cpu.setReg(d, rn & rm)` | `and r64, r64` |
| `ORR` (reg) | `orr Xd, Xn, Xm` | Bitwise OR (includes `mov Xd, Xm` when `Xn == XZR`) | `sf 0 1 01010 00 Rm 000000 Rn Rd` | None | `cpu.setReg(d, rn \| rm)` | `or r64, r64` / `mov` |
| `EOR` (reg) | `eor Xd, Xn, Xm` | Bitwise Exclusive-OR (XOR) | `sf 1 0 01010 00 Rm 000000 Rn Rd` | None | `cpu.setReg(d, rn ^ rm)` | `xor r64, r64` |
| `MVN` (reg) | `mvn Xd, Xm` | Bitwise NOT (alias of `orn Xd, xzr, Xm`) | `sf 0 1 01010 10 Rm 000000 11111 Rd`| None | `cpu.setReg(d, ~rm)` | `not r64` |

---

### Integer Math (Multiply & Divide)

| Mnemonic | Syntax | Description | Bitfield Encoding | Flags | AOT JS Lifting | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `MUL` | `mul Xd, Xn, Xm` | 32-bit or 64-bit integer multiply | `sf 00 11011 000 Rm 0 11111 Rn Rd` | None | `cpu.setReg(d, rn * rm)` | `imul r64, r64` |
| `MADD` | `madd Xd, Xn, Xm, Xa` | Multiply-Add: $X_d = X_a + (X_n \times X_m)$ | `sf 00 11011 000 Rm 0 Ra Rn Rd` | None | `cpu.setReg(d, ra + rn * rm)` | `imul` + `add` |
| `MSUB` | `msub Xd, Xn, Xm, Xa` | Multiply-Subtract: $X_d = X_a - (X_n \times X_m)$ | `sf 00 11011 000 Rm 1 Ra Rn Rd` | None | `cpu.setReg(d, ra - rn * rm)` | `imul` + `sub` |
| `SDIV` | `sdiv Xd, Xn, Xm` | Signed integer division (truncates towards 0; div-by-0 returns 0) | `sf 00 11010110 Rm 000011 Rn Rd` | None | `cpu.setReg(d, rm === 0 ? 0 : s_rn / s_rm)` | `cqo; idiv r64` |
| `UDIV` | `udiv Xd, Xn, Xm` | Unsigned integer division (div-by-0 returns 0) | `sf 00 11010110 Rm 000010 Rn Rd` | None | `cpu.setReg(d, rm === 0 ? 0 : rn / rm)` | `xor rdx,rdx; div r64`|

---

### Shifts, Bitfield Extraction & Extensions

| Mnemonic | Syntax | Description | Bitfield Encoding | Flags | AOT JS Lifting | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `LSL` (imm) | `lsl Xd, Xn, #shift` | Logical Shift Left by immediate | Alias of `UBFM Xd, Xn, #(-shift mod 64), #(63-shift)` | None | `cpu.setReg(d, rn << shift)` | `shl r64, imm` |
| `LSR` (imm) | `lsr Xd, Xn, #shift` | Logical Shift Right by immediate | Alias of `UBFM Xd, Xn, #shift, #63` | None | `cpu.setReg(d, rn >>> shift)` | `shr r64, imm` |
| `ASR` (imm) | `asr Xd, Xn, #shift` | Arithmetic Shift Right (preserves sign) | Alias of `SBFM Xd, Xn, #shift, #63` | None | `cpu.setReg(d, BigInt.asIntN(64, rn) >> shift)` | `sar r64, imm` |
| `LSL` (reg) | `lsl Xd, Xn, Xm` | Logical Shift Left by register | `sf 00 11010110 Rm 001000 Rn Rd` | None | `cpu.setReg(d, rn << (rm & 63))` | `shl r64, cl` |
| `LSR` (reg) | `lsr Xd, Xn, Xm` | Logical Shift Right by register | `sf 00 11010110 Rm 001001 Rn Rd` | None | `cpu.setReg(d, rn >>> (rm & 63))`| `shr r64, cl` |
| `ASR` (reg) | `asr Xd, Xn, Xm` | Arithmetic Shift Right by register | `sf 00 11010110 Rm 001010 Rn Rd` | None | `cpu.setReg(d, s_rn >> (rm & 63))` | `sar r64, cl` |
| `UBFM` | `ubfm Xd, Xn, #r, #s` | Unsigned Bitfield Move (`UXTB`, `UXTH`, `UBFX`) | `sf 10 100110 N immr imms Rn Rd` | None | Extracts bits `[s:r]`, zero-extends | `shr` + `and` |
| `SBFM` | `sbfm Xd, Xn, #r, #s` | Signed Bitfield Move (`SXTB`, `SXTH`, `SXTW`, `SBFX`)| `sf 00 100110 N immr imms Rn Rd` | None | Extracts bits `[s:r]`, sign-extends | `movsxd` / `shl`+`sar` |

---

### Conditional Selection & Inversion

| Mnemonic | Syntax | Description | Bitfield Encoding | Flags | AOT JS Lifting | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CSEL` | `csel Xd, Xn, Xm, cond` | Conditional Select: `cond ? Xn : Xm` | `sf 0 0 11010100 Rm cond 00 Rn Rd` | None | `cpu.setReg(d, test(cond) ? rn : rm)` | `cmov<cc> r64, r64` |
| `CSINC` | `csinc Xd, Xn, Xm, cond` | Conditional Select Increment: `cond ? Xn : Xm + 1` (`CSET`) | `sf 0 0 11010100 Rm cond 01 Rn Rd` | None | `cpu.setReg(d, test(cond) ? rn : rm + 1)` | `set<cc>` / `cmov` |
| `CSET` | `cset Xd, cond` | Conditional Set: `cond ? 1 : 0` (alias of `csinc Xd, xzr, xzr, !cond`) | `sf 0 0 11010100 11111 !cond 01 11111 Rd` | None | `cpu.setReg(d, test(cond) ? 1 : 0)` | `set<cc> al; movzx` |
| `CSINV` | `csinv Xd, Xn, Xm, cond` | Conditional Select Invert: `cond ? Xn : ~Xm` | `sf 1 0 11010100 Rm cond 00 Rn Rd` | None | `cpu.setReg(d, test(cond) ? rn : ~rm)` | `cmov` + `not` |
| `CSNEG` | `csneg Xd, Xn, Xm, cond` | Conditional Select Negate: `cond ? Xn : -Xm` | `sf 1 0 11010100 Rm cond 01 Rn Rd` | None | `cpu.setReg(d, test(cond) ? rn : -rm)` | `cmov` + `neg` |

---

### Memory Access: Single Integer Load & Store

Mini-QEMU supports 5 addressing modes:
1. **Unsigned scaled offset:** `[Xn, #offset]` where offset is scaled by operand size.
2. **Unscaled signed offset (`LDUR` / `STUR`):** `[Xn, #simm9]` (-256 to +255 bytes).
3. **Pre-indexed:** `[Xn, #simm9]!` (updates base register `Xn = Xn + simm9` before transfer).
4. **Post-indexed:** `[Xn], #simm9` (transfers data, then updates `Xn = Xn + simm9`).
5. **Register-offset:** `[Xn, Rm, LSL #shift]` (adds shifted index register to base).

| Mnemonic | Syntax | Description | Operand Size | Transfer Semantics | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `LDR` (64-bit) | `ldr Xt, [Xn, #imm]` | Load 64-bit doubleword into register | 8 bytes | `Xt = mem.readUint64(addr)` | `mov r64, [r64 + off]` |
| `STR` (64-bit) | `str Xt, [Xn, #imm]` | Store 64-bit doubleword to memory | 8 bytes | `mem.writeUint64(addr, Xt)` | `mov [r64 + off], r64` |
| `LDUR` / `STUR` | `ldur/stur Xt, [Xn, #simm9]` | Load/Store unscaled signed offset | 8 bytes | Negative stack indexing support | `mov r64, [r64 - off]` |
| `LDRW` / `STRW` | `ldr Wt, [Xn] / str Wt` | Load 32-bit word (zero-extends) / Store 32-bit word | 4 bytes | `Wt = mem.readUint32(addr)` | `mov r32, [r64 + off]` |
| `LDRSW` | `ldrsw Xt, [Xn, #imm]` | Load 32-bit signed word, sign-extending to 64-bit | 4 bytes | `Xt = BigInt(mem.readInt32(addr))` | `movsxd r64, [r64 + off]` |
| `LDRH` / `STRH` | `ldrh Wt, [Xn] / strh Wt` | Load 16-bit halfword (zero-extends) / Store 16-bit | 2 bytes | `Wt = mem.readUint16(addr)` | `movzx r32, word [r64]` |
| `LDRSH` | `ldrsh Xt, [Xn, #imm]` | Load 16-bit signed halfword, sign-extending to 64-bit | 2 bytes | `Xt = BigInt(mem.readInt16(addr))` | `movsx r64, word [r64]` |
| `LDRB` / `STRB` | `ldrb Wt, [Xn] / strb Wt` | Load 8-bit unsigned byte / Store 8-bit byte | 1 byte | `Wt = mem.readUint8(addr)` | `movzx r32, byte [r64]` |
| `LDRSB` | `ldrsb Xt, [Xn, #imm]` | Load 8-bit signed byte, sign-extending to 64-bit | 1 byte | `Xt = BigInt(mem.readInt8(addr))` | `movsx r64, byte [r64]` |

---

### Memory Access: Pair Load & Store (Stack Frames)

Used extensively by compilers (`gcc`, `clang`) for stack allocation and function prologue/epilogue (`FP` and `LR` preservation).

| Mnemonic | Syntax | Addressing Mode | Semantics | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- |
| `STP` (pre-index) | `stp X29, X30, [SP, #-16]!` | Pre-indexed writeback | `SP = SP - 16; mem[SP] = X29; mem[SP+8] = X30` | `push r30; push r29` |
| `STP` (signed-offset)| `stp Xt1, Xt2, [Xn, #imm]` | Signed offset | `mem[Xn+imm] = Xt1; mem[Xn+imm+8] = Xt2` | `mov [r+o], r1; mov [r+o+8], r2` |
| `STP` (post-index)| `stp Xt1, Xt2, [Xn], #imm` | Post-indexed writeback | `mem[Xn] = Xt1; mem[Xn+8] = Xt2; Xn = Xn + imm`| `mov [r], r1; add r, imm` |
| `LDP` (post-index)| `ldp X29, X30, [SP], #16` | Post-indexed writeback | `X29 = mem[SP]; X30 = mem[SP+8]; SP = SP + 16` | `pop r29; pop r30` |
| `LDP` (signed-offset)| `ldp Xt1, Xt2, [Xn, #imm]` | Signed offset | `Xt1 = mem[Xn+imm]; Xt2 = mem[Xn+imm+8]` | `mov r1, [r+o]; mov r2, [r+o+8]` |

---

### Branches & Control Flow

| Mnemonic | Syntax | Description | Range | Semantics | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `B` | `b label` | Unconditional relative branch | ±128 MB | `PC = PC + offset` | `jmp label` |
| `B.cond` | `b.<cond> label` | Conditional relative branch | ±1 MB | `if (eval(cond)) PC = PC + offset` | `j<cc> label` |
| `CBZ` | `cbz Xt, label` | Compare and Branch if Zero | ±1 MB | `if (Xt == 0) PC = PC + offset` | `test r64, r64; jz label` |
| `CBNZ` | `cbnz Xt, label` | Compare and Branch if Non-Zero | ±1 MB | `if (Xt != 0) PC = PC + offset` | `test r64, r64; jnz label` |
| `TBZ` | `tbz Xt, #bit, label` | Test Bit and Branch if Zero | ±32 KB | `if (((Xt >> bit) & 1) == 0) PC += off` | `test r64, (1<<bit); jz` |
| `TBNZ` | `tbnz Xt, #bit, label`| Test Bit and Branch if Non-Zero | ±32 KB | `if (((Xt >> bit) & 1) != 0) PC += off` | `test r64, (1<<bit); jnz` |
| `BL` | `bl label` | Branch with Link (subroutine call) | ±128 MB | `X30 = PC + 4; PC = PC + offset` | `call label` |
| `BR` | `br Xn` | Indirect Branch to register address | Any 64-bit | `PC = Xn` | `jmp r64` |
| `BLR` | `blr Xn` | Indirect Call via register pointer | Any 64-bit | `X30 = PC + 4; PC = Xn` | `call r64` |
| `RET` | `ret [Xn]` | Return from subroutine (default `X30`) | Any 64-bit | `PC = cpu.getReg(30)` | `ret` |

---

### System Calls & Thread Local Storage

| Mnemonic | Syntax | Description | Implementation in Mini-QEMU |
| :--- | :--- | :--- | :--- |
| `SVC #0` | `svc #0` | Supervisor Call (Linux Syscall trap) | Dispatches syscall using number in `X8`, arguments in `X0`–`X5`, returns status in `X0`. |
| `MRS` | `mrs Xt, TPIDR_EL0` | Move Thread Pointer to Register | Returns thread-local storage (TLS) pointer base address. |
| `MSR` | `msr TPIDR_EL0, Xt` | Move Register to Thread Pointer | Configures TLS base address (used by `__set_thread_area` / `musl`). |
| `NOP` | `nop` | No Operation | Program counter advances by 4 bytes. |
| `YIELD` | `yield` | Hint: Yield thread execution | Execution yield hint to scheduler / frame synchronizer. |
| `DMB` / `DSB` / `ISB` | `dmb sy` / `dsb sy` / `isb` | Memory and Instruction Barriers | Ensures memory visibility / synchronization barriers (no-op in uniprocessor guest). |
| `CLZ` | `clz Wd, Wn` / `clz Xd, Xn` | Count Leading Zeros | Computes number of leading zero bits (0 to 32/64). Used in allocators & printf. |
| `REV` | `rev Wd, Wn` / `rev Xd, Xn` | Byte Reverse (Endianness Swap) | Reverses byte order (e.g. `htonl` / `ntohl` 32-bit and 64-bit). |
| `REV16` | `rev16 Wd, Wn` / `rev16 Xd, Xn` | Byte Reverse in Halfwords | Reverses bytes in each 16-bit halfword (e.g. `htons` / `ntohs`). |
| `REV32` | `rev32 Xd, Xn` | Byte Reverse in Words | Reverses bytes in each 32-bit word of a 64-bit register. |
| `RBIT` | `rbit Wd, Wn` / `rbit Xd, Xn` | Bit Reverse | Reverses order of all 32 or 64 bits. |
| `EXTR` | `extr Xd, Xn, Xm, #lsb` | Extract Register from Pair | Extracts bits `[lsb+63 : lsb]` from concatenated registers (`ROR` if Xn == Xm). |
| `LDXR` | `ldxr Xt, [Xn]` / `ldxr Wt, [Xn]` | Load-Exclusive Register | Atomic load; records exclusive access monitor. |
| `STXR` | `stxr Ws, Xt, [Xn]` | Store-Exclusive Register | Atomic store; returns status `Ws = 0` on exclusive success. |

#### Supported Linux System Calls (`SVC #0`)
* `sys_openat` (56), `sys_close` (57), `sys_read` (63), `sys_readv` (65, scatter-gather read), `sys_write` (64), `sys_writev` (66, scatter-gather write), `sys_lseek` (62), `sys_fstat` (80), `sys_newfstatat` (79), `sys_unlinkat` (35), `sys_getcwd` (17), `sys_dup` (23), `sys_dup3` (24), `sys_pipe2` (59), `sys_fcntl` (25), `sys_ioctl` (29): In-memory Virtual File System (VFS) and standard I/O descriptor table.
* `sys_exit` (93), `sys_exit_group` (94), `sys_kill` (129), `sys_tkill` (130), `sys_tgkill` (131): Process and thread termination & signal delivery.
* `sys_brk` (214): Dynamic heap management (query, expansion, sub-page contraction).
* `sys_mmap` (222), `sys_munmap` (215), `sys_mprotect` (226), `sys_madvise` (233): Virtual memory allocation, reclamation, and advice.
* `sys_futex` (98): Fast Userspace Mutex (`FUTEX_WAIT`, `FUTEX_WAKE`, `FUTEX_REQUEUE`).
* `sys_set_robust_list` (99), `sys_set_tid_address` (96), `sys_prlimit64` (261): Thread and resource limits initialization.
* `sys_rt_sigaction` (134), `sys_rt_sigprocmask` (135), `sys_sigaltstack` (132): Signal handler management stubs.
* `sys_clock_gettime` (113), `sys_gettimeofday` (169), `sys_nanosleep` (101), `sys_clock_nanosleep` (115): Hardware and epoch clocks.
* `sys_getrandom` (278), `sys_uname` (160), `sys_getpid` (172), `sys_getppid` (173), `sys_gettid` (178), `sys_getuid` (174), `sys_geteuid` (175), `sys_getgid` (176), `sys_getegid` (177): Process identity and entropy.
* `sys_sched_yield` (124): Frame-yield MMIO synchronization for 60 FPS VSync loop.
* `sys_statx` (291), `sys_rseq` (293), and unknown syscalls: Return official Linux `-ENOSYS` (-38) error code, enabling graceful fallback for libc feature detection.

---

### Scalar Floating-Point (VFP)

All scalar floating-point instructions conform to IEEE-754 semantics.

| Mnemonic | Syntax | Description | Operand Types | Semantics | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `FADD` | `fadd Dd, Dn, Dm` | Floating-point Addition | Single / Double | $D_d = D_n + D_m$ | `addsd xmm, xmm` / `addss` |
| `FSUB` | `fsub Dd, Dn, Dm` | Floating-point Subtraction | Single / Double | $D_d = D_n - D_m$ | `subsd xmm, xmm` / `subss` |
| `FMUL` | `fmul Dd, Dn, Dm` | Floating-point Multiplication | Single / Double | $D_d = D_n \times D_m$ | `mulsd xmm, xmm` / `mulss` |
| `FDIV` | `fdiv Dd, Dn, Dm` | Floating-point Division | Single / Double | $D_d = D_n \div D_m$ | `divsd xmm, xmm` / `divss` |
| `FNMUL` | `fnmul Dd, Dn, Dm` | Negated Multiplication | Single / Double | $D_d = -(D_n \times D_m)$ | `mulsd; xorpd` |
| `FNEG` | `fneg Dd, Dn` | Floating-point Negation | Single / Double | $D_d = -D_n$ (inverts sign bit) | `xorpd xmm, [sign_mask]` |
| `FABS` | `fabs Dd, Dn` | Floating-point Absolute Value | Single / Double | $D_d = \|D_n\|$ (clears sign bit) | `andpd xmm, [abs_mask]` |
| `FSQRT` | `fsqrt Dd, Dn` | Floating-point Square Root | Single / Double | $D_d = \sqrt{D_n}$ | `sqrtsd xmm, xmm` / `sqrtss` |
| `FMAX` | `fmax Dd, Dn, Dm` | Floating-point Maximum | Single / Double | $D_d = \max(D_n, D_m)$ | `maxsd xmm, xmm` / `maxss` |
| `FMIN` | `fmin Dd, Dn, Dm` | Floating-point Minimum | Single / Double | $D_d = \min(D_n, D_m)$ | `minsd xmm, xmm` / `minss` |
| `FCMP` | `fcmp Dn, Dm` | Floating-point Compare | Single / Double | Sets `NZCV` flags according to IEEE-754 order | `ucomisd xmm, xmm` |
| `FCVT` | `fcvt Dd, Sn` / `fcvt Sd, Dn` | Precision Conversion | Single $\leftrightarrow$ Double | Converts between Float32 and Float64 | `cvtss2sd` / `cvtsd2ss` |
| `SCVTF` | `scvtf Dd, Xn` | Signed integer to Float | Int32/64 $\to$ Float32/64 | Converts two's-complement integer to float | `cvtsi2sd xmm, r64` |
| `UCVTF` | `ucvtf Dd, Xn` | Unsigned integer to Float | UInt32/64 $\to$ Float32/64| Converts unsigned integer to float | Zero-extended `cvtsi2sd` |
| `FCVTZS` | `fcvtzs Xd, Dn` | Float to Signed integer | Float32/64 $\to$ Int32/64 | Truncates towards zero (`NaN` $\to 0$, saturates $\pm\infty$) | `cvttsd2si r64, xmm` |
| `FCVTZU` | `fcvtzu Xd, Dn` | Float to Unsigned integer | Float32/64 $\to$ UInt32/64| Truncates towards zero (`NaN`/neg $\to 0$, saturates $+\infty$) | `cvttsd2si` with range clamp |
| `FMOV` (reg)| `fmov Dd, Dn` | Float register copy | Single / Double | Copies float register, zeroes upper bits | `movaps xmm, xmm` |
| `FMOV` (imm)| `fmov Dd, #imm` | Load float immediate | 8-bit encoded float | Decodes 8-bit float pattern into FPR | `movsd xmm, [rip + const]` |
| `FMOV` (cast)| `fmov Xd, Dn` / `fmov Dd, Xn`| Bitcast GPR $\leftrightarrow$ FPR | 32-bit / 64-bit | Exact bit-pattern transfer without conversion | `movq r64, xmm` / `movq xmm, r64` |

---

### NEON Advanced SIMD (Vector Operations)

Mini-QEMU implements 64-bit (`Q=0`) and 128-bit (`Q=1`) NEON vector operations processing parallel lanes (`8B`/`16B`, `4H`/`8H`, `2S`/`4S`, `1D`/`2D`). Any `Q=0` (64-bit) vector operation zeroes bits `[127:64]`.

| Mnemonic | Syntax | Description | Vector Arrangement | Semantics | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `FADD` (vec) | `fadd Vd.4s, Vn.4s, Vm.4s` | Packed Vector Float Add | `2S`/`4S` / `2D` | $V_d[i] = V_n[i] + V_m[i]$ | `addps xmm, xmm` / `addpd` |
| `FSUB` (vec) | `fsub Vd.4s, Vn.4s, Vm.4s` | Packed Vector Float Sub | `2S`/`4S` / `2D` | $V_d[i] = V_n[i] - V_m[i]$ | `subps xmm, xmm` / `subpd` |
| `FMUL` (vec) | `fmul Vd.4s, Vn.4s, Vm.4s` | Packed Vector Float Multiply | `2S`/`4S` / `2D` | $V_d[i] = V_n[i] \times V_m[i]$ | `mulps xmm, xmm` / `mulpd` |
| `FDIV` (vec) | `fdiv Vd.4s, Vn.4s, Vm.4s` | Packed Vector Float Divide | `2S`/`4S` / `2D` | $V_d[i] = V_n[i] \div V_m[i]$ | `divps xmm, xmm` / `divpd` |
| `FADDP` (vec)| `faddp Vd.4s, Vn.4s, Vm.4s`| Pairwise Vector Float Add | `2S`/`4S` / `2D` | $V_d[0]=V_n[0]+V_n[1], V_d[1]=V_n[2]+V_n[3]$ | `haddps xmm, xmm` / `haddpd` |
| `FMAX` (vec) | `fmax Vd.4s, Vn.4s, Vm.4s` | Packed Vector Float Max | `2S`/`4S` / `2D` | $V_d[i] = \max(V_n[i], V_m[i])$ | `maxps xmm, xmm` / `maxpd` |
| `FMIN` (vec) | `fmin Vd.4s, Vn.4s, Vm.4s` | Packed Vector Float Min | `2S`/`4S` / `2D` | $V_d[i] = \min(V_n[i], V_m[i])$ | `minps xmm, xmm` / `minpd` |
| `FNEG` (vec) | `fneg Vd.4s, Vn.4s` | Packed Vector Float Negate | `2S`/`4S` / `2D` | $V_d[i] = -V_n[i]$ | `xorps xmm, [sign_mask]` |
| `FABS` (vec) | `fabs Vd.4s, Vn.4s` | Packed Vector Float Abs | `2S`/`4S` / `2D` | $V_d[i] = \|V_n[i]\|$ | `andps xmm, [abs_mask]` |
| `ADD` (vec) | `add Vd.4s, Vn.4s, Vm.4s` | Packed Vector Integer Add | `8B`/`16B`, `4H`/`8H`, `2S`/`4S`, `2D` | $V_d[i] = V_n[i] + V_m[i]$ | `paddd xmm, xmm` / `paddq` |
| `SUB` (vec) | `sub Vd.4s, Vn.4s, Vm.4s` | Packed Vector Integer Sub | `8B`/`16B`, `4H`/`8H`, `2S`/`4S`, `2D` | $V_d[i] = V_n[i] - V_m[i]$ | `psubd xmm, xmm` / `psubq` |
| `MUL` (vec) | `mul Vd.4s, Vn.4s, Vm.4s` | Packed Vector Integer Mul | `8B`/`16B`, `4H`/`8H`, `2S`/`4S` | $V_d[i] = V_n[i] \times V_m[i]$ | `pmulld xmm, xmm` |
| `ADDP` (vec) | `addp Vd.4s, Vn.4s, Vm.4s` | Pairwise Vector Integer Add | `8B`/`16B`, `4H`/`8H`, `2S`/`4S`, `2D` | Pairwise integer addition reduction | `phaddd xmm, xmm` |
| `AND` (vec) | `and Vd.16b, Vn.16b, Vm.16b`| Vector Bitwise AND | `8B` / `16B` | $V_d = V_n \ \& \ V_m$ | `pand xmm, xmm` |
| `ORR` (vec) | `orr Vd.16b, Vn.16b, Vm.16b`| Vector Bitwise OR | `8B` / `16B` | $V_d = V_n \ \| \ V_m$ | `por xmm, xmm` |
| `EOR` (vec) | `eor Vd.16b, Vn.16b, Vm.16b`| Vector Bitwise XOR | `8B` / `16B` | $V_d = V_n \oplus V_m$ | `pxor xmm, xmm` |
| `NOT` (vec) | `mvn Vd.16b, Vn.16b` | Vector Bitwise NOT | `8B` / `16B` | $V_d = \sim V_n$ | `pxor xmm, [all_ones]` |
| `DUP` (gen) | `dup Vd.4s, Wn` | Broadcast GPR to all lanes | `2S`/`4S` / `2D` | Broadcasts general register to all vector lanes | `movd xmm, r32; pshufd` |
| `DUP` (elem)| `dup Vd.4s, Vn.s[index]` | Broadcast element to all lanes | `2S`/`4S` / `2D` | Broadcasts specified vector lane to all lanes | `pshufd xmm, xmm, imm` |
| `INS` (gen) | `ins Vd.s[index], Wn` | Insert GPR into vector lane | Single lane | $V_d[\text{index}] = W_n$ | `pinsrd xmm, r32, imm` |
| `INS` (elem)| `ins Vd.s[dst], Vn.s[src]` | Copy lane between vectors | Single lane | $V_d[\text{dst}] = V_n[\text{src}]$ | `insertps xmm, xmm, imm` |
| `UMOV` | `umov Wd, Vn.s[index]` | Extract lane to GPR | Single lane | $W_d = V_n[\text{index}]$ | `pextrd r32, xmm, imm` |

---

### Floating-Point & Vector Memory Operations

| Mnemonic | Syntax | Description | Operand Size | Semantics | x86-64 Translation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `LDR` (FPR) | `ldr Sd, [Xn, #imm]` | Load Single-precision Float | 4 bytes | `Sd = readFloat32(addr)`; zeroes bits `[127:32]` | `movss xmm, [r64]` |
| `LDR` (FPR) | `ldr Dd, [Xn, #imm]` | Load Double-precision Float | 8 bytes | `Dd = readFloat64(addr)`; zeroes bits `[127:64]` | `movsd xmm, [r64]` |
| `STR` (FPR) | `str Sd, [Xn, #imm]` | Store Single-precision Float | 4 bytes | `writeFloat32(addr, Sd)` | `movss [r64], xmm` |
| `STR` (FPR) | `str Dd, [Xn, #imm]` | Store Double-precision Float | 8 bytes | `writeFloat64(addr, Dd)` | `movsd [r64], xmm` |
| `LDR` (VPR) | `ldr Qd, [Xn, #imm]` | Load 128-bit Vector Register | 16 bytes | `Qd = readBytes(addr, 16)` | `movdqu xmm, [r64]` |
| `STR` (VPR) | `str Qd, [Xn, #imm]` | Store 128-bit Vector Register| 16 bytes | `writeBytes(addr, Qd.bytes)` | `movdqu [r64], xmm` |
| `LDP` (FPR) | `ldp Dd1, Dd2, [Xn, #imm]` | Load Pair Double-precision Float | 16 bytes | Loads two sequential doublewords into FPRs | `movsd; movsd` |
| `STP` (FPR) | `stp Dd1, Dd2, [Xn, #imm]` | Store Pair Double-precision Float| 16 bytes | Stores two sequential FPR doublewords | `movsd; movsd` |
| `LDP` (VPR) | `ldp Qd1, Qd2, [Xn, #imm]` | Load Pair 128-bit Vector Regs | 32 bytes | Loads 32 bytes into two quadword vector regs | `movdqu; movdqu` |
| `STP` (VPR) | `stp Qd1, Qd2, [Xn, #imm]` | Store Pair 128-bit Vector Regs| 32 bytes | Stores two quadword vector registers (32B) | `movdqu; movdqu` |

---

## 3. Condition Code Evaluation (NZCV)

ARM64 instructions evaluate condition codes against the `NZCV` status flags:

| Code | Suffix | Meaning | Flag Test Condition |
| :---: | :--- | :--- | :--- |
| `0000` | `EQ` | Equal | $Z == 1$ |
| `0001` | `NE` | Not Equal | $Z == 0$ |
| `0010` | `CS` / `HS` | Carry Set / Unsigned Higher or Same | $C == 1$ |
| `0011` | `CC` / `LO` | Carry Clear / Unsigned Lower | $C == 0$ |
| `0100` | `MI` | Minus / Negative | $N == 1$ |
| `0101` | `PL` | Plus / Positive or Zero | $N == 0$ |
| `0110` | `VS` | Overflow Set | $V == 1$ |
| `0111` | `VC` | Overflow Clear | $V == 0$ |
| `1000` | `HI` | Unsigned Higher | $C == 1 \ \& \ Z == 0$ |
| `1001` | `LS` | Unsigned Lower or Same | $!(C == 1 \ \& \ Z == 0)$ |
| `1010` | `GE` | Signed Greater than or Equal | $N == V$ |
| `1011` | `LT` | Signed Less than | $N \ne V$ |
| `1100` | `GT` | Signed Greater than | $Z == 0 \ \& \ N == V$ |
| `1101` | `LE` | Signed Less than or Equal | $!(Z == 0 \ \& \ N == V)$ |
| `1110` | `AL` | Always | Any (Always True) |
| `1111` | `NV` | Never (or Always in ARMv8) | Always True |

### Floating-Point Comparison (`FCMP`) Flag Mapping
`FCMP Dn, Dm` sets flags to reflect IEEE-754 ordering:
* **Equal ($D_n == D_m$):** $N=0, Z=1, C=1, V=0$ (`EQ`, `GE`, `LE`, `CS`, `LS`)
* **Less than ($D_n < D_m$):** $N=1, Z=0, C=0, V=0$ (`NE`, `LT`, `LE`, `CC`, `MI`)
* **Greater than ($D_n > D_m$):** $N=0, Z=0, C=1, V=0$ (`NE`, `GT`, `GE`, `CS`, `HI`)
* **Unordered (NaN):** $N=0, Z=0, C=0, V=1$ (`VS`, `NE`, `CC`, `LS`)

---

## 4. Instruction Decoding Architecture

The modular bitfield decoder in [`src/decoder.js`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/decoder.js) uses the top-level dispatch bits `op0` (bits `[28:25]`):

```
       31  30  29  28  27  26  25  24                              0
      +---+---+---+---+---+---+---+--------------------------------+
      |      op0      |               Instruction Body             |
      +---+---+---+---+--------------------------------------------+
```

1. **`op0 & 0b1110 === 0b1000`:** Data Processing — Immediate (`MOVZ`, `MOVN`, `MOVK`, `ADD_IMM`, `SUB_IMM`, `SUBS_IMM`, `ADR`, `ADRP`).
2. **`op0 & 0b1110 === 0b1010`:** Branches, Exception Generation & System (`B`, `B.cond`, `CBZ`, `CBNZ`, `TBZ`, `TBNZ`, `BL`, `BR`, `BLR`, `RET`, `SVC`, `MRS`, `MSR`).
3. **`op0 & 0b0101 === 0b0100`:** Loads and Stores (`LDR`, `STR`, `LDP`, `STP`, scalar FP loads/stores, vector loads/stores).
4. **`op0 & 0b0111 === 0b0101`:** Data Processing — Register (`ADD_REG`, `SUB_REG`, `SUBS_REG`, `AND_REG`, `ORR_REG`, `EOR_REG`, `MVN_REG`, `MUL`, `MADD`, `MSUB`, `SDIV`, `UDIV`, `CSEL`, `CSINC`, `CSINV`, `CSNEG`).
5. **`op0 & 0b0111 === 0b0111`:** Floating-Point & Advanced SIMD:
   - Scalar FP 2-source (`FADD`, `FSUB`, `FMUL`, `FDIV`, `FNMUL`, `FMAX`, `FMIN`).
   - Scalar FP 1-source (`FABS`, `FNEG`, `FSQRT`, `FCVT`).
   - Scalar FP Comparisons (`FCMP`) & Conversions (`SCVTF`, `UCVTF`, `FCVTZS`, `FCVTZU`).
   - NEON Vector Arithmetic (`FADD_VEC`, `FSUB_VEC`, `FMUL_VEC`, `FDIV_VEC`, `FADDP_VEC`, `FMAX_VEC`, `FMIN_VEC`, `FNEG_VEC`, `FABS_VEC`, `ADD_VEC`, `SUB_VEC`, `MUL_VEC`, `ADDP_VEC`).
   - NEON Vector Bitwise Logic (`AND_VEC`, `ORR_VEC`, `EOR_VEC`, `NOT_VEC`).
   - NEON Vector Structural & Splat (`DUP_ELEM`, `DUP_GEN`, `INS_GEN`, `INS_ELEM`, `UMOV_ELEM`).

---

## 5. Dual Execution & Binary Translation Mapping

| Subsystem | Interpreter (`emulator.js`) | Static AOT Recompiler (`static_recompiler.js`) | ARM-to-x86 Translator (`arm2x86.js`) |
| :--- | :--- | :--- | :--- |
| **GPR Integer Arithmetic** | Native `BigInt` operations on `BigUint64Array` | Direct JS JavaScript operators (`+`, `-`, `*`, `/`) | Direct x86-64 64-bit ALU (`add`, `sub`, `imul`, `idiv`) |
| **Condition Codes** | Explicit `N, Z, C, V` boolean object evaluation | Cached local booleans with short-circuiting | Native x86 EFLAGS (`jz`, `jnz`, `jge`, `jle`, etc.) |
| **Call Stack Frames** | Virtual RAM push/pop via `memory.writeUint64` | Inlined array indexed memory operations | Native x86 stack `push`/`pop` or `rsp` offsets |
| **System Calls (`SVC`)** | Traps into synchronous JavaScript handler table | Inlines I/O thunks with syscall dispatch | Emits `mov rax, sys_nr; syscall` thunks |
| **Scalar FP Arithmetic** | `Math.*` with IEEE-754 Single/Double typed buffers | Direct JS `Float32Array` / `Float64Array` access | SSE/AVX scalar math: `addss`/`addsd`, `sqrtsd`, etc. |
| **128-bit NEON SIMD** | Parallel lane loops on 512-byte buffer | Unrolled JS float/int lane arithmetic | Packed SSE instructions: `addps`, `mulps`, `haddps`, `paddd` |
| **MMIO VRAM (0x800000)** | Fast 4KB dirty-page tracking to Canvas | Direct typed buffer writes | Direct memory store thunks |
| **MMIO Input (0x850000)**| Live keyboard bitmask & mouse $(X,Y)$ polling | Synchronized input state registers | Peripheral read/write thunks |
