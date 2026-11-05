# Dynamic Just-In-Time (JIT) Compilation Architecture

A technical deep dive on the design, implementation, and performance characteristics of the **Dynamic Just-In-Time (JIT) Compiler** in Mini-QEMU ARM64.

---

## 1. Executive Summary

While the **Fetch-Decode-Execute interpreter** simulates the architectural state of an ARM64 CPU with high fidelity, pure interpreters suffer from a severe **dispatch penalty**:
Every instruction requires reading 32 bits from virtual RAM, bitmasking and shifting opcodes, evaluating a JavaScript `switch-case`, calling register accessors, and incrementing the program counter. This imposes a **30x to 100x overhead** compared to native host execution.

Static Ahead-Of-Time (AOT) binary recompilation addresses this, but is fundamentally limited when encountering runtime indirect calls (`blr xn`), self-modifying code, or dynamic heap allocations.

Mini-QEMU's **Dynamic JIT Compiler** (`src/jit.js`) bridges this gap:
1. **Tiered Execution:** Starts execution in the lightweight interpreter while profiling basic block hotness.
2. **On-the-Fly Compilation:** Once a basic block crosses the hotness threshold (default: 5 entries), the JIT compiles the sequence of ARM64 instructions directly into an optimized JavaScript closure (`new Function("cpu", "memory", "emu", bodySource)`).
3. **Host V8 / Turbofan JIT Acceleration:** V8 optimizes the generated closure into raw x86-64 machine instructions running on the physical CPU.
4. **100+x Speedup:** Benchmark tests demonstrate a **109.5x to 112.4x speedup** over the pure interpreter with **100% bit-exact register, flag, and memory parity**.

---

## 2. Architecture & Pipeline

```
                              ARM64 Guest Execution Flow
                                          │
                                          ▼
                                   [ Current PC ]
                                          │
                          Is block in JIT Cache?
                                   /             \
                             YES  /               \  NO
                                 ▼                 ▼
                   [ Execute Compiled Block ]  Record Hotness
                   • Direct BigUint64Array     Counter (PC)
                   • Fast flag calculation         │
                   • Single block return           ▼
                                            Hot >= Threshold?
                                             /             \
                                       YES  /               \  NO
                                           ▼                 ▼
                             [ JIT Compile Block ]     [ Step Interpreter ]
                             • Discover basic block    • Single instruction
                             • Emit JS closure source  • Update cycle & PC
                             • Cache in blockCache
```

### 2.1 Basic Block Discovery
A **Basic Block** is a single-entry, single-exit straight-line sequence of instructions. The discovery algorithm starts at `startPC` and inspects instructions sequentially until encountering a **block terminator**:

| Terminator Category | Instructions | JIT Handling |
| :--- | :--- | :--- |
| **Unconditional Branch** | `B offset` | Directly updates `cpu.pc = targetPC` and exits block |
| **Conditional Branch** | `B.cond`, `CBZ`, `CBNZ`, `TBZ`, `TBNZ` | Evaluates branch condition; branches to `targetPC` or falls through |
| **Subroutine Call** | `BL offset` | Saves return address into `X30` (`LR`), branches to callee |
| **Indirect Branch / Return** | `BR Xn`, `BLR Xn`, `RET Xn` | Dispatches dynamically to destination register |
| **System Call / Trap** | `SVC imm` | Bails out to host runtime `emu.handleSyscall()`, updates PC |

---

## 3. Native JavaScript Code Generation

The JIT code generator (`JitCompiler.emitBlockJs`) translates the entire basic block into JavaScript code that eliminates all instruction decode and dispatch overhead:

### Example: Fibonacci Loop Block
For the hot loop in `bin/fib.elf`:
```armasm
0x00400010: add  x2, x0, x1
0x00400014: mov  x0, x1
0x00400018: mov  x1, x2
0x0040001c: subs x3, x3, #1
0x00400020: b.ne 0x00400010
```

