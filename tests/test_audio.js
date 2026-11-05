// tests/test_audio.js - Unit and Integration Tests for MMIO Audio Peripheral & Sound Synthesizer
import assert from "node:assert";
import { MiniQEMU } from "../src/emulator.js";
import {
  AUDIO_BASE, AUDIO_REG_STATUS, AUDIO_REG_CONTROL, AUDIO_REG_FORMAT,
  AUDIO_REG_BUFFER_BASE, AUDIO_REG_BUFFER_SIZE, AUDIO_REG_WRITE_PTR,
  AUDIO_REG_READ_PTR, AUDIO_REG_DROPPED,
  AUDIO_CH0_FREQ, AUDIO_CH0_DUTY, AUDIO_CH0_VOL, AUDIO_CH0_WAVE,
  AUDIO_CH1_FREQ, AUDIO_CH1_VOL, AUDIO_CH1_WAVE,
  AUDIO_CH2_FREQ, AUDIO_CH2_VOL, AUDIO_CH2_WAVE,
  AUDIO_RING_BASE_DEFAULT, AUDIO_RING_SIZE_DEFAULT
} from "../src/memory.js";
import { AudioController, AudioWaveform, AudioStatus } from "../src/audio.js";

console.log("Running MMIO Audio Peripheral & Sound Synthesizer Unit Tests...\n");

// --- Test 1: MMIO Audio Register Layout & Hardware Defaults ---
{
  assert.strictEqual(AUDIO_BASE, 0x00860000, "AUDIO_BASE must be 0x00860000");
  assert.strictEqual(AUDIO_REG_STATUS, 0x00860000);
  assert.strictEqual(AUDIO_REG_CONTROL, 0x00860004);
  assert.strictEqual(AUDIO_REG_FORMAT, 0x00860008);
  assert.strictEqual(AUDIO_REG_BUFFER_BASE, 0x0086000C);
  assert.strictEqual(AUDIO_REG_BUFFER_SIZE, 0x00860010);
  assert.strictEqual(AUDIO_REG_WRITE_PTR, 0x00860014);
  assert.strictEqual(AUDIO_REG_READ_PTR, 0x00860018);
  assert.strictEqual(AUDIO_REG_DROPPED, 0x0086001C);

  assert.strictEqual(AUDIO_CH0_FREQ, 0x00860020);
  assert.strictEqual(AUDIO_CH0_DUTY, 0x00860024);
  assert.strictEqual(AUDIO_CH0_VOL, 0x00860028);
  assert.strictEqual(AUDIO_CH0_WAVE, 0x0086002C);

  const emu = new MiniQEMU({ jitEnabled: false });
  const info = emu.getAudioInfo();

  assert.strictEqual(info.sampleRate, 44100, "Default sample rate must be 44100 Hz");
  assert.strictEqual(info.channels, 1, "Default channel count must be 1 (mono)");
  assert.strictEqual(info.bits, 16, "Default bit depth must be 16-bit");
  assert.strictEqual(info.bufferBase, AUDIO_RING_BASE_DEFAULT, "Default buffer base must match default");
  assert.strictEqual(info.bufferSize, AUDIO_RING_SIZE_DEFAULT, "Default buffer size must match default");
  assert.strictEqual(info.writePtr, 0, "Initial write pointer must be 0");
  assert.strictEqual(info.readPtr, 0, "Initial read pointer must be 0");
  assert.strictEqual(info.availableBytes, 0, "Initial available bytes must be 0");

  console.log("[PASS] MMIO audio register offsets and default states verified");
}

// --- Test 2: PSG Chiptune Waveform Generation ---
{
  const emu = new MiniQEMU({ jitEnabled: false });

  // Program Channel 0: 440 Hz square wave, 50% duty, max volume
  emu.setAudioChannel(0, 440, AudioWaveform.SQUARE, 255, 2);
  const info = emu.getAudioInfo();
  assert.strictEqual(info.channelsInfo[0].freq, 440);
  assert.strictEqual(info.channelsInfo[0].wave, AudioWaveform.SQUARE);
  assert.strictEqual(info.channelsInfo[0].volume, 255);

  // Synthesize 100 frames at 44100 Hz
  const frames = emu.renderAudioFrames(100, 44100);
  assert.strictEqual(frames.length, 100);

  // Verify non-silent waveform values within [-1.0, 1.0]
  let hasPositive = false;
  let hasNegative = false;
  for (let i = 0; i < frames.length; i++) {
    assert.ok(frames[i] >= -1.0 && frames[i] <= 1.0, "Audio frames must be normalized in [-1.0, 1.0]");
    if (frames[i] > 0.05) hasPositive = true;
    if (frames[i] < -0.05) hasNegative = true;
  }
  assert.ok(hasPositive && hasNegative, "Synthesized audio must oscillate between positive and negative");

  // Test noise channel
  emu.setAudioChannel(2, 500, AudioWaveform.NOISE, 200, 0);
  const noiseFrames = emu.renderAudioFrames(50, 44100);
  assert.strictEqual(noiseFrames.length, 50);

  console.log("[PASS] PSG chiptune waveforms (square, triangle, noise) verified");
}

