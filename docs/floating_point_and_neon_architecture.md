# Mini-QEMU ARM64: Floating-Point & NEON Advanced SIMD Architecture

## 1. Executive Summary

This document describes the architectural implementation of **Floating-Point (Scalar VFP)** and **NEON Advanced SIMD (128-bit Vector)** processing in the educational Mini-QEMU AArch64 emulator.

With this feature set, Mini-QEMU supports high-performance linear algebra, 3D graphics, demoscene rendering, audio processing, and machine learning kernels compiled for ARM64.

---

## 2. Register File Architecture

ARM64 defines 32 architectural vector registers (`V0` to `V31`). Each vector register is 128 bits (16 bytes) wide and is aliased with scalar precision registers:

```
127                             63              31       0
+-------------------------------+---------------+--------+
|                               |               |  Bn    |  8-bit Byte
+-------------------------------+---------------+--------+
|                               |               |  Hn    |  16-bit Halfword
+-------------------------------+---------------+--------+
|                               |               |  Sn    |  32-bit Single Float
+-------------------------------+---------------+--------+
|                               |       Dn               |  64-bit Double Float
+-------------------------------+------------------------+
|                               Qn / Vn                  |  128-bit Quadword / Vector
+--------------------------------------------------------+
```

### In-Memory Memory Mapping & Typed Views
In [`src/cpu.js`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/cpu.js), the 32 vector registers are backed by a single contiguous 512-byte `ArrayBuffer`:

```javascript
this.vBuffer = new ArrayBuffer(32 * 16);
this.vBytes   = new Uint8Array(this.vBuffer);    // 8-bit byte elements
this.vUint16  = new Uint16Array(this.vBuffer);   // 16-bit halfword elements
this.vUint32  = new Uint32Array(this.vBuffer);   // 32-bit single word / bitwise
this.vInt32   = new Int32Array(this.vBuffer);    // 32-bit signed integer elements
this.vUint64  = new BigUint64Array(this.vBuffer);// 64-bit doubleword / bitwise
this.vFloat32 = new Float32Array(this.vBuffer);  // 32-bit IEEE-754 single float
this.vFloat64 = new Float64Array(this.vBuffer);  // 64-bit IEEE-754 double float
```

### Zeroing Rules
Per ARM64 specifications:
- Writing to a scalar `Sn` register writes to `vFloat32[n * 4]` and **clears the upper 96 bits** of `Vn`.
- Writing to a scalar `Dn` register writes to `vFloat64[n * 2]` and **clears the upper 64 bits** of `Vn`.

---

## 3. Instruction Set Support

### 3.1 Scalar Floating-Point Arithmetic
| Instruction | Mnemonic | Precision | Description |
|---|---|---|---|
| `FADD` | `fadd Sd, Sn, Sm` / `fadd Dd, Dn, Dm` | Single / Double | IEEE-754 floating-point addition |
| `FSUB` | `fsub Sd, Sn, Sm` / `fsub Dd, Dn, Dm` | Single / Double | IEEE-754 floating-point subtraction |
| `FMUL` | `fmul Sd, Sn, Sm` / `fmul Dd, Dn, Dm` | Single / Double | IEEE-754 floating-point multiplication |
| `FDIV` | `fdiv Sd, Sn, Sm` / `fdiv Dd, Dn, Dm` | Single / Double | IEEE-754 floating-point division |
| `FNMUL`| `fnmul Sd, Sn, Sm` / `fnmul Dd, Dn, Dm`| Single / Double | Negated multiplication `-(Sn * Sm)` |
| `FNEG` | `fneg Sd, Sn` / `fneg Dd, Dn` | Single / Double | Float negation |
| `FABS` | `fabs Sd, Sn` / `fabs Dd, Dn` | Single / Double | Absolute value |
| `FSQRT`| `fsqrt Sd, Sn` / `fsqrt Dd, Dn` | Single / Double | Square root |
| `FMAX` / `FMIN` | `fmax`/`fmin` | Single / Double | Maximum / minimum with IEEE NaN propagation |

### 3.2 Floating-Point Comparison (`FCMP`)
Evaluates two float operands (or an operand against `#0.0`) and updates condition flags in `PSTATE.NZCV`:
- **Unordered (NaN)**: `N=0, Z=0, C=0, V=1`
- **Equal (`==`)**: `N=0, Z=1, C=1, V=0`
- **Less Than (`<`)**: `N=1, Z=0, C=0, V=0`
- **Greater Than (`>`)**: `N=0, Z=0, C=1, V=0`

This enables all existing conditional branches (`B.EQ`, `B.NE`, `B.LT`, `B.LE`, `B.GT`, `B.GE`) to evaluate floating-point results naturally.

### 3.3 Conversions & Moves
- **`SCVTF`**: Signed integer to float (`scvtf d0, x1`, `scvtf s0, w1`).
- **`UCVTF`**: Unsigned integer to float (`ucvtf d0, x1`).
- **`FCVTZS`**: Float to signed integer with truncation toward zero (`fcvtzs x0, d1`, `fcvtzs w0, s1`).
- **`FCVTZU`**: Float to unsigned integer with truncation toward zero.
- **`FCVT`**: Float precision conversion (Single $\leftrightarrow$ Double: `fcvt d0, s1`, `fcvt s0, d1`).
- **`FMOV`**:
  - Register-to-register copy (`fmov d0, d1`).
  - Bitwise GPR $\leftrightarrow$ FPR bitcasts (`fmov x0, d1`, `fmov d0, x1`, `fmov w0, s1`, `fmov s0, w1`).
  - Immediate load (`fmov s0, #1.0`, `fmov d0, #2.0`).

