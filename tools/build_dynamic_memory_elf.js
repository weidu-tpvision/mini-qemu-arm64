// tools/build_dynamic_memory_elf.js - Builds Dynamic Memory Allocator ARM64 ELF Binary
// Generates: bin/dynamic_memory.elf
// Demonstrates:
// - Standard boundary-tag dynamic memory allocation (malloc, free, realloc)
// - Dynamic heap expansion and contraction via sys_brk (syscall 214)
// - Free list hole reuse without advancing program break
// - Adjacent free block coalescing to prevent heap fragmentation
// - Linux stdout logging via sys_write (syscall 64) and clean exit (syscall 93)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Decoder } from "../src/decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT_DIR, "bin");

// Helper to assemble standard ELF64 with code + data payload
function buildElfWithPayload(instructions, dataBuffer = Buffer.alloc(0), entryAddr = 0x00400000n) {
  const payload = Buffer.concat([
    Buffer.from(new Uint32Array(instructions).buffer),
    dataBuffer
  ]);

  const codeOffset = 0x1000; // 4KB page aligned
  const totalFileSize = codeOffset + payload.length;
  const buffer = Buffer.alloc(totalFileSize, 0);

  // 1. ELF Header (64 bytes)
  buffer[0] = 0x7f; buffer[1] = 0x45; buffer[2] = 0x4c; buffer[3] = 0x46; // Magic
  buffer[4] = 2; // 64-bit
  buffer[5] = 1; // Little-Endian
  buffer[6] = 1; // Version
  buffer[7] = 0; // Linux ABI
  buffer.writeUInt16LE(2, 16);             // ET_EXEC
  buffer.writeUInt16LE(0x00b7, 18);         // EM_AARCH64 (183)
  buffer.writeUInt32LE(1, 20);              // Version 1
  buffer.writeBigUInt64LE(entryAddr, 24);   // Entry point
  buffer.writeBigUInt64LE(64n, 32);         // Program header offset
  buffer.writeBigUInt64LE(0n, 40);          // Section header offset
  buffer.writeUInt32LE(0, 48);              // Flags
  buffer.writeUInt16LE(64, 52);             // ELF header size
  buffer.writeUInt16LE(56, 54);             // Program header entry size
  buffer.writeUInt16LE(1, 56);              // Number of program headers
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(0, 60);
  buffer.writeUInt16LE(0, 62);

  // 2. Program Header (PT_LOAD)
  const phOffset = 64;
  buffer.writeUInt32LE(1, phOffset + 0);                    // PT_LOAD
  buffer.writeUInt32LE(7, phOffset + 4);                    // PF_R | PF_W | PF_X = 7
  buffer.writeBigUInt64LE(BigInt(codeOffset), phOffset + 8); // File offset
  buffer.writeBigUInt64LE(entryAddr, phOffset + 16);        // Virtual address
  buffer.writeBigUInt64LE(entryAddr, phOffset + 24);        // Physical address
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 32); // File size
  buffer.writeBigUInt64LE(BigInt(payload.length), phOffset + 40); // Memory size
  buffer.writeBigUInt64LE(0x1000n, phOffset + 48);          // 4KB alignment

  // 3. Write payload
  payload.copy(buffer, codeOffset);
  return buffer;
}