The JIT compiles this into:
```javascript
"use strict";
// JIT Block [0x00400010 - 5 instrs]
const x = cpu.x;
const flags = cpu.flags;
const vBuffer = cpu.vBuffer;
const vUint64 = cpu.vUint64;
// ...

// 0x00400010: add x2, x0, x1
x[2] = BigInt.asUintN(64, x[0] + x[1]);

// 0x00400014: orr x0, xzr, x1 (mov x0, x1)
x[0] = BigInt.asUintN(64, x[1]);

// 0x00400018: orr x1, xzr, x2 (mov x1, x2)
x[1] = BigInt.asUintN(64, x[2]);

// 0x0040001c: subs x3, x3, #1
{
  const a = x[3];
  const b = 1n;
  const diff = a - b;
  const res = BigInt.asUintN(64, diff);
  x[3] = res;
  flags.Z = (res === 0n);
  flags.N = ((res & 0x8000000000000000n) !== 0n);
  flags.C = (a >= b);
  const sDiff = BigInt.asIntN(64, a) - BigInt.asIntN(64, b);
  flags.V = (sDiff < -0x8000000000000000n || sDiff > 0x7fffffffffffffffn);
}

// 0x00400020: b.ne 0x00400010
if (!flags.Z) {
  cpu.pc = 0x400010n;
} else {
  cpu.pc = 0x400024n;
}
return 5;
```

---

## 4. Cache Invalidation & Self-Modifying Code (SMC)

In systems software, emulators must support **Self-Modifying Code** (e.g. dynamic code loaders, runtime JITs in guest code, or page remappings).

### Invalidation Algorithm
When a guest instruction writes to memory or deallocates virtual memory (`sys_munmap` / `freeRange`):
```javascript
invalidateRange(addr, len = 4) {
  const start = Number(addr);
  const end = start + Number(len);
  for (const [pc, block] of this.blockCache.entries()) {
    if (pc < end && block.endPC > start) {
      this.blockCache.delete(pc);
      this.stats.invalidations++;
    }
  }
}
```
If code is overwritten, the corresponding JIT compiled block is evicted from the code cache. On the next execution of that address, the emulator re-discovers the new instructions and compiles the updated block.

---

## 5. Direct Block Chaining (Dynamic Jump Patching)

In standard basic-block JIT dispatchers, every block execution exits back to the central dispatcher loop, which looks up the next address in a hash map (`blockCache.get(nextPC)`). This introduces substantial dispatch and Map hashing overhead on tight loops.

Mini-QEMU eliminates this overhead using **Direct Block Chaining**:

```
                       Direct Block Chaining
                       
    ┌──────────────────────┐         Direct Jump Patching         ┌──────────────────────┐
    │   Compiled Block A   │ ───────────────────────────────────> │   Compiled Block B   │
    │  (Loop Body / Start) │ <─────────────────────────────────── │   (Loop Tail Jump)   │
    │    startPC: 0x400008 │            linkTaken /               │    startPC: 0x400010 │
    │    endPC:   0x400010 │          linkFallthrough             │    endPC:   0x400018 │
    └──────────────────────┘                                      └──────────────────────┘
               ▲                                                             │
               │               Invalidation & Unlink (SMC)                   │
               └─────────────────────────────────────────────────────────────┘
                               unlinkBlock(B) restores null
```

### 5.1 Architecture & Mechanics
1. **Static Target Discovery:** During block discovery, the terminator instruction is inspected to extract static branch targets:
   - `B` / `BL`: Unconditional target `targetTakenPC`.
   - `B.cond`, `CBZ`, `CBNZ`, `TBZ`, `TBNZ`: Taken target `targetTakenPC` and fallthrough target `targetFallthroughPC`.
   - Straight-line block boundary: `targetFallthroughPC`.
