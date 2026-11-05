// src/audio.js - MMIO Audio Peripheral Controller & Multi-Channel Sound Synthesizer
import {
  AUDIO_BASE, AUDIO_REG_STATUS, AUDIO_REG_CONTROL, AUDIO_REG_FORMAT,
  AUDIO_REG_BUFFER_BASE, AUDIO_REG_BUFFER_SIZE, AUDIO_REG_WRITE_PTR,
  AUDIO_REG_READ_PTR, AUDIO_REG_DROPPED,
  AUDIO_CH0_FREQ, AUDIO_CH0_DUTY, AUDIO_CH0_VOL, AUDIO_CH0_WAVE,
  AUDIO_CH1_FREQ, AUDIO_CH1_DUTY, AUDIO_CH1_VOL, AUDIO_CH1_WAVE,
  AUDIO_CH2_FREQ, AUDIO_CH2_DUTY, AUDIO_CH2_VOL, AUDIO_CH2_WAVE,
  AUDIO_RING_BASE_DEFAULT, AUDIO_RING_SIZE_DEFAULT
} from "./memory.js";

export const AudioWaveform = {
  OFF: 0,
  SQUARE: 1,
  SAWTOOTH: 2,
  TRIANGLE: 3,
  NOISE: 4
};

export const AudioStatus = {
  ENABLED: 1 << 0,
  PLAYING: 1 << 1,
  WRAP:    1 << 2,
  IRQ:     1 << 3
};

export class AudioController {
  constructor(emulator) {
    this.emulator = emulator;
    this.memory = emulator.memory;

    // Internal phase accumulators for PSG tone generators
    this.phases = [0, 0, 0];
    // Galois LFSR state for noise channel (16-bit)
    this.lfsrState = 0x7ace;

    this.initHardwareRegisters();
  }

  // Initialize MMIO audio registers to sensible defaults
  initHardwareRegisters() {
    this.memory.write32(AUDIO_REG_STATUS, AudioStatus.ENABLED);
    this.memory.write32(AUDIO_REG_CONTROL, 0); // 0 = stopped
    // Default format: 44100 Hz, 1 channel (mono), 16-bit PCM
    const formatWord = (44100 & 0xffff) | (1 << 16) | (16 << 24);
    this.memory.write32(AUDIO_REG_FORMAT, formatWord);
    this.memory.write32(AUDIO_REG_BUFFER_BASE, AUDIO_RING_BASE_DEFAULT);
    this.memory.write32(AUDIO_REG_BUFFER_SIZE, AUDIO_RING_SIZE_DEFAULT);
    this.memory.write32(AUDIO_REG_WRITE_PTR, 0);
    this.memory.write32(AUDIO_REG_READ_PTR, 0);
    this.memory.write32(AUDIO_REG_DROPPED, 0);

    // Clear channel registers
    for (let ch = 0; ch < 3; ch++) {
      const base = AUDIO_CH0_FREQ + ch * 0x10;
      this.memory.write32(base + 0, 0); // Freq
      this.memory.write32(base + 4, 2); // Duty (50%)
      this.memory.write32(base + 8, 0); // Vol
      this.memory.write32(base + 12, 0); // Wave (OFF)
    }
  }

  // Read current audio hardware state
  getAudioInfo() {
    const format = this.memory.read32(AUDIO_REG_FORMAT);
    const sampleRate = (format & 0xffff) || 44100;
    const channels = ((format >> 16) & 0xff) || 1;
    const bits = ((format >> 24) & 0xff) || 16;
    const bufferBase = this.memory.read32(AUDIO_REG_BUFFER_BASE) || AUDIO_RING_BASE_DEFAULT;
    const bufferSize = this.memory.read32(AUDIO_REG_BUFFER_SIZE) || AUDIO_RING_SIZE_DEFAULT;
    const writePtr = this.memory.read32(AUDIO_REG_WRITE_PTR);
    const readPtr = this.memory.read32(AUDIO_REG_READ_PTR);

    // Compute unread available PCM bytes
    let availableBytes = writePtr >= readPtr
      ? (writePtr - readPtr)
      : (bufferSize - readPtr + writePtr);

    const ch0 = {
      freq: this.memory.read32(AUDIO_CH0_FREQ),
      duty: this.memory.read32(AUDIO_CH0_DUTY),
      volume: this.memory.read32(AUDIO_CH0_VOL),
      wave: this.memory.read32(AUDIO_CH0_WAVE)
    };
    const ch1 = {
      freq: this.memory.read32(AUDIO_CH1_FREQ),
      duty: this.memory.read32(AUDIO_CH1_DUTY),
      volume: this.memory.read32(AUDIO_CH1_VOL),
      wave: this.memory.read32(AUDIO_CH1_WAVE)
    };
    const ch2 = {
      freq: this.memory.read32(AUDIO_CH2_FREQ),
      duty: this.memory.read32(AUDIO_CH2_DUTY),
      volume: this.memory.read32(AUDIO_CH2_VOL),
      wave: this.memory.read32(AUDIO_CH2_WAVE)
    };

    return {
      base: AUDIO_BASE,
      status: this.memory.read32(AUDIO_REG_STATUS),
      control: this.memory.read32(AUDIO_REG_CONTROL),
      sampleRate,
      channels,
      bits,
      bufferBase,
      bufferSize,
      writePtr,
      readPtr,
      availableBytes,
      dropped: this.memory.read32(AUDIO_REG_DROPPED),
      channelsInfo: [ch0, ch1, ch2]
    };
  }

