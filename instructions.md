# ARM64 (AArch64) Instruction Set Architecture Reference

The complete ARM64 Instruction Set Reference for Mini-QEMU is maintained in:

👉 **[docs/instructions.md](docs/instructions.md)**

It covers:
- **75+ Implemented Instructions:** Integer arithmetic, branch & control flow, stack pairs, bitfield manipulation, system calls/TLS, scalar floating-point (VFP), and 128-bit NEON Advanced SIMD.
- **Architectural State:** 31 64-bit general-purpose registers (`X0`–`X30` / `W0`–`W30`), 32 128-bit vector registers (`V0`–`V31` / `Q0`–`Q31` / `D0`–`D31` / `S0`–`S31`), `SP`, `PC`, and status registers (`NZCV`, `FPCR`, `FPSR`).
- **Addressing Modes:** Scaled unsigned, unscaled signed (`LDUR`/`STUR`), pre-indexed (`!`), post-indexed, and register-offset.
- **Condition Codes:** Full evaluation table for all 15 condition suffixes (`EQ`, `NE`, `CS`, `CC`, `MI`, `PL`, `VS`, `VC`, `HI`, `LS`, `GE`, `LT`, `GT`, `LE`, `AL`) plus IEEE-754 `FCMP` flag ordering.
- **Dual Execution Engine Mapping:** Comparative implementation breakdown across the software Interpreter, Static AOT Recompiler (JS), and ARM-to-x86-64 Translator (Intel assembly / SSE).
