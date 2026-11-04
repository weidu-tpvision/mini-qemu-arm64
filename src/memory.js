// memory.js - Page-Based Virtual Memory for Mini-QEMU (4 KB Pages, Little-Endian)

export const PAGE_SIZE = 4096; // 4 KB page size
export const PAGE_MASK = PAGE_SIZE - 1;
export const PAGE_SHIFT = 12;

// --- Level 1 MMIO Framebuffer Constants ---
export const VRAM_BASE = 0x00800000;
export const FB_WIDTH = 320;
export const FB_HEIGHT = 240;
export const FB_BPP = 4; // 32-bit RGBA (4 bytes per pixel)
export const FB_SIZE = FB_WIDTH * FB_HEIGHT * FB_BPP; // 307,200 bytes (0x4B000)
export const VRAM_END = VRAM_BASE + FB_SIZE; // 0x0084B000

// --- MMIO Interactive Input Peripheral Constants (Keyboard, Gamepad & Pointer) ---
export const INPUT_BASE = 0x00850000;
export const INPUT_REG_KEY_STATE   = INPUT_BASE + 0x00; // 32-bit bitmask of held keys
export const INPUT_REG_LAST_KEY    = INPUT_BASE + 0x04; // 32-bit ASCII / key code of last event
export const INPUT_REG_POINTER_X   = INPUT_BASE + 0x08; // 32-bit Pointer X (0..319)
export const INPUT_REG_POINTER_Y   = INPUT_BASE + 0x0C; // 32-bit Pointer Y (0..239)
export const INPUT_REG_POINTER_BTN = INPUT_BASE + 0x10; // 32-bit Pointer buttons (bit 0=left, bit 1=right)
export const INPUT_REG_FRAME_COUNT = INPUT_BASE + 0x14; // 32-bit VSync / frame yield counter
export const INPUT_END             = INPUT_BASE + 0x1000; // 4 KB page

// Key bitmask definitions for INPUT_REG_KEY_STATE
export const KEY_MASK_UP       = 1 << 0; // 0x01 (Arrow Up / W)
export const KEY_MASK_DOWN     = 1 << 1; // 0x02 (Arrow Down / S)
export const KEY_MASK_LEFT     = 1 << 2; // 0x04 (Arrow Left / A)
export const KEY_MASK_RIGHT    = 1 << 3; // 0x08 (Arrow Right / D)
export const KEY_MASK_ACTION_A = 1 << 4; // 0x10 (Space / Enter / Z - Paint)
export const KEY_MASK_ACTION_B = 1 << 5; // 0x20 (Shift / X / C - Change Color)
export const KEY_MASK_RESET    = 1 << 6; // 0x40 (R - Clear Screen)

export class Memory {
  constructor() {
    // Map of pageNumber (address >>> 12) -> Uint8Array(4096)
    this.pages = new Map();
    // Track addresses written during the latest instruction cycle
    this.lastWritten = new Set();
    // Track whether VRAM has mutated since last screen refresh
    this.vramDirty = false;
  }

  // Get or allocate a 4 KB page
  _getPage(pageIndex, create = false) {
    let page = this.pages.get(pageIndex);
    if (!page && create) {
      page = new Uint8Array(PAGE_SIZE);
      this.pages.set(pageIndex, page);
    }
    return page;
  }

  // Load a binary slice into virtual RAM starting at vaddr
  loadSegment(vaddr, buffer) {
    let addr = Number(vaddr);
    for (let i = 0; i < buffer.length; i++) {
      this.write8(addr + i, buffer[i]);
    }
  }

  // Load an array of 32-bit instructions (for backwards compatibility)
  loadProgram(address, instructions) {
    let addr = Number(address);
    for (let i = 0; i < instructions.length; i++) {
      this.write32(addr + i * 4, instructions[i]);
    }
  }

  // Read single byte (8-bit)
  read8(addr) {
    const numAddr = Number(addr);
    const pageIndex = Math.floor(numAddr / PAGE_SIZE);
    const offset = numAddr & PAGE_MASK;
    const page = this._getPage(pageIndex, false);
    return page ? page[offset] : 0;
  }

  // Write single byte (8-bit)
  write8(addr, value) {
    const numAddr = Number(addr);
    const pageIndex = Math.floor(numAddr / PAGE_SIZE);
    const offset = numAddr & PAGE_MASK;
    const page = this._getPage(pageIndex, true);
    page[offset] = value & 0xff;
    this.lastWritten.add(numAddr);

    if (numAddr >= VRAM_BASE && numAddr < VRAM_END) {
      this.vramDirty = true;
    }
  }

  // Read 16-bit little-endian integer
  read16(addr) {
    const numAddr = Number(addr);
    const b0 = this.read8(numAddr);
    const b1 = this.read8(numAddr + 1);
    return ((b0) | (b1 << 8)) >>> 0;
  }

  // Write 16-bit little-endian integer
  write16(addr, value) {
    const numAddr = Number(addr);
    const val = value & 0xffff;
    this.write8(numAddr, val & 0xff);
    this.write8(numAddr + 1, (val >>> 8) & 0xff);
  }