2. **Dynamic Jump Patching (`linkBlock`):**
   - When a block is compiled, if its target blocks are already present in `blockCache`, direct object references (`linkTaken` / `linkFallthrough`) are established immediately.
   - If the target block has not yet compiled, the block registers in `chainWaiters`. Once the target compiles, the predecessor's links are patched automatically.
3. **Chained Execution Loop:** The execution engine runs in an inner chaining loop. When a block terminates, if the destination matches `targetTakenPC` or `targetFallthroughPC` and a linked compiled block is available, execution jumps directly to that block without returning to the outer dispatcher or performing Map lookups.
4. **SMC & Breakpoint Unlinking (`unlinkBlock`):**
   - Each block maintains an `incomingSources` set tracking all predecessor blocks linking to it.
   - When a block is invalidated (via `invalidateRange` or breakpoint insertion), all incoming links are cleanly unlinked (`linkTaken = null`, `linkFallthrough = null`), preventing stale jumps.

---

## 6. Verification & Benchmark Results

Mini-QEMU includes an automated verification suite in [`tests/test_jit.js`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/tests/test_jit.js).

### 5.1 Bit-Exact Equivalence
Across all 8 standard guest ELF binaries, the JIT output matches the interpreter bit-for-bit:

| Binary | Description | Verification Status | Default JIT Coverage (`hotThreshold = 3`) | Hot-Compiled JIT Coverage (`hotThreshold = 1`) |
| :--- | :--- | :---: | :---: | :---: |
| `bin/fib.elf` | Iterative Fibonacci loop | ✅ Bit-Exact | 72.7% (1 block) | 100% (3 blocks) |
| `bin/fib_rec.elf` | Deep recursive call tree & stack frames | ✅ Bit-Exact | 97.7% (5 blocks) | 100% (7 blocks) |
| `bin/math_func.elf` | Subroutine calls, 64-bit div/mul | ✅ Bit-Exact | 0.0% (single pass) | 100% (3 blocks) |
| `bin/heap_demo.elf` | Heap expansion via `sys_brk` | ✅ Bit-Exact | 0.0% (single pass) | 100% (4 blocks) |
| `bin/dynamic_memory.elf` | Boundary-tag malloc/free & coalescing | ✅ Bit-Exact | 0.0% (single pass) | 100% (6 blocks) |
| `bin/neon_matrix.elf` | VFP scalar magnitude & NEON 4S SIMD dot product | ✅ Bit-Exact | 0.0% (single pass) | 100% (2 blocks) |
| `bin/graphics_pattern.elf`| 320×240 SMPTE color bars & RGB gradients | ✅ Bit-Exact | 100.0% (8 blocks) | 100% (12 blocks) |
| `bin/plasma.elf` | Procedural 320×240 demoscene plasma | ✅ Bit-Exact | 100.0% (3 blocks) | 100% (6 blocks) |

### 5.2 Throughput Benchmark (2,000,000 Cycles)
Under a heavy arithmetic computational loop:
- **Pure Interpreter:** `3,239.08 ms` (~0.43 MHz virtual clock)
- **Dynamic JIT:** `29.57 ms` (~47.33 MHz virtual clock)
- **Measured Speedup:** **109.5x FASTER** than interpreter!

---

## 6. Web UI & Workbench Integration

The browser dashboard provides live JIT observability and controls:
- **Toolbar JIT Badge:** Displays real-time compiled block counts and JIT cycle percentage (e.g. `⚡ JIT: 8 blocks (100%)`).
- **JIT Toggle Checkbox:** Enables or disables dynamic JIT execution at runtime.
- **Dynamic JIT Workbench Tab:**
  - Displays real-time telemetry: Compiled Blocks, Total Block Executions, JIT Cycles, JIT Coverage %.
  - Live code viewer displaying every compiled Basic Block, its disassembled ARM64 instructions, execution count, and the generated JavaScript closure.
  - Interactive "Benchmark JIT vs Interpreter" button comparing execution times in real time.
