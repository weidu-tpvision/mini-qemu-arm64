# MMIO Audio Peripheral & Sound Synthesizer Architecture

A comprehensive technical reference detailing the design, memory-mapped registers, Chiptune PSG sound generator, and PCM ring buffer streaming engine in Mini-QEMU ARM64.

---

## 1. Overview & Objectives

Following the integration of Level 1 MMIO Graphics (`0x00800000`) and Interactive Input (`0x00850000`), Mini-QEMU provides a dedicated **MMIO Audio Peripheral** (`0x00860000`) and **PCM Ring Buffer** (`0x00870000`–`0x00874000`).

The audio architecture supports two complementary synthesis modes:
1. **Direct PCM Sample Streaming:** The guest ARM64 program generates digital PCM audio samples (16-bit signed, 8-bit, or IEEE-754 32-bit float) into a circular ring buffer in virtual RAM, tracking write and read cursors with automatic wrap-around detection.
2. **Multi-Channel Chiptune PSG (Programmable Sound Generator):** Hardware-emulated sound channels inspired by classic gaming architectures (NES APU, Game Boy, Commodore SID):
   - **Channel 0 (Pulse / Square Wave):** Melodic leads with selectable duty cycle (12.5%, 25%, 50%, 75%).
   - **Channel 1 (Triangle / Waveform):** Bass lines and acoustic melodic tones.
   - **Channel 2 (Noise Generator):** Percussion and sound effects using a 16-bit Galois Linear Feedback Shift Register (LFSR).
3. **Web Audio API & Real-Time Oscilloscope:** In the browser visual debugger (`ui/index.html`), the emulator drives host Web Audio playback with master volume control and renders an interactive real-time phosphor oscilloscope canvas.
4. **Standard RIFF/WAV File Export:** The audio subsystem can serialize synthesized or streamed audio directly into a standard 44-byte RIFF/WAV format for testing and offline export.

---

## 2. Memory Map & Hardware Register Layout

```
 Virtual Address                Peripheral Subsystem
+──────────────────────────+
| 0x00800000 - 0x0084B000  |  Level 1 MMIO Graphics Framebuffer (320x240 RGBA)
+──────────────────────────+
| 0x00850000 - 0x00851000  |  MMIO Interactive Input (Keyboard, Gamepad & Pointer)
+──────────────────────────+
| 0x00860000 - 0x00861000  |  MMIO Audio Control & Chiptune PSG Registers (4 KB Page)
+──────────────────────────+
| 0x00870000 - 0x00874000  |  PCM Sample Ring Buffer (16 KB Default)
+──────────────────────────+
```

### 2.1 Audio Control Registers (`0x00860000`)

| Offset | Register Name | Width | Access | Description |
| :--- | :--- | :---: | :---: | :--- |
| `0x00` | `AUDIO_REG_STATUS` | 32-bit | R | Status flags: Bit 0=Enabled, Bit 1=Playing, Bit 2=Wrap, Bit 3=IRQ |
| `0x04` | `AUDIO_REG_CONTROL` | 32-bit | R/W | Control command: `1`=Play, `0`=Stop/Pause, `2`=Reset Buffer |
| `0x08` | `AUDIO_REG_FORMAT` | 32-bit | R/W | Format: `[15:0]` Sample Rate, `[23:16]` Channels, `[31:24]` Bit Depth |
| `0x0C` | `AUDIO_REG_BUFFER_BASE`| 32-bit| R/W | Virtual RAM address of PCM sample ring buffer (default: `0x00870000`) |
| `0x10` | `AUDIO_REG_BUFFER_SIZE`| 32-bit| R/W | Size of PCM sample buffer in bytes (default: `16384` / 16 KB) |
| `0x14` | `AUDIO_REG_WRITE_PTR` | 32-bit | R/W | Write cursor offset in bytes (advanced by guest program) |
| `0x18` | `AUDIO_REG_READ_PTR` | 32-bit | R/W | Read cursor offset in bytes (advanced by audio drain / playback) |
| `0x1C` | `AUDIO_REG_DROPPED` | 32-bit | R | Counter tracking buffer underruns or dropped frames |

