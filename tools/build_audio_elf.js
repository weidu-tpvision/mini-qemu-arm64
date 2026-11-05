// tools/build_audio_elf.js - Builds Bare-Metal ARM64 Audio Synthesizer & PCM Generator ELF Binary
// Generates: bin/audio_synth.elf
// Features:
// 1. Programs MMIO Chiptune PSG:
//    - Channel 0: Melodic Pulse Wave (Arpeggio notes C4 262Hz, E4 330Hz, G4 392Hz, C5 523Hz)
//    - Channel 1: Bass Triangle Wave (C3 131Hz)
//    - Channel 2: Percussion Noise Burst
// 2. Synthesizes a 16-sample periodic PCM buffer directly into AUDIO_RING_BASE (0x00870000)
//    and updates AUDIO_REG_WRITE_PTR.
// 3. Advances through musical frames using sys_sched_yield (124) and exits cleanly via sys_exit (93).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Decoder } from "../src/decoder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT_DIR, "bin");

// Helper to assemble standard ELF64
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

  // 3. Write payload at codeOffset
  payload.copy(buffer, codeOffset);

  return buffer;
}

export function generateAudioElf() {
  const instructions = [];

  // --- Register Allocation ---
  // X20: AUDIO_BASE (0x00860000)
  // X21: AUDIO_RING_BASE (0x00870000)
  // W0 - W7: Scratch values and arguments
  // W19: Frame loop counter

  // 1. Initialize Base Addresses
  // movz x20, #0x86, lsl #16 -> 0x00860000
  instructions.push(0xd2a010d4);
  // movz x21, #0x87, lsl #16 -> 0x00870000
  instructions.push(0xd2a010f5);

  // 2. Set Control Register = 1 (Play)
  // movz w0, #1
  instructions.push(0x52800020);
  // str w0, [x20, #4] (AUDIO_REG_CONTROL)
  instructions.push(0xb9000680);

  // 3. Set Format = 44100 Hz, 1 channel, 16-bit (0x1001AC44)
  // movz w0, #0xac44 (44100)
  instructions.push(0x52958880);
  // movk w0, #0x1001, lsl #16
  instructions.push(0x72a20020);
  // str w0, [x20, #8] (AUDIO_REG_FORMAT)
  instructions.push(0xb9000a80);

  // 4. Configure Channel 1: Bass Triangle Wave (131 Hz, Volume 160)
  // movz w0, #131 (C3 note)
  instructions.push(0x52801060);
  // str w0, [x20, #0x30] (AUDIO_CH1_FREQ)
  instructions.push(0xb9003280);
  // movz w0, #160 (Volume)
  instructions.push(0x52801400);
  // str w0, [x20, #0x38] (AUDIO_CH1_VOL)
  instructions.push(0xb9003a80);
  // movz w0, #3 (TRIANGLE wave)
  instructions.push(0x52800060);
  // str w0, [x20, #0x3c] (AUDIO_CH1_WAVE)
  instructions.push(0xb9003e80);

  // 5. Configure Channel 2: Percussion Noise (Frequency 400, Volume 100)
  // movz w0, #400
  instructions.push(0x52803200);
  // str w0, [x20, #0x40] (AUDIO_CH2_FREQ)
  instructions.push(0xb9004280);
  // movz w0, #100
  instructions.push(0x52800c80);
  // str w0, [x20, #0x48] (AUDIO_CH2_VOL)
  instructions.push(0xb9004a80);
  // movz w0, #4 (NOISE wave)
  instructions.push(0x52800080);
  // str w0, [x20, #0x4c] (AUDIO_CH2_WAVE)
  instructions.push(0xb9004e80);

  // 6. Synthesize 16 PCM Samples into Ring Buffer (0x00870000)
  // We write an alternating sawtooth / pulse wave (+16000, -16000)
  // Sample 0: +16000 (0x3e80)
  // movz w0, #0x3e80
  instructions.push(0x5287d000);
  // strh w0, [x21, #0]
  instructions.push(0x790002a0);
  // Sample 1: -16000 (0xc180)
  // movz w0, #0xc180
  instructions.push(0x52983000);
  // strh w0, [x21, #2]
  instructions.push(0x790006a0);
  // Sample 2: +16000
  // movz w0, #0x3e80
  instructions.push(0x5287d000);
  // strh w0, [x21, #4]
  instructions.push(0x79000aa0);
  // Sample 3: -16000
  // movz w0, #0xc180
  instructions.push(0x52983000);
  // strh w0, [x21, #6]
  instructions.push(0x79000ea0);

  // Update AUDIO_REG_WRITE_PTR = 8 bytes written
  // movz w0, #8
  instructions.push(0x52800100);
  // str w0, [x20, #0x14] (AUDIO_REG_WRITE_PTR)
  instructions.push(0xb9001680);

  // 7. Channel 0 Melody Arpeggio Loop (4 Notes: C4 262, E4 330, G4 392, C5 523)
  // movz w0, #200 (Volume)
  instructions.push(0x52801900);
  // str w0, [x20, #0x28] (AUDIO_CH0_VOL)
  instructions.push(0xb9002a80);
  // movz w0, #1 (SQUARE wave)
  instructions.push(0x52800020);
  // str w0, [x20, #0x2c] (AUDIO_CH0_WAVE)
  instructions.push(0xb9002e80);

  // Note 1: C4 (262 Hz)
  // movz w0, #262
  instructions.push(0x528020c0);
  // str w0, [x20, #0x20] (AUDIO_CH0_FREQ)
  instructions.push(0xb9002280);

  // Frame yield 1
  // movz x8, #124 (sys_sched_yield)
  instructions.push(0xd2800f88);
  // svc #0
  instructions.push(0xd4000001);

  // Note 2: E4 (330 Hz)
  // movz w0, #330
  instructions.push(0x52802940);
  // str w0, [x20, #0x20]
  instructions.push(0xb9002280);

  // Frame yield 2
  // movz x8, #124
  instructions.push(0xd2800f88);
  // svc #0
  instructions.push(0xd4000001);

  // Note 3: G4 (392 Hz)
  // movz w0, #392
  instructions.push(0x52803100);
  // str w0, [x20, #0x20]
  instructions.push(0xb9002280);

  // Frame yield 3
  // movz x8, #124
  instructions.push(0xd2800f88);
  // svc #0
  instructions.push(0xd4000001);

  // Note 4: C5 (523 Hz)
  // movz w0, #523
  instructions.push(0x52804160);
  // str w0, [x20, #0x20]
  instructions.push(0xb9002280);

  // Frame yield 4
  // movz x8, #124
  instructions.push(0xd2800f88);
  // svc #0
  instructions.push(0xd4000001);

  // 8. Exit program cleanly with code 42
  // movz x0, #42
  instructions.push(0x52800540);
  // movz x8, #93 (sys_exit)
  instructions.push(0xd2800ba8);
  // svc #0
  instructions.push(0xd4000001);

  // Validate instructions with decoder
  for (let i = 0; i < instructions.length; i++) {
    const raw = instructions[i];
    const dec = Decoder.decode(raw, 0x00400000 + i * 4);
    if (!dec || dec.type === "UNKNOWN") {
      throw new Error(`Instruction index ${i} (0x${raw.toString(16).padStart(8, "0")}) failed decoding!`);
    }
  }

  const elfBuffer = buildElfWithPayload(instructions);
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
  const outPath = path.join(BIN_DIR, "audio_synth.elf");
  fs.writeFileSync(outPath, elfBuffer);
  console.log(`Generated ELF Audio Synthesizer: ${outPath} (${elfBuffer.length} bytes, ${instructions.length} instructions)`);
  return outPath;
}

if (process.argv[1] && process.argv[1].endsWith("build_audio_elf.js")) {
  generateAudioElf();
}