  // Set control register (1 = play, 0 = pause, 2 = reset)
  setControl(val) {
    this.memory.write32(AUDIO_REG_CONTROL, val >>> 0);
    let status = this.memory.read32(AUDIO_REG_STATUS);
    if (val === 1) {
      status |= AudioStatus.PLAYING;
    } else if (val === 0) {
      status &= ~AudioStatus.PLAYING;
    } else if (val === 2) {
      this.resetPcmBuffer();
    }
    this.memory.write32(AUDIO_REG_STATUS, status);
  }

  // Reset the PCM ring buffer cursors
  resetPcmBuffer() {
    this.memory.write32(AUDIO_REG_WRITE_PTR, 0);
    this.memory.write32(AUDIO_REG_READ_PTR, 0);
  }

  // Program a chiptune channel
  setChannel(ch, freq, wave = AudioWaveform.SQUARE, volume = 128, duty = 2) {
    if (ch < 0 || ch > 2) return;
    const base = AUDIO_CH0_FREQ + ch * 0x10;
    this.memory.write32(base + 0, freq >>> 0);
    this.memory.write32(base + 4, duty >>> 0);
    this.memory.write32(base + 8, Math.min(255, Math.max(0, volume)));
    this.memory.write32(base + 12, wave >>> 0);

    // Auto-set status to playing if volume > 0 and wave != OFF
    if (volume > 0 && wave !== AudioWaveform.OFF) {
      const status = this.memory.read32(AUDIO_REG_STATUS);
      this.memory.write32(AUDIO_REG_STATUS, status | AudioStatus.PLAYING);
    }
  }

  // Write a sequence of 16-bit PCM samples into the ring buffer
  writePcmSamples(samples) {
    const info = this.getAudioInfo();
    const bufBase = info.bufferBase;
    const bufSize = info.bufferSize;
    let writePtr = info.writePtr;

    for (let i = 0; i < samples.length; i++) {
      let sample = samples[i];
      // Convert float [-1.0, 1.0] to int16 if needed
      let int16Val = typeof sample === "number" && (sample < -1.0 || sample > 1.0)
        ? Math.floor(sample)
        : Math.floor(Math.max(-1.0, Math.min(1.0, sample)) * 32767);

      const targetAddr = bufBase + writePtr;
      this.memory.write16(targetAddr, int16Val & 0xffff);

      writePtr = (writePtr + 2) % bufSize;
      if (writePtr === 0) {
        const status = this.memory.read32(AUDIO_REG_STATUS);
        this.memory.write32(AUDIO_REG_STATUS, status | AudioStatus.WRAP);
      }
    }

    this.memory.write32(AUDIO_REG_WRITE_PTR, writePtr);
    // Auto-mark playing
    const status = this.memory.read32(AUDIO_REG_STATUS);
    this.memory.write32(AUDIO_REG_STATUS, status | AudioStatus.PLAYING);
  }