// --- Test 3: PCM Ring Buffer Streaming, Wrapping & Draining ---
{
  const emu = new MiniQEMU({ jitEnabled: false });

  // Write 4 signed 16-bit PCM samples
  const testSamples = [0.0, 0.5, -0.5, 0.9];
  emu.writePcmSamples(testSamples);

  let info = emu.getAudioInfo();
  assert.strictEqual(info.writePtr, 8, "4 16-bit samples = 8 bytes written");
  assert.strictEqual(info.availableBytes, 8, "Available bytes must be 8");

  // Drain samples
  const drained = emu.drainAudioSamples(10);
  assert.strictEqual(drained.length, 4, "Must drain exactly 4 samples");
  assert.ok(Math.abs(drained[0] - 0.0) < 0.01);
  assert.ok(Math.abs(drained[1] - 0.5) < 0.02);
  assert.ok(Math.abs(drained[2] - (-0.5)) < 0.02);
  assert.ok(Math.abs(drained[3] - 0.9) < 0.02);

  info = emu.getAudioInfo();
  assert.strictEqual(info.readPtr, 8, "Read pointer must catch up to write pointer");
  assert.strictEqual(info.availableBytes, 0, "No samples remaining after drain");

  // Test ring buffer wrap-around
  // Set writePtr near end
  emu.memory.write32(AUDIO_REG_WRITE_PTR, AUDIO_RING_SIZE_DEFAULT - 2);
  emu.writePcmSamples([0.25]); // 2 bytes -> wraps to 0
  info = emu.getAudioInfo();
  assert.strictEqual(info.writePtr, 0, "Write pointer must wrap to 0");
  assert.ok((info.status & AudioStatus.WRAP) !== 0, "Status must latch WRAP flag");

  console.log("[PASS] PCM ring buffer streaming, draining, and wrapping verified");
}

// --- Test 4: RIFF/WAV Header & Audio Export ---
{
  const samples = new Float32Array([0.0, 0.2, 0.4, -0.4, -0.2, 0.0]);
  const wavBytes = AudioController.toWavBuffer(samples, 44100, 1);

  assert.strictEqual(wavBytes.length, 44 + samples.length * 2, "WAV size must be 44 header bytes + 12 data bytes");
  // Check RIFF header magic
  const magic = String.fromCharCode(wavBytes[0], wavBytes[1], wavBytes[2], wavBytes[3]);
  assert.strictEqual(magic, "RIFF");
  const waveMagic = String.fromCharCode(wavBytes[8], wavBytes[9], wavBytes[10], wavBytes[11]);
  assert.strictEqual(waveMagic, "WAVE");

  console.log("[PASS] Standard 44-byte RIFF/WAV file header and PCM export verified");
}

// --- Test 5: End-to-End Execution of bin/audio_synth.elf ---
{
  // 1. Interpreter Execution
  const interpEmu = new MiniQEMU({ jitEnabled: false });
  interpEmu.loadElf("bin/audio_synth.elf");
  const interpExit = interpEmu.run(200, false);

  assert.strictEqual(interpExit, 42, `Interpreter exit code must be 42, got ${interpExit}`);
  assert.strictEqual(interpEmu.cpu.getReg(0), 42n, "X0 must be 42");

  const interpAudio = interpEmu.getAudioInfo();
  assert.strictEqual(interpAudio.channelsInfo[0].freq, 523, "Channel 0 final frequency must be C5 (523 Hz)");
  assert.strictEqual(interpAudio.channelsInfo[0].wave, AudioWaveform.SQUARE, "Channel 0 must be square wave");
  assert.strictEqual(interpAudio.channelsInfo[1].freq, 131, "Channel 1 frequency must be C3 (131 Hz)");
  assert.strictEqual(interpAudio.channelsInfo[1].wave, AudioWaveform.TRIANGLE, "Channel 1 must be triangle wave");
  assert.strictEqual(interpAudio.channelsInfo[2].freq, 400, "Channel 2 frequency must be 400 Hz");
  assert.strictEqual(interpAudio.channelsInfo[2].wave, AudioWaveform.NOISE, "Channel 2 must be noise");
  assert.strictEqual(interpAudio.writePtr, 8, "Guest program must write 8 PCM bytes (4 samples)");

  // 2. Dynamic JIT Execution
  const jitEmu = new MiniQEMU({ jitEnabled: true, jitHotThreshold: 1 });
  jitEmu.loadElf("bin/audio_synth.elf");
  const jitExit = jitEmu.run(200, false);

  assert.strictEqual(jitExit, 42, `JIT exit code must be 42, got ${jitExit}`);
  assert.strictEqual(jitEmu.cpu.getReg(0), 42n, "JIT X0 must be 42");

  // Verify bit-exact register matching across all 31 GPRs
  for (let r = 0; r < 31; r++) {
    assert.strictEqual(jitEmu.cpu.getReg(r), interpEmu.cpu.getReg(r), `Register X${r} mismatch`);
  }

  // Verify JIT audio hardware state matches interpreter
  const jitAudio = jitEmu.getAudioInfo();
  assert.strictEqual(jitAudio.channelsInfo[0].freq, interpAudio.channelsInfo[0].freq);
  assert.strictEqual(jitAudio.channelsInfo[1].freq, interpAudio.channelsInfo[1].freq);
  assert.strictEqual(jitAudio.channelsInfo[2].freq, interpAudio.channelsInfo[2].freq);
  assert.strictEqual(jitAudio.writePtr, interpAudio.writePtr);

  console.log("[PASS] End-to-end execution of audio_synth.elf verified with 100% Interpreter vs JIT parity (Exit: 42)");
}

console.log("\nAll MMIO Audio Peripheral Unit Tests Passed Successfully!");