### 2.2 Chiptune PSG Sound Generator Channels (`0x00860020`–`0x0086004C`)

Each sound channel is configured via a 16-byte block:
- **`+0x00` Frequency (Hz):** Target tone frequency in Hertz (e.g. `262` for C4, `440` for A4).
- **`+0x04` Duty Cycle:** Duty ratio (`0`=12.5%, `1`=25%, `2`=50%, `3`=75%).
- **`+0x08` Volume:** Channel volume `0` to `255`.
- **`+0x0C` Waveform:** `0`=Off, `1`=Square, `2`=Sawtooth, `3`=Triangle, `4`=Noise.

```
 Channel 0 (Pulse Wave)      Channel 1 (Triangle Wave)   Channel 2 (Noise / Drums)
 0x00860020: Freq (Hz)       0x00860030: Freq (Hz)       0x00860040: Freq (Hz)
 0x00860024: Duty Cycle      0x00860034: Duty Cycle      0x00860044: Duty Cycle
 0x00860028: Volume (0-255)  0x00860038: Volume (0-255)  0x00860048: Volume (0-255)
 0x0086002C: Waveform (1)    0x0086003C: Waveform (3)    0x0086004C: Waveform (4)
```

---

## 3. Synthesis & Mixing Pipeline

```
           [ Guest ARM64 Program ]
           │                     │
  Writes PSG Registers    Writes PCM Samples
   (0x00860020+)          (0x00870000+)
           │                     │
           ▼                     ▼
 ┌───────────────────┐ ┌───────────────────┐
 │ Chiptune PSG Synthesizer │ │ PCM Ring Buffer   │
 │ • Square (Duty)   │ │ • 16-bit PCM      │
 │ • Triangle Wave   │ │ • Wrap-around ptr │
 │ • Galois LFSR     │ │ • Overrun guard   │
 └─────────┬─────────┘ └─────────┬─────────┘
           │                     │
           └──────────┬──────────┘
                      ▼
             [ Master Audio Mixer ]
             • Channel Blending
             • Soft-Clip Limiter: x / (1 + |x|)
             • Normalized Float32 [-1.0, +1.0]
                      │
           ┌──────────┴──────────┐
           ▼                     ▼
 ┌───────────────────┐ ┌───────────────────┐
 │  Web Audio Sink   │ │ RIFF/WAV Exporter │
 │ • AudioContext    │ │ • 44-byte Header  │
 │ • Oscilloscope    │ │ • test_audio.js   │
 └───────────────────┘ └───────────────────┘
```

---

## 4. Bare-Metal Guest ARM64 Programming Example

A guest program can program the sound synthesizer in just a few instructions:

```armasm
// 1. Point X20 to MMIO Audio Base (0x00860000)
movz x20, #0x86, lsl #16

// 2. Start Audio Controller
movz w0, #1
str  w0, [x20, #0x04]         // AUDIO_REG_CONTROL = 1 (Play)

// 3. Play Note A4 (440 Hz) on Channel 0 (Pulse Wave, 50% duty, volume 200)
movz w0, #440
str  w0, [x20, #0x20]         // AUDIO_CH0_FREQ = 440 Hz
movz w0, #200
str  w0, [x20, #0x28]         // AUDIO_CH0_VOL = 200
movz w0, #1
str  w0, [x20, #0x2c]         // AUDIO_CH0_WAVE = 1 (SQUARE)

// 4. Yield execution to allow audio frame playback
movz x8, #124                 // sys_sched_yield (124)
svc  #0
```

---

## 5. Verification & Testing

The audio subsystem is fully verified via automated tests in [tests/test_audio.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/tests/test_audio.js):
- **Test 1:** MMIO register offsets, address layouts, and default configurations.
- **Test 2:** Waveform generation for Square (with duty cycles), Triangle, and LFSR Noise.
- **Test 3:** PCM ring buffer streaming, sample draining, and wrap-around flag latching.
- **Test 4:** RIFF/WAV audio file header encoding and PCM payload integrity.
- **Test 5:** End-to-end execution of `bin/audio_synth.elf` with **100% bit-exact parity** between Interpreter and Dynamic JIT modes.