  // Read 32-bit little-endian integer
  read32(addr) {
    const numAddr = Number(addr);
    const b0 = this.read8(numAddr);
    const b1 = this.read8(numAddr + 1);
    const b2 = this.read8(numAddr + 2);
    const b3 = this.read8(numAddr + 3);
    return ((b0) | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  // Write 32-bit little-endian integer
  write32(addr, value) {
    const numAddr = Number(addr);
    const val = value >>> 0;
    this.write8(numAddr, val & 0xff);
    this.write8(numAddr + 1, (val >>> 8) & 0xff);
    this.write8(numAddr + 2, (val >>> 16) & 0xff);
    this.write8(numAddr + 3, (val >>> 24) & 0xff);
  }

  // Read 64-bit little-endian integer (BigInt)
  read64(addr) {
    const numAddr = Number(addr);
    const low = BigInt(this.read32(numAddr));
    const high = BigInt(this.read32(numAddr + 4));
    return (high << 32n) | low;
  }

  // Write 64-bit little-endian integer (BigInt)
  write64(addr, value) {
    const numAddr = Number(addr);
    const val = BigInt(value);
    const low = Number(val & 0xffffffffn);
    const high = Number((val >> 32n) & 0xffffffffn);
    this.write32(numAddr, low);
    this.write32(numAddr + 4, high);
  }

  // Read IEEE-754 single-precision float (32-bit)
  readFloat32(addr) {
    const raw = this.read32(addr);
    const buf = new ArrayBuffer(4);
    new Uint32Array(buf)[0] = raw;
    return new Float32Array(buf)[0];
  }

  // Write IEEE-754 single-precision float (32-bit)
  writeFloat32(addr, val) {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = val;
    this.write32(addr, new Uint32Array(buf)[0]);
  }

  // Read IEEE-754 double-precision float (64-bit)
  readFloat64(addr) {
    const raw = this.read64(addr);
    const buf = new ArrayBuffer(8);
    new BigUint64Array(buf)[0] = raw;
    return new Float64Array(buf)[0];
  }

  // Write IEEE-754 double-precision float (64-bit)
  writeFloat64(addr, val) {
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = val;
    this.write64(addr, new BigUint64Array(buf)[0]);
  }

  // Clear memory and reset pages (used on reset / reloading)
  clear() {
    this.pages.clear();
    this.segments = [];
    this.lastWritten.clear();
    this.vramDirty = false;
  }

  // High-performance page-by-page block read into existing typed array
  readBlockInto(addr, targetArray, targetOffset = 0, length = targetArray.length) {
    let currentAddr = Number(addr);
    let bytesRemaining = length;
    let dst = targetOffset;

    while (bytesRemaining > 0) {
      const pageIndex = Math.floor(currentAddr / PAGE_SIZE);
      const pageOffset = currentAddr & PAGE_MASK;
      const bytesInPage = Math.min(bytesRemaining, PAGE_SIZE - pageOffset);
      const page = this.pages.get(pageIndex);

      if (page) {
        targetArray.set(page.subarray(pageOffset, pageOffset + bytesInPage), dst);
      } else {
        targetArray.fill(0, dst, dst + bytesInPage);
      }

      currentAddr += bytesInPage;
      dst += bytesInPage;
      bytesRemaining -= bytesInPage;
    }
  }

  // Read consecutive bytes into a new Uint8Array (for UI memory hex view & tests)
  readBlock(addr, length) {
    const result = new Uint8Array(length);
    this.readBlockInto(addr, result, 0, length);
    return result;
  }

  // Read entire VRAM framebuffer (320x240 RGBA, 307200 bytes)
  readVram(targetArray = null) {
    const buffer = targetArray || new Uint8ClampedArray(FB_SIZE);
    this.readBlockInto(VRAM_BASE, buffer, 0, FB_SIZE);
    return buffer;
  }

  // Check and clear VRAM dirty status
  isVramDirty() {
    return this.vramDirty;
  }

  clearVramDirty() {
    this.vramDirty = false;
  }

  // Deallocate a specific 4 KB page
  freePage(pageIndex) {
    return this.pages.delete(pageIndex);
  }

  // Deallocate a range of virtual addresses (used by sys_munmap and sys_brk shrink)
  freeRange(startAddr, length) {
    const start = Number(startAddr);
    const len = Number(length);
    if (len <= 0) return 0;
    const end = start + len;

    // 1. If start is mid-page, zero out the freed sub-page slice without deleting the active lower part of the page
    const startOffset = start & PAGE_MASK;
    if (startOffset !== 0) {
      const firstPageIdx = Math.floor(start / PAGE_SIZE);
      const page = this.pages.get(firstPageIdx);
      if (page) {
        const clearEnd = Math.min(PAGE_SIZE, startOffset + len);
        page.fill(0, startOffset, clearEnd);
      }
    }

    // 2. Delete all fully reclaimed 4 KB pages in [ceil(start / PAGE_SIZE), floor((end - 1) / PAGE_SIZE)]
    const firstFullPage = Math.ceil(start / PAGE_SIZE);
    const lastPage = Math.floor((end - 1) / PAGE_SIZE);
    let freedCount = 0;
    for (let p = firstFullPage; p <= lastPage; p++) {
      if (this.pages.delete(p)) {
        freedCount++;
      }
    }
    return freedCount;
  }

  // Total allocated 4 KB pages currently in resident memory
  getPageCount() {
    return this.pages.size;
  }

  // Total resident byte size of all mapped 4 KB pages
  getMappedBytes() {
    return this.pages.size * PAGE_SIZE;
  }
}
