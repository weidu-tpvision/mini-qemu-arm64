// tools/build_fib_rec_elf.js - Generates fib_rec.elf (Recursive Fibonacci(10) = 55)
// Tests: BL recursion, STP (pre-indexed stack push), LDP (post-indexed stack pop),
// STR/LDR local variable spilling, CMP, B.GT, and RET.
import fs from "fs";

function buildFibRecElf() {
  const instructions = [
    // === _start (0x00400000) ===
    0xd2800140, // 0x00: movz x0, #10                 ; Arg n = 10
    0x94000003, // 0x04: bl +12                       ; Call fib(10) at 0x00400010
    0xd2800ba8, // 0x08: movz x8, #93                 ; Linux AArch64 sys_exit (93)
    0xd4000001, // 0x0c: svc #0                       ; Exit with X0 (55)

    // === fib(long n) (0x00400010) ===
    0xf100041f, // 0x10: cmp x0, #1                   ; Compare n with 1
    0x5400004c, // 0x14: b.gt +8                      ; If n > 1, jump to recursive step (0x1c)
    0xd65f03c0, // 0x18: ret                          ; Base case (n <= 1): return n in X0

    // === Recursive Step (0x0040001c) ===
    0xa9be7bfd, // 0x1c: stp x29, x30, [sp, #-32]!    ; Pre-index: allocate 32B frame & save FP/LR
    0xf9000be0, // 0x20: str x0, [sp, #16]            ; Spill n to stack [sp + 16]
    0xd1000400, // 0x24: sub x0, x0, #1               ; x0 = n - 1
    0x97fffffa, // 0x28: bl -24                       ; Recursive call: fib(n - 1) at 0x00400010
    0xf9400be1, // 0x2c: ldr x1, [sp, #16]            ; Reload n into x1
    0xf9000fe0, // 0x30: str x0, [sp, #24]            ; Spill fib(n - 1) result to [sp + 24]
    0xd1000820, // 0x34: sub x0, x1, #2               ; x0 = n - 2
    0x97fffff6, // 0x38: bl -40                       ; Recursive call: fib(n - 2) at 0x00400010
    0xf9400fe1, // 0x3c: ldr x1, [sp, #24]            ; Reload fib(n - 1) into x1
    0x8b000020, // 0x40: add x0, x1, x0               ; x0 = fib(n - 1) + fib(n - 2)
    0xa8c27bfd, // 0x44: ldp x29, x30, [sp], #32      ; Post-index: restore FP/LR & free 32B frame
    0xd65f03c0, // 0x48: ret                          ; Return to caller (PC = X30)
  ];

  const codeSize = instructions.length * 4;
  const headerSize = 64;
  const phdrSize = 56;
  const codeOffset = headerSize + phdrSize; // 120 (0x78)
  const totalSize = codeOffset + codeSize;

  const buf = Buffer.alloc(totalSize, 0);

  // 1. ELF64 Header
  buf.writeUInt8(0x7f, 0);
  buf.write("ELF", 1, 3, "ascii");
  buf.writeUInt8(2, 4); // 64-bit
  buf.writeUInt8(1, 5); // Little endian
  buf.writeUInt8(1, 6); // ELF version 1
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeUInt16LE(0xb7, 18); // EM_AARCH64 (183)
  buf.writeUInt32LE(1, 20); // EV_CURRENT
  buf.writeBigUInt64LE(0x00400000n, 24); // e_entry
  buf.writeBigUInt64LE(64n, 32); // e_phoff
  buf.writeUInt16LE(64, 52); // e_ehsize
  buf.writeUInt16LE(56, 54); // e_phentsize
  buf.writeUInt16LE(1, 56); // e_phnum

  // 2. Program Header (PT_LOAD)
  const ph = 64;
  buf.writeUInt32LE(1, ph + 0); // PT_LOAD
  buf.writeUInt32LE(5, ph + 4); // PF_R | PF_X
  buf.writeBigUInt64LE(BigInt(codeOffset), ph + 8); // p_offset
  buf.writeBigUInt64LE(0x00400000n, ph + 16); // p_vaddr
  buf.writeBigUInt64LE(0x00400000n, ph + 24); // p_paddr
  buf.writeBigUInt64LE(BigInt(codeSize), ph + 32); // p_filesz
  buf.writeBigUInt64LE(BigInt(codeSize), ph + 40); // p_memsz
  buf.writeBigUInt64LE(0x1000n, ph + 48); // p_align

  // 3. Machine Code Payload
  for (let i = 0; i < instructions.length; i++) {
    buf.writeUInt32LE(instructions[i] >>> 0, codeOffset + i * 4);
  }

  fs.mkdirSync("bin", { recursive: true });
  fs.writeFileSync("bin/fib_rec.elf", buf);
  console.log(`[Builder] Generated bin/fib_rec.elf (${totalSize} bytes, ${instructions.length} instructions)`);
}

buildFibRecElf();
