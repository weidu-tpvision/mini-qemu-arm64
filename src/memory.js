// memory.js - Page-Based Virtual Memory for Mini-QEMU (4 KB Pages, Little-Endian)

const PAGE_SIZE = 4096; // 4 KB page size
const PAGE_MASK = PAGE_SIZE - 1;
const PAGE_SHIFT = 12;

export class Memory {
  constructor() {
    // Map of pageNumber (address >>> 12) -> Uint8Array(4096)
    this.pages = new Map();
    // Track addresses written during the latest instruction cycle
    this.lastWritten = new Set();
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
    const pageIndex = Math.floor(addr / PAGE_SIZE);
    const offset = addr & PAGE_MASK;
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
  }

  // Read 16-bit little-endian integer
  read16(addr) {
    const b0 = this.read8(addr);
    const b1 = this.read8(addr + 1);
    return ((b0) | (b1 << 8)) >>> 0;
  }

  // Write 16-bit little-endian integer
  write16(addr, value) {
    const val = value & 0xffff;
    this.write8(addr, val & 0xff);
    this.write8(addr + 1, (val >>> 8) & 0xff);
  }

  // Read 32-bit little-endian integer
  read32(addr) {
    const b0 = this.read8(addr);
    const b1 = this.read8(addr + 1);
    const b2 = this.read8(addr + 2);
    const b3 = this.read8(addr + 3);
    return ((b0) | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  // Write 32-bit little-endian integer
  write32(addr, value) {
    const val = value >>> 0;
    this.write8(addr, val & 0xff);
    this.write8(addr + 1, (val >>> 8) & 0xff);
    this.write8(addr + 2, (val >>> 16) & 0xff);
    this.write8(addr + 3, (val >>> 24) & 0xff);
  }

  // Read 64-bit little-endian integer (BigInt)
  read64(addr) {
    const low = BigInt(this.read32(addr));
    const high = BigInt(this.read32(addr + 4));
    return (high << 32n) | low;
  }

  // Write 64-bit little-endian integer (BigInt)
  write64(addr, value) {
    const val = BigInt(value);
    const low = Number(val & 0xffffffffn);
    const high = Number((val >> 32n) & 0xffffffffn);
    this.write32(addr, low);
    this.write32(addr + 4, high);
  }

  // Clear memory and reset pages (used on reset / reloading)
  clear() {
    this.pages.clear();
    this.segments = [];
    this.lastWritten.clear();
  }

  // Read consecutive bytes into a Uint8Array (for UI memory hex view)
  readBlock(addr, length) {
    const start = Number(addr);
    const result = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      result[i] = this.read8(start + i);
    }
    return result;
  }
}