### 3.4 NEON Advanced SIMD Vector Operations
- **Vector Arithmetic**:
  - `FMUL_VEC`: Element-wise multiply (`fmul v0.4s, v1.4s, v2.4s`, `fmul v0.2d, v1.2d, v2.2d`).
  - `FADD_VEC`: Element-wise add (`fadd v0.4s, v1.4s, v2.4s`).
  - `FSUB_VEC`: Element-wise subtract (`fsub v0.4s, v1.4s, v2.4s`).
  - `FDIV_VEC`: Element-wise divide (`fdiv v0.4s, v1.4s, v2.4s`).
  - `FADDP_VEC`: Pairwise reduction add (`faddp v0.4s, v1.4s, v2.4s`), essential for dot products and matrix multiplications.
  - `ADD_VEC`, `SUB_VEC`, `MUL_VEC`: Integer vector arithmetic (`.16b`, `.8h`, `.4s`, `.2d`).
  - `AND_VEC`, `ORR_VEC`, `EOR_VEC`, `NOT_VEC`: 128-bit bitwise logic.
- **Splat & Element Manipulation**:
  - `DUP_ELEM`: Splat vector lane into vector (`dup v0.4s, v1.s[0]`).
  - `DUP_GEN`: Splat general register into all vector lanes (`dup v0.4s, w1`).
  - `INS_GEN`: Insert general register value into vector lane (`ins v0.s[2], w1`).
  - `UMOV_ELEM`: Extract vector lane to general register (`umov w0, v1.s[1]`).

### 3.5 Loads and Stores
- **Single FP**: `LDR St, [Xn, #imm]`, `STR St, [Xn, #imm]`, `LDR Dt, [Xn, #imm]`, `STR Dt, [Xn, #imm]`.
- **128-bit Vector**: `LDR Qt, [Xn, #imm]`, `STR Qt, [Xn, #imm]`.
- **Pair Load/Store**: `LDP Dt1, Dt2, [Xn]`, `STP Dt1, Dt2, [Xn]`, `LDP Qt1, Qt2, [Xn]`, `STP Qt1, Qt2, [Xn]`.

---

## 4. Binary Translators Integration

### 4.1 Static AOT Recompiler ([`src/static_recompiler.js`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/static_recompiler.js))
Lifts ARM64 instructions directly into native JavaScript using typed arrays:
```javascript
vFloat64[0] = Math.sqrt(vFloat64[8]); // fsqrt d0, d4
for (let i = 0; i < 4; i++) vFloat32[12 + i] = vFloat32[4 + i] * vFloat32[8 + i]; // fmul v3.4s, v1.4s, v2.4s
```
Zero interpretive overhead; executes at near native JIT speeds.

### 4.2 x86-64 Binary Translator ([`src/arm2x86.js`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/arm2x86.js))
Maps ARM64 `V0`–`V31` directly to Intel SSE / AVX registers (`xmm0`–`xmm15`):
- `fadd d0, d1, d2` $\rightarrow$ `movsd xmm0, xmm1 ; addsd xmm0, xmm2`
- `fmul v0.4s, v1.4s, v2.4s` $\rightarrow$ `movaps xmm0, xmm1 ; mulps xmm0, xmm2`
- `faddp v0.4s, v1.4s, v2.4s` $\rightarrow$ `movaps xmm0, xmm1 ; haddps xmm0, xmm2`
- `ldr q0, [x1]` $\rightarrow$ `movdqu xmm0, [rcx]`

---

## 5. Web UI Floating-Point & NEON Register Inspector

In the browser UI ([`ui/index.html`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/ui/index.html)):
- Panel 1 includes a sub-tab toggle: `[GPR (X0–X30)]` and `[FP / NEON (V0–V31)]`.
- The FP / NEON table displays:
  - Vector name (`V0`..`V31`) with aliased scalar labels (`D0` / `S0`).
  - Scalar Double (`D`) and Single (`S`) float values formatted with precision.
  - 128-bit NEON vector values formatted as 4-element single float array `[f0, f1, f2, f3]`.
- When loading a NEON or floating-point binary (e.g. `neon_matrix.elf`), the UI automatically switches to the FP / NEON register view.

---

## 6. Verification & Test Suite

The feature is verified by [`tests/test_neon_fp.js`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/tests/test_neon_fp.js) and the benchmark binary [`bin/neon_matrix.elf`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/bin/neon_matrix.elf):
1. **Scalar 3D Pythagorean Magnitude**:
   $$M = \sqrt{3^2 + 4^2 + 12^2} = \sqrt{9 + 16 + 144} = \sqrt{169} = 13.0$$
2. **NEON 4×Float32 Vector Dot Product**:
   $$V_1 = [1.0, 2.0, 3.0, 4.0], \quad V_2 = [10.0, 20.0, 30.0, 40.0]$$
   $$V_1 \cdot V_2 = (1 \times 10) + (2 \times 20) + (3 \times 30) + (4 \times 40) = 10 + 40 + 90 + 160 = 300.0$$
3. Exit code computation: $300 - 271 + 13 = 42$.
4. All 9 test suites in `npm test` pass with 100% success rate.
