# Graphics Architecture & Emulation: From Retro PPUs to Switch and PS5

A comprehensive architectural guide on how graphics hardware works across console generations, what graphics support is required to build modern emulators (such as **Nintendo Switch**, **PS4/PS5**, and **retro consoles**), and how graphics emulation connects directly to **compiling/decompiling**, **system architecture**, and **reverse engineering (REA)**.

---

## 1. Overview: The Emulation Learning Journey

Building a CPU emulator (like **Mini-QEMU**) teaches the fundamentals of computer architecture:
1. **Fetch-Decode-Execute Cycles:** Processing machine instructions bit-by-bit.
2. **Virtual Memory & MMU:** Page tables, alignment, and memory boundaries.
3. **ABI & Operating System Boundaries:** System calls (`SVC`, `syscall`), registers, and stack frames.
4. **Binary Translation:** Interpreters vs. JIT/AOT decompilation.

However, a CPU alone only operates on raw registers and numbers. To run real software (operating systems, interactive tools, and games), the CPU must communicate with a **Display / Graphics Subsystem**.

Understanding console graphics is one of the most effective ways to master:
* **System Architecture:** How decoupled processors (CPU, GPU, DMA controllers) communicate asynchronously across shared buses using rings, interrupts, and fences.
* **Compiling & Decompiling:** Why modern GPU emulation is actually a **compiler problem** (translating binary GPU bytecode into host SPIR-V/Vulkan) rather than a rasterization problem.
* **Reverse Engineering (REA):** How undocumented proprietary graphics packets (NVIDIA Maxwell pushbuffers, AMD PM4 command streams) are disassembled, inspected, and mapped to host graphics APIs.

---

## 2. The 3 Historical Eras of Console Graphics Architecture

```
+-----------------------------------------------------------------------------------+
│                             Evolution of Console Graphics                         │
+---------------------------+---------------------------+---------------------------+
│ 1. 2D Tile / Scanline PPU │ 2. Command Lists & DMA 3D │ 3. Modern Unified GPU     │
│    (NES, Game Boy, GBA)   │    (PS1, N64, Dreamcast)  │    (Switch, PS4, PS5, PC) │
+---------------------------+---------------------------+---------------------------+
│ • PPU in lockstep with    │ • CPU writes command lists│ • Ring Buffers / Queues   │
│   CRT electron beam       │ • DMA transfers to GPU    │ • Shader ISA Decompiler   │
│ • VRAM tiles + OAM + pal  │ • Fixed-function pipeline │   (Maxwell / AMD GCN to   │
│ • No modern shaders       │ • HLE (Direct3D/OpenGL)   │   SPIR-V / Vulkan)        │
+---------------------------+---------------------------+---------------------------+
```

---

### Era 1: 2D Tile Engines & Scanline PPUs (NES, Game Boy, SNES, GBA)

In retro systems, RAM was extremely scarce. A 1989 Nintendo Game Boy had only **8 KB of internal RAM** and **8 KB of VRAM**; storing a modern 32-bit framebuffer (e.g., $160 \times 144 \times 4\text{ bytes} \approx 92\text{ KB}$) was physically impossible.

Instead of a framebuffer, retro systems used a **Picture Processing Unit (PPU)** that generated video signals **on the fly**, synchronized with the cathode-ray tube (CRT) electron beam:

```
+-------------------------------------------------------------------------------+
│                              Retro PPU Architecture                           │
│                                                                               │
│  [ VRAM Tile Data ]  --> 8x8 pixel patterns (bitmaps for characters)          │
│  [ VRAM Tile Maps ]  --> 32x32 grids specifying which tile goes where         │
│  [ OAM (Sprite RAM)] --> Coordinates (X, Y) and tile indices for moving items │
│  [ Color Palettes ]  --> Maps 2-bit or 4-bit pixel IDs to actual colors       │
│                                      │                                        │
│                                      ▼                                        │
│               [ Scanline Renderer (Cycles in lockstep with CPU) ]             │
│                 - Mode 2: OAM Search (find sprites on scanline)               │
│                 - Mode 3: Pixel Transfer (read tiles & push to LCD)           │
│                 - Mode 0: H-Blank (horizontal beam reset)                     │
│                 - Mode 1: V-Blank (vertical screen reset -> CPU Interrupt)    │
+-------------------------------------------------------------------------------+
```