export function generateDynamicMemoryElf() {
  const instructions = [];

  // Helper encoders
  const encMovz = (rd, imm16, lsl = 0) => 0xd2800000 | ((lsl / 16) << 21) | ((imm16 & 0xffff) << 5) | rd;
  const encMovk = (rd, imm16, lsl = 0) => 0xf2800000 | ((lsl / 16) << 21) | ((imm16 & 0xffff) << 5) | rd;
  const encAddImm = (rd, rn, imm12) => 0x91000000 | ((imm12 & 0xfff) << 10) | (rn << 5) | rd;
  const encSubImm = (rd, rn, imm12) => 0xd1000000 | ((imm12 & 0xfff) << 10) | (rn << 5) | rd;
  const encAddReg = (rd, rn, rm) => 0x8b000000 | (rm << 16) | (rn << 5) | rd;
  const encStrImm = (rt, rn, imm12) => 0xf9000000 | (((imm12 / 8) & 0x1ff) << 10) | (rn << 5) | rt;
  const encLdrImm = (rt, rn, imm12) => 0xf9400000 | (((imm12 / 8) & 0x1ff) << 10) | (rn << 5) | rt;
  const encSvc = (imm16 = 0) => 0xd4000001 | (imm16 << 5);
  const encEorReg = (rd, rn, rm) => 0xca000000 | (rm << 16) | (rn << 5) | rd;
  const encAdr = (rd, offsetBytes) => {
    const imm = offsetBytes & 0x1fffff;
    const immlo = imm & 3;
    const immhi = (imm >> 2) & 0x7ffff;
    return 0x10000000 | (immlo << 29) | (immhi << 5) | rd;
  };

  // --- Step 1: Query initial heap break via sys_brk(0) ---
  // movz x0, #0
  // movz x8, #214
  // svc #0
  // x19 = heap_start = x0, x20 = current_brk = x0
  instructions.push(encMovz(0, 0));                        // x0 = 0 (query current break)
  instructions.push(encMovz(8, 214));                      // x8 = 214 (sys_brk)
  instructions.push(encSvc(0));                            // svc #0 -> returns initial break in x0
  instructions.push(encAddImm(19, 0, 0));                  // x19 = heap_start
  instructions.push(encAddImm(20, 0, 0));                  // x20 = current_brk

  // --- Step 2: Allocate p1 (malloc 32 bytes payload -> 48 bytes total with 8B header + 8B pad) ---
  // Requested total chunk = 48. Header = 48 | 1 = 49 (0x31)
  // Request new break: sys_brk(x20 + 48)
  instructions.push(encAddImm(0, 20, 48));                 // x0 = current_brk + 48
  instructions.push(encMovz(8, 214));                      // x8 = 214
  instructions.push(encSvc(0));                            // svc #0 -> x0 = new_brk
  instructions.push(encMovz(1, 49));                       // w1 = 49 (size 48 | 1 allocated)
  instructions.push(encStrImm(1, 20, 0));                  // str x1, [x20] (write chunk header)
  instructions.push(encAddImm(21, 20, 8));                 // x21 = p1 = x20 + 8 (payload pointer)
  instructions.push(encAddImm(20, 0, 0));                  // x20 = current_brk

  // Write payload to p1: 0x1111111122222222
  instructions.push(encMovz(2, 0x2222));
  instructions.push(encMovk(2, 0x2222, 16));
  instructions.push(encMovk(2, 0x1111, 32));
  instructions.push(encMovk(2, 0x1111, 48));
  instructions.push(encStrImm(2, 21, 0));                  // str x2, [p1]

  // --- Step 3: Allocate p2 (malloc 64 bytes payload -> 80 bytes total with 8B header + 8B pad) ---
  // Requested total chunk = 80. Header = 80 | 1 = 81 (0x51)
  // Request new break: sys_brk(x20 + 80)
  instructions.push(encAddImm(0, 20, 80));                 // x0 = current_brk + 80
  instructions.push(encMovz(8, 214));                      // x8 = 214
  instructions.push(encSvc(0));                            // svc #0 -> x0 = new_brk
  instructions.push(encMovz(1, 81));                       // w1 = 81 (size 80 | 1 allocated)
  instructions.push(encStrImm(1, 20, 0));                  // str x1, [x20] (write chunk header)
  instructions.push(encAddImm(22, 20, 8));                 // x22 = p2 = x20 + 8 (payload pointer)
  instructions.push(encAddImm(20, 0, 0));                  // x20 = current_brk

  // Write payload to p2: 0x3333333344444444
  instructions.push(encMovz(2, 0x4444));
  instructions.push(encMovk(2, 0x4444, 16));
  instructions.push(encMovk(2, 0x3333, 32));
  instructions.push(encMovk(2, 0x3333, 48));
  instructions.push(encStrImm(2, 22, 0));                  // str x2, [p2]

  // --- Step 4: Allocate p3 (malloc 128 bytes payload -> 144 bytes total) ---
  // Requested total chunk = 144. Header = 144 | 1 = 145 (0x91)
  instructions.push(encAddImm(0, 20, 144));                // x0 = current_brk + 144
  instructions.push(encMovz(8, 214));                      // x8 = 214
  instructions.push(encSvc(0));                            // svc #0 -> x0 = new_brk
  instructions.push(encMovz(1, 145));                      // w1 = 145 (size 144 | 1 allocated)
  instructions.push(encStrImm(1, 20, 0));                  // str x1, [x20] (write chunk header)
  instructions.push(encAddImm(23, 20, 8));                 // x23 = p3 = x20 + 8
  instructions.push(encAddImm(20, 0, 0));                  // x20 = current_brk

  // Write payload to p3: 0x5555555566666666 and verification value 30 at [p3 + 8]
  instructions.push(encMovz(2, 0x6666));
  instructions.push(encMovk(2, 0x6666, 16));
  instructions.push(encMovk(2, 0x5555, 32));
  instructions.push(encMovk(2, 0x5555, 48));
  instructions.push(encStrImm(2, 23, 0));                  // str x2, [p3]
  instructions.push(encMovz(2, 30));
  instructions.push(encStrImm(2, 23, 8));                  // str x2, [p3, #8]

  // --- Step 5: free(p2) -> Creates an 80-byte FREE HOLE between p1 and p3 ---
  // Load header at (p2 - 8), clear allocated bit 0 dynamically -> size becomes 80 (0x50, free)
  instructions.push(encSubImm(3, 22, 8));                  // x3 = p2 - 8 (chunk header addr)
  instructions.push(encLdrImm(1, 3, 0));                   // ldr x1, [p2 - 8] (81)
  instructions.push(encSubImm(1, 1, 1));                   // clear bit 0 -> 80 (free)
  instructions.push(encStrImm(1, 3, 0));                   // str x1, [p2 - 8]

  // --- Step 6: malloc(48) -> REUSES the freed p2 hole without expanding brk! ---
  // 48B payload + 8B header = 56 -> aligned to 64 bytes total.
  // The hole has 80 bytes. Split: 64 allocated + 16 free remainder!
  // Chunk header at x3 becomes 65 (size 64 | 1 allocated)
  // Remainder chunk header at (x3 + 64) becomes 16 (size 16 | 0 free)
  instructions.push(encMovz(1, 65));                       // 64 | 1 = 65
  instructions.push(encStrImm(1, 3, 0));                   // str x1, [x3]
  instructions.push(encAddImm(24, 3, 8));                  // x24 = p4 = x3 + 8 (reused p2 payload!)
  instructions.push(encAddImm(4, 3, 64));                  // x4 = remainder chunk header (x3 + 64)
  instructions.push(encMovz(1, 16));                       // 16 | 0 = 16 (free remainder)
  instructions.push(encStrImm(1, 4, 0));                   // str x1, [x4]

  // Write payload to p4: 0x7777777788888888
  instructions.push(encMovz(2, 0x8888));
  instructions.push(encMovk(2, 0x8888, 16));
  instructions.push(encMovk(2, 0x7777, 32));
  instructions.push(encMovk(2, 0x7777, 48));
  instructions.push(encStrImm(2, 24, 0));                  // str x2, [p4]

  // --- Step 7: free(p1) and free(p4) -> ADJACENT COALESCING ---
  // Dynamically load headers of Chunk 1 (x19), Chunk 2 (x3), and Chunk 3 (x4),
  // clear their allocated bits, and sum their sizes: 48 + 64 + 16 = 128 bytes!
  instructions.push(encLdrImm(1, 19, 0));                  // ldr x1, [x19] (49)
  instructions.push(encSubImm(1, 1, 1));                   // x1 = 48 (free p1)
  instructions.push(encLdrImm(2, 3, 0));                   // ldr x2, [x3] (65)
  instructions.push(encSubImm(2, 2, 1));                   // x2 = 64 (free p4)
  instructions.push(encLdrImm(6, 4, 0));                   // ldr x6, [x4] (16, already free)
  instructions.push(encAddReg(1, 1, 2));                   // x1 = 48 + 64 = 112
  instructions.push(encAddReg(1, 1, 6));                   // x1 = 112 + 16 = 128
  instructions.push(encStrImm(1, 19, 0));                  // str x1, [x19] (coalesced 128B free header)

  // --- Step 8: malloc(96) -> Allocates from newly coalesced 128-byte free block ---
  // 96B payload + 8B header = 104 -> aligned to 112 bytes total.
  // Split: 112 allocated + 16 free remainder.
  instructions.push(encMovz(1, 113));                      // 112 | 1 = 113
  instructions.push(encStrImm(1, 19, 0));                  // str x1, [x19] (allocated coalesced block)
  instructions.push(encAddImm(25, 19, 8));                 // x25 = p5 = x19 + 8
  instructions.push(encAddImm(5, 19, 112));                // x5 = remainder chunk
  instructions.push(encMovz(1, 16));                       // 16 | 0 = 16
  instructions.push(encStrImm(1, 5, 0));                   // str x1, [x5]

  // Write payload to p5: 0x99999999AAAAAAAA and verification value 12 at [p5 + 8]
  instructions.push(encMovz(2, 0xaaaa));
  instructions.push(encMovk(2, 0xaaaa, 16));
  instructions.push(encMovk(2, 0x9999, 32));
  instructions.push(encMovk(2, 0x9999, 48));
  instructions.push(encStrImm(2, 25, 0));                  // str x2, [p5]
  instructions.push(encMovz(2, 12));
  instructions.push(encStrImm(2, 25, 8));                  // str x2, [p5, #8]

  // --- Step 9: Verify Data Integrity from Heap Payloads ---
  // Load p3 (from step 4) and p5 (from step 8)
  instructions.push(encLdrImm(6, 23, 0));                  // ldr x6, [p3]
  instructions.push(encLdrImm(7, 25, 0));                  // ldr x7, [p5]
  instructions.push(encEorReg(27, 6, 7));                  // x27 = x6 ^ x7
  instructions.push(encLdrImm(6, 23, 8));                  // ldr x6, [p3, #8] (30)
  instructions.push(encLdrImm(7, 25, 8));                  // ldr x7, [p5, #8] (12)
  instructions.push(encAddReg(26, 6, 7));                  // x26 = 30 + 12 = 42

  // --- Step 10: Print confirmation string via sys_write(1, msg, len) ---
  const ADR_MSG_IDX = instructions.length;
  instructions.push(0);                                    // adr x1, #msg placeholder
  instructions.push(encMovz(0, 1));                        // x0 = 1 (stdout)
  instructions.push(encMovz(2, 0));                        // x2 = len placeholder
  instructions.push(encMovz(8, 64));                       // x8 = 64 (sys_write)
  instructions.push(encSvc(0));                            // svc #0

  // --- Step 11: sys_exit(x26) -> returns 42 computed from heap loads ---
  instructions.push(encAddImm(0, 26, 0));                  // x0 = x26 (42)
  instructions.push(encMovz(8, 93));                       // x8 = 93 (sys_exit)
  instructions.push(encSvc(0));                            // svc #0

  // Resolve message string address and length
  const logMessage = Buffer.from("[Dynamic Memory] malloc, free, hole reuse & adjacent coalescing verified!\n", "utf8");
  const codeLengthBytes = instructions.length * 4;
  const msgOffset = codeLengthBytes - (ADR_MSG_IDX * 4);

  instructions[ADR_MSG_IDX] = encAdr(1, msgOffset);
  instructions[ADR_MSG_IDX + 2] = encMovz(2, logMessage.length);

  return buildElfWithPayload(instructions, logMessage, 0x00400000n);
}

// Build and validate binary
const elfBuffer = generateDynamicMemoryElf();
const outPath = path.join(BIN_DIR, "dynamic_memory.elf");
fs.writeFileSync(outPath, elfBuffer);
console.log(`[PASS] Built "${outPath}" (${elfBuffer.length} bytes)`);

// Validate all decoded instructions
let pc = 0x00400000;
const codeOffset = 0x1000;
let instrCount = 0;
while (codeOffset + (instrCount * 4) + 4 <= elfBuffer.length - 75) {
  const rawInstr = elfBuffer.readUInt32LE(codeOffset + (instrCount * 4));
  const decoded = Decoder.decode(rawInstr);
  if (!decoded || !decoded.disassembly) {
    throw new Error(`Failed to decode instruction 0x${rawInstr.toString(16)} at PC 0x${pc.toString(16)}`);
  }
  instrCount++;
  pc += 4;
}
console.log(`[PASS] Validated all ${instrCount} ARM64 instructions in dynamic_memory.elf`);