  // Drain PCM samples from ring buffer into a normalized Float32Array
  drainPcmSamples(maxSamples = 4096) {
    const info = this.getAudioInfo();
    const bytesPerSample = info.bits === 8 ? 1 : (info.bits === 32 ? 4 : 2);
    let availableSamples = Math.floor(info.availableBytes / bytesPerSample);
    const count = Math.min(maxSamples, availableSamples);

    if (count <= 0) {
      return new Float32Array(0);
    }

    const out = new Float32Array(count);
    const bufBase = info.bufferBase;
    const bufSize = info.bufferSize;
    let readPtr = info.readPtr;

    for (let i = 0; i < count; i++) {
      const targetAddr = bufBase + readPtr;
      let val = 0;

      if (info.bits === 8) {
        const u8 = this.memory.read8(targetAddr);
        // Signed 8-bit (-128..127) or uint8 (0..255)
        val = (u8 - 128) / 128.0;
        readPtr = (readPtr + 1) % bufSize;
      } else if (info.bits === 32) {
        val = this.memory.readFloat32(targetAddr);
        readPtr = (readPtr + 4) % bufSize;
      } else {
        // Standard 16-bit signed PCM
        const u16 = this.memory.read16(targetAddr);
        const s16 = (u16 & 0x8000) ? (u16 - 0x10000) : u16;
        val = s16 / 32768.0;
        readPtr = (readPtr + 2) % bufSize;
      }

      out[i] = val;
    }

    this.memory.write32(AUDIO_REG_READ_PTR, readPtr);
    return out;
  }

  // Synthesize PSG (Chiptune) frames for active channels
  synthesizePsgFrames(frameCount, sampleRate = 44100) {
    const out = new Float32Array(frameCount);
    const info = this.getAudioInfo();

    const dutyRatios = [0.125, 0.25, 0.50, 0.75];

    for (let ch = 0; ch < 3; ch++) {
      const channel = info.channelsInfo[ch];
      const freq = channel.freq;
      const wave = channel.wave;
      const vol = channel.volume / 255.0;

      if (wave === AudioWaveform.OFF || freq <= 0 || vol <= 0) {
        continue;
      }

      const phaseIncrement = freq / sampleRate;
      const duty = dutyRatios[channel.duty & 3] ?? 0.5;

      for (let i = 0; i < frameCount; i++) {
        let sample = 0;

        if (wave === AudioWaveform.SQUARE) {
          sample = this.phases[ch] < duty ? 1.0 : -1.0;
        } else if (wave === AudioWaveform.SAWTOOTH) {
          sample = (2.0 * this.phases[ch]) - 1.0;
        } else if (wave === AudioWaveform.TRIANGLE) {
          sample = this.phases[ch] < 0.5
            ? (4.0 * this.phases[ch]) - 1.0
            : 3.0 - (4.0 * this.phases[ch]);
        } else if (wave === AudioWaveform.NOISE) {
          // 16-bit Galois LFSR update
          const lsb = this.lfsrState & 1;
          this.lfsrState >>= 1;
          if (lsb) {
            this.lfsrState ^= 0xb400; // Feedback tap
          }
          sample = ((this.lfsrState & 0x3ff) / 512.0) - 1.0;
        }

        out[i] += sample * vol * 0.33; // Mix channels cleanly without clipping

        this.phases[ch] = (this.phases[ch] + phaseIncrement) % 1.0;
      }
    }

    return out;
  }

  // Combined audio frame generator (drains PCM + mixes PSG)
  renderAudioFrames(frameCount, sampleRate = 44100) {
    const psg = this.synthesizePsgFrames(frameCount, sampleRate);
    const pcm = this.drainPcmSamples(frameCount);

    const mixed = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      let sample = psg[i];
      if (i < pcm.length) {
        sample += pcm[i] * 0.8;
      }
      // Soft-clip limiter: tanh approximation x / (1 + |x|)
      mixed[i] = sample / (1.0 + Math.abs(sample));
    }
    return mixed;
  }

  // Encode Float32Array audio into a standard 44-byte RIFF/WAV file Uint8Array
  static toWavBuffer(samples, sampleRate = 44100, channels = 1) {
    const bytesPerSample = 2; // 16-bit PCM
    const blockAlign = channels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;
    const fileSize = 36 + dataSize;

    const buffer = new Uint8Array(44 + dataSize);
    const view = new DataView(buffer.buffer);

    // RIFF header
    buffer.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    view.setUint32(4, fileSize, true);
    buffer.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

    // "fmt " chunk
    buffer.set([0x66, 0x6d, 0x74, 0x20], 12);
    view.setUint32(16, 16, true);            // Chunk size: 16
    view.setUint16(20, 1, true);             // Audio format: 1 (PCM)
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);            // Bits per sample: 16

    // "data" chunk
    buffer.set([0x64, 0x61, 0x74, 0x61], 36);
    view.setUint32(40, dataSize, true);

    // Write samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1.0, Math.min(1.0, samples[i]));
      const int16 = s < 0 ? s * 32768 : s * 32767;
      view.setInt16(offset, Math.floor(int16), true);
      offset += 2;
    }

    return buffer;
  }
}