#### What this Teaches You:
* **Cycle-Accurate Timing:** The CPU and PPU must be synchronized down to the exact clock cycle. Many Game Boy games (such as *Super Mario Land* or *The Legend of Zelda: Link's Awakening*) change scroll registers or swap palettes midway through a scanline (raster effects) to produce water or parallax effects. If the emulator is off by even a few CPU cycles, the screen glitches.
* **Hardware Interrupts:** When the electron beam finishes drawing line 144 and enters V-Blank (Mode 1), the PPU triggers an interrupt vector (`0x0040` on Game Boy). The CPU catches this interrupt to update game logic, physics, and sprite positions.
* **Memory-Mapped Registers (MMIO):** The CPU controls the screen by writing to specific memory addresses (`LCDC` at `0xFF40`, `STAT` at `0xFF41`, `SCX`/`SCY` at `0xFF42`/`0xFF43`).

---

### Era 2: Command Lists, DMA, and Fixed-Function 3D (PS1, N64)

The fifth console generation introduced true 3D rasterizers and dedicated geometry coprocessors:
* **Sony PlayStation 1 (PS1):**
  * **CPU:** 32-bit MIPS R3000A.
  * **GTE (Geometry Transformation Engine):** A coprocessor inside the CPU that performs matrix multiplication, 3D perspective projection, and lighting math in hardware.
  * **GPU:** Rasterizes flat or Gouraud-shaded textured triangles and quadrilaterals.
* **Nintendo 64 (N64):**
  * **CPU:** 64-bit MIPS VR4300.
  * **RCP (Reality Coprocessor):** Divided into the **RSP** (Reality Signal Processor — a programmable vector DSP running geometry microcode like *Fast3D*) and the **RDP** (Reality Display Processor — pixel rasterizer).

#### How the CPU and GPU Communicate:
The CPU does **not** draw pixels directly. Instead:
1. The CPU (or geometry coprocessor) builds a **Display List** or **Command Packet** in main RAM:
   ```
   [ Packet Header: Draw Textured Triangle (0x24) ]
   [ Vertex 0: X0, Y0, U0, V0 ]
   [ Vertex 1: X1, Y1, U1, V1 ]
   [ Vertex 2: X2, Y2, U2, V2 ]
   ```
2. The CPU triggers a **DMA (Direct Memory Access)** channel. The DMA controller streams this command list directly from RAM into the GPU's FIFO queue while the CPU continues running game code.

#### The Emulation Dilemma: LLE vs. HLE
When building an emulator for this generation, you choose between two paradigms:
1. **Low-Level Emulation (LLE):**
   * Emulates every register, DAC, clock tick, and rasterizer state machine in the GPU hardware.
   * *Pros:* 100% accurate, handles undocumented hardware quirks.
   * *Cons:* Requires massive host CPU power; cannot easily upscale games to 4K without rewriting the rasterizer.
2. **High-Level Emulation (HLE):**
   * Intercepts the graphics command packets or N64 microcode function calls before they reach the virtual GPU.
   * Translates the guest commands directly into modern host API calls (**OpenGL**, **Vulkan**, or **DirectX**).
   * *Pros:* Blazing fast, renders natively in 4K/60 FPS, allows custom texture filtering.
   * *Cons:* Requires reverse-engineering proprietary microcode and graphics formats.

---

### Era 3: Modern Unified Shaders & Command Queues (Nintendo Switch, PS4, PS5)

Modern video game consoles are specialized 64-bit computers with programmable GPU architectures:
* **Nintendo Switch:**
  * **CPU:** 64-bit ARM64 (AArch64 Cortex-A57 — **the exact same architecture Mini-QEMU emulates!**).
  * **GPU:** NVIDIA Tegra X1 (Maxwell architecture, 256 CUDA cores).
  * **Emulators:** Yuzu, Ryujinx.
* **PlayStation 4 & PlayStation 5:**
  * **CPU:** 64-bit x86-64 AMD Jaguar (PS4) / AMD Zen 2 (PS5).
  * **GPU:** AMD Radeon GCN 1.1 (PS4) / AMD RDNA 2 (PS5).
  * **Emulators:** ShadPS4, RPCS3 (PS3), Spine, Kyty.

#### The 3 Fundamental Graphics Subsystems in Modern Emulators:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                     Modern Console Graphics Emulation Pipeline                │
│                                                                               │
│  [ Guest Game / NVN / GNM API ]                                               │
│                 │                                                             │
│                 ▼                                                             │
│  [ Shared Virtual RAM: Pushbuffer / Ring Buffer ]                             │
│                 │                                                             │
│                 ▼ (Command Decoder / Packet Parser)                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │ 1. State Tracker: Viewports, Blend Modes, Depth Buffers, Vertex Buffers │  │
│  │ 2. Shader Extraction: Locate GPU machine code in guest memory          │  │
│  └───────────────────────────────────┬─────────────────────────────────────┘  │
│                                      │                                        │
│                                      ▼                                        │
│  [ Guest GPU Machine Code (NVIDIA Maxwell NVIR / AMD GCN Bytecode) ]          │
│                                      │                                        │
│                                      ▼ (Shader Decompiler / Lifter)           │
│  [ Intermediate Representation (Control Flow Graph, SSA Form, Virtual Regs) ] │
│                                      │                                        │
│                                      ▼ (Host Code Generator)                  │
│  [ Standard SPIR-V Bytecode / Vulkan Shaders ]                                │
│                                      │                                        │
│                                      ▼ (Host GPU Driver)                      │
│  [ Native Host GPU Execution (NVIDIA / AMD / Intel / Apple Silicon) ]         │
└───────────────────────────────────────────────────────────────────────────────┘
```

#### 1. Pushbuffer / PM4 Command Packet Parsing
* Modern console games **never** communicate with the GPU through standard synchronous system calls.
* Instead, the game's graphics driver writes commands into a **Command Queue / Pushbuffer** (a ring buffer in shared virtual memory).
* In **Switch emulators (Yuzu/Ryujinx)**, the emulator monitors NVIDIA Maxwell command classes (`maxwell_3d`, `fermi_2d`), extracting commands like `SetRenderTarget`, `SetViewport`, and `DrawArrays`.
* In **PS4/PS5 emulators (ShadPS4)**, the emulator decodes **AMD PM4 packets** (Packet Type 3: `IT_DRAW_INDEX_AUTO`, `IT_SET_CONTEXT_REG`).

#### 2. The Core Compiler Problem: Binary Shader Decompilation
* In PC gaming, game developers ship high-level shaders compiled to DirectX or Vulkan intermediate bytecodes (DXBC, DXIL, or SPIR-V).
* On consoles, however, game developers compile shaders directly to **native physical GPU machine code**:
  * Nintendo Switch: **NVIDIA Maxwell GPU ISA** (machine code instructions like `FADD`, `FFMA`, `TEX`, `BRA`).
  * PS4 / PS5: **AMD GCN / RDNA GPU ISA** (Scalar ALU `S_ADD_U32`, Vector ALU `V_FMA_F32`, Image sample `IMAGE_SAMPLE`).
* **Why this is challenging:** An emulator running on an Intel laptop or Apple Silicon Mac **cannot** execute NVIDIA Maxwell or AMD GCN GPU machine code.
* **The Solution (A GPU JIT / Decompiler):**
  1. **Disassemble:** Parse raw GPU instruction words and decode opcodes, source registers, and condition codes.
  2. **Lift to Intermediate Representation (IR):** Build a Static Single Assignment (SSA) Control Flow Graph.
  3. **Optimize:** Simplify redundant registers, propagate constants, and normalize texture coordinates.
  4. **Recompile to Host SPIR-V:** Emit standard Khronos **SPIR-V** binary shaders that Vulkan executes natively on whatever graphics card is inside the host computer.

#### 3. Memory Virtualization, Texture Tiling, and Synchronization
* **Swizzling / Morton Ordering:** Consoles do not store textures in linear row-major order ($X \times Y$). They store them in Morton "Z-order" (recursive micro-tiles) to keep adjacent 2D pixels physically close in DRAM cache lines. The emulator must de-swizzle guest textures into linear host formats.
* **GPU Fences & Semaphores:** The CPU writes to memory, signals a fence, and waits for the GPU to update a counter. Emulators must track these GPU synchronization primitives so the CPU does not proceed until render passes finish.

---

## 3. How Graphics Emulation Bridges with Reverse Engineering (REA)

When building an emulator for a closed-source platform, graphics development is an exercise in **Reverse Engineering & Architecture (REA)**:

1. **Undocumented Hardware Registers:**
   * Console manufacturers rarely release public hardware specifications.
   * Emulation developers write "hardware test homebrew" that runs on real physical consoles (jailbroken Switch or PS4) to probe registers, trigger edge-case math, and log outputs.
2. **Reverse Engineering Drivers:**
   * On the Nintendo Switch, developers reverse-engineer `nvservices.nso` and `libnvn.nso` (the Nintendo NVN graphics driver) to discover ioctl commands (`NVGPU_IOCTL_CHANNEL_SUBMIT_GPFIFO`).
   * On the PS4, developers reverse-engineer the `libGnm` (low-level) and `libGnmx` (high-level) graphics libraries to map draw calls to underlying PM4 packet layouts.
3. **Trace-Guided Replay:**
   * Capturing command buffers using tools like RenderDoc or custom packet sniffers to replay and isolate rendering artifacts.

---

## 4. The Pedagogical Roadmap: How to Learn Graphics Step-by-Step

Trying to build a complete modern Vulkan shader decompiler on day one is overwhelming. The optimal, educational way to master graphics architecture is to climb a **3-level ladder**:

```
+-----------------------------------------------------------------------------------+
│                          Graphics Learning Progression                            │
+-------------------+---------------------------------------------------------------+
│ Level 1           │ MMIO Framebuffer                                              │
│ (Foundational)    │ - CPU writes pixel values directly to physical VRAM range     │
│                   │ - Host blits VRAM to HTML5 Canvas / Window via ImageData      │
│                   │ - Teaches: Memory mapping, pixel formats, pitch & stride      │
+-------------------+---------------------------------------------------------------+
│ Level 2           │ Virtual GPU & Command Ring Buffer                             │
│ (Architecture)    │ - CPU writes command packets to a FIFO queue in memory        │
│                   │ - Asynchronous GPU thread / loop pops commands and executes   │
│                   │ - Teaches: Decoupled processors, DMA, queue pointers, fences │
+-------------------+---------------------------------------------------------------+
│ Level 3           │ Command List & Bytecode Translation                           │
│ (Compilers / REA) │ - Guest issues draw commands with mini-shaders                │
│                   │ - Emulator lifts guest bytecode to host WebGL/Vulkan shaders  │
│                   │ - Teaches: JIT/AOT decompilation, SSA IR, backend generation  │
+-------------------+---------------------------------------------------------------+
```

---

## 5. Implemented Graphics & Interactive Input Architecture in Mini-QEMU

Because **Mini-QEMU** emulates 64-bit ARM64 (the architecture of the **Nintendo Switch**, modern smartphones, and Apple Silicon), it implements **Level 1 MMIO Display + Interactive Input + VSync Frame Yield**:

1. **Level 1 MMIO Framebuffer (`0x00800000` – `0x0084B000`):**
   * Maps a dedicated 300 KB Video RAM region for a $320 \times 240$ display at 32-bit RGBA (`0xAABBGGRR` Little-Endian byte order).
   * Tracks dirty VRAM writes (`vramDirty`) and blits directly into the HTML5 `<canvas>` (`ui/index.html`) with an optional CRT scanline overlay and live pixel coordinate/MMIO address probe.
   * **Guest Demos:**
     * `bin/graphics_pattern.elf` ([`guest/graphics_demo.cpp`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/guest/graphics_demo.cpp)): Renders SMPTE television color bars, an RGB XOR mathematical fractal plasma, and a luma ramp.
     * `bin/plasma.elf` ([`guest/plasma.cpp`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/guest/plasma.cpp)): Renders a colorful 2D mathematical interference wave pattern and writes an ASCII art preview to `stdout`.

2. **MMIO Interactive Input Peripheral (`0x00850000` – `0x00850014`) & VSync Yield (`syscall 124`):**
   * Maps hardware input registers at `0x00850000`:
     * `0x00850000` (`INPUT_REG_KEY_STATE`): Live button bitmask (`Bit 0: UP`, `Bit 1: DOWN`, `Bit 2: LEFT`, `Bit 3: RIGHT`, `Bit 4: ACTION_A / Paint`, `Bit 5: ACTION_B / Color`, `Bit 6: RESET / Clear`, `Bit 7: EXIT`).
     * `0x00850004` (`INPUT_REG_LAST_KEY`): Last key ASCII/keyCode pressed.
     * `0x00850008` (`INPUT_REG_POINTER_X`): Mouse pointer X coordinate ($0 \dots 319$).
     * `0x0085000C` (`INPUT_REG_POINTER_Y`): Mouse pointer Y coordinate ($0 \dots 239$).
     * `0x00850010` (`INPUT_REG_POINTER_BTN`): Mouse button bitmask (`Bit 0`: Left button pressed).
     * `0x00850014` (`INPUT_REG_FRAME_COUNT`): VSync frame counter incremented on every `sys_sched_yield`.
   * **VSync Frame Synchronization (`sys_sched_yield`, `X8 = 124`):**
     * Interactive guest binaries execute an event loop that polls `0x00850000`, updates VRAM at `0x00800000`, and invokes `svc #0` with `x8 = 124`.
     * The emulator traps `syscall 124`, increments `INPUT_REG_FRAME_COUNT`, and sets `yielded = true` so the browser's `requestAnimationFrame` loop renders each frame smoothly at 60 FPS and samples fresh keyboard/mouse/D-Pad inputs before resuming the next frame.
   * **Interactive Guest Demo:**
     * `bin/interactive_paint.elf` ([`guest/interactive_paint.cpp`](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/guest/interactive_paint.cpp)): A 60 FPS bare-metal ARM64 interactive pixel painter with non-destructive cursor save/restore, rising-edge palette cycling, canvas reset, and mouse direct-draw support.

3. **Future Step (Level 2 Command Queue):**
   * Define a lightweight packet protocol (`CMD_CLEAR`, `CMD_DRAW_RECT`, `CMD_BLIT`) in guest memory so guest programs can submit asynchronous draw queues.
