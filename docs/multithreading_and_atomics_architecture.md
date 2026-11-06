# ARMv8.1-A LSE Atomics & Multi-Threading Architecture

## 1. Overview & Architectural Goals

Modern AArch64 operating systems and runtime environments (such as Linux, glibc, and musl libc) rely on two fundamental pillars for multi-core and multi-threaded concurrency:
1. **Hardware-Accelerated Atomics (ARMv8.1-A Large System Extensions / LSE):** Single-instruction atomic read-modify-write memory operations that replace expensive and contention-prone `LDXR`/`STXR` exclusive load/store retry loops.
2. **Kernel Threading & Synchronization Primitives:** Linux user-space thread creation via `sys_clone` (syscall 220) and fast userspace locking via `sys_futex` (syscall 98).

Mini-QEMU implements both layers with full bit-exact parity between the pure software interpreter and the dynamic JIT compiler.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Mini-QEMU Concurrency Engine                   │
│                                                                        │
│   ┌──────────────────────────┐         ┌───────────────────────────┐   │
│   │ Main Thread (TID 1000)   │         │ Worker Thread (TID 1001)  │   │
│   │ • SP: 0x00700000         │         │ • SP: 0x00420000          │   │
│   │ • Status: RUNNING/READY  │         │ • Status: RUNNING/READY   │   │
│   └────────────┬─────────────┘         └─────────────┬─────────────┘   │
│                │                                     │                 │
│                │  sys_sched_yield (124)              │                 │
│                ▼                                     ▼                 │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │         Cooperative Round-Robin Scheduler (Quantum = 50)       │   │
│   └────────────────────────────────┬───────────────────────────────┘   │
│                                    │                                   │
│                                    ▼                                   │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                 Shared Memory Space (CLONE_VM)                 │   │
│   │  • 0x00410000: Shared Counter (LDADD atomic increment)         │   │
│   │  • 0x00410004: Futex Barrier (SWP transition & FUTEX_WAKE)     │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. ARMv8.1-A Large System Extensions (LSE) Atomics

### 2.1 Compare and Swap (`CAS`, `CASA`, `CASL`, `CASAL`)
Single-register compare and swap evaluates the memory operand at address `[Xn]`:
- If `[Xn] == Rs`: stores `Rt` into `[Xn]`.
- In all cases: loads the original value of `[Xn]` into `Rs`.

#### Binary Bitfield Encoding:
```
31  30 29      24 23 22 21 20    16 15 14   10 9    5 4    0
┌─────┬──────────┬──┬──┬──┬────────┬──┬───────┬──────┬──────┐
│size │ 0 0 1 0 0│ 1│ L│ 1│   Rs   │o0│ 11111 │  Rn  │  Rt  │
└─────┴──────────┴──┴──┴──┴────────┴──┴───────┴──────┴──────┘
```
- `size`: `00` (byte / CASB), `01` (halfword / CASH), `10` (word / 32-bit), `11` (doubleword / 64-bit).
- `L` (bit 22) & `o0` (bit 15) Memory Ordering:
  - `L=0, o0=0`: Plain (`cas`)
  - `L=0, o0=1`: Acquire semantics (`casa`)
  - `L=1, o0=0`: Release semantics (`casl`)
  - `L=1, o0=1`: Acquire & Release semantics (`casal`)

### 2.2 Atomic Memory Operations (`LDADD`, `LDCLR`, `LDEOR`, `LDSET`, `SWP`)
Atomic read-modify-write memory operations execute atomically:
1. Reads original value from `[Xn]` into destination `Rt`.
2. Computes arithmetic or bitwise operation with operand in `Rs`.
3. Stores updated result back into `[Xn]`.

#### Binary Bitfield Encoding:
```
31  30 29      24 23 22 21 20    16 15    12 11 10 9    5 4    0
┌─────┬──────────┬──┬──┬──┬────────┬────────┬─────┬──────┬──────┐
│size │ 1 1 1 0 0│ A│ R│ 1│   Rs   │  opc   │ 0 0 │  Rn  │  Rt  │
└─────┴──────────┴──┴──┴──┴────────┴────────┴─────┴──────┴──────┘
```
- `opc[15:12]`:
  - `0000`: `LDADD` (Atomic addition: `mem + Rs`)
  - `0001`: `LDCLR` (Atomic bit clear: `mem & ~Rs`)
  - `0010`: `LDEOR` (Atomic bitwise exclusive OR: `mem ^ Rs`)
  - `0011`: `LDSET` (Atomic bitwise set: `mem | Rs`)
  - `1000`: `SWP` (Atomic register-memory exchange: stores `Rs` to `mem`, returns old `mem` in `Rt`)
- `A` (bit 23): Acquire ordering flag.
- `R` (bit 22): Release ordering flag.
- When `Rt == 31` (`wzr` / `xzr`), the instruction functions as an atomic store without returning old data (e.g. `STADD`, `STCLR`, `STEOR`, `STSET`).

---

## 3. Multi-Threading & Thread Lifecycle

### 3.1 `sys_clone` (Syscall 220)
Linux AArch64 standard thread creation:
```c
long sys_clone(unsigned long flags, void *child_stack, int *parent_tidptr,
               void *tls, int *child_tidptr);
```
- **CLONE_VM (`0x00000100`):** Parent and child share the same virtual address space.
- **CLONE_FS (`0x00000200`) & CLONE_FILES (`0x00000400`):** Shared file descriptors and VFS state.
- **CLONE_THREAD (`0x00010000`):** Child is added to the same thread group.
- **CLONE_SETTLS (`0x00080000`):** Child's `TPIDR_EL0` system register is populated with `tls`.
- **CLONE_PARENT_SETTID (`0x00100000`):** Child TID is written to `parent_tidptr` in memory.
- **CLONE_CHILD_CLEARTID (`0x00200000`):** Address recorded in thread context; on thread termination, memory at `child_tidptr` is cleared to 0 and wakes waiting threads via `futex(FUTEX_WAKE)`.
- **Return Value:** Parent returns `childTid` (e.g. 1001) in `X0`; child returns `0` in `X0`.

### 3.2 `sys_futex` (Syscall 98)
Fast userspace mutual exclusion locking:
- **`FUTEX_WAIT` (op = 0):** Atomically checks if memory at `uaddr` equals `val`. If equal, sets the calling thread to `WAITING` state and yields. If not equal, immediately returns `-EAGAIN` (`-11`).
- **`FUTEX_WAKE` (op = 1):** Unblocks up to `val` threads waiting on `uaddr`, transitioning their state from `WAITING` to `READY`. Returns the number of woken threads.

### 3.3 Thread Exit & Cleanup
- **`sys_exit` (Syscall 93):** Terminates the calling thread. If `clear_child_tid` was set, clears memory and triggers `FUTEX_WAKE`. If all threads have exited, halts the emulator with the final exit code.
- **`sys_exit_group` (Syscall 94):** Halts the entire emulator immediately, terminating all active threads.

---

## 4. Verification & Testing

The multi-threading and atomics architecture is validated by:
- `tests/test_threads.js`: Unit tests for decoders, atomic memory operations, `sys_clone`, and `sys_futex`.
- `bin/threads.elf`: Assembled guest binary running parent and worker threads concurrently, verifying `LDADD` increments and `SWP` barrier synchronization.
- 100% bit-exact parity between interpreter and dynamic JIT execution.
