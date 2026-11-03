// guest/plasma.cpp - Level 1 MMIO Framebuffer Demoscene Plasma for Mini-QEMU
// Demonstrates bare-metal ARM64 graphics rendering into memory-mapped VRAM.
//
// Display Specifications:
// - Framebuffer Base Address: 0x00800000 (VRAM_BASE)
// - Dimensions: 320 x 240 pixels
// - Format: 32-bit RGBA (8-bit Red, 8-bit Green, 8-bit Blue, 8-bit Alpha = 0xFF)
// - Total Size: 320 * 240 * 4 = 307,200 bytes (0x4B000)

extern "C" {

#define VRAM_BASE   0x00800000
#define FB_WIDTH    320
#define FB_HEIGHT   240
#define TOTAL_PIXELS (FB_WIDTH * FB_HEIGHT)

// Linux ARM64 system calls
static inline void sys_exit(int code) {
    register long x0 __asm__("x0") = code;
    register long x8 __asm__("x8") = 93; // __NR_exit
    __asm__ volatile("svc #0" : : "r"(x0), "r"(x8) : "memory");
}

static inline void sys_write(int fd, const char* buf, unsigned long len) {
    register long x0 __asm__("x0") = fd;
    register const char* x1 __asm__("x1") = buf;
    register unsigned long x2 __asm__("x2") = len;
    register long x8 __asm__("x8") = 64; // __NR_write
    __asm__ volatile("svc #0" : : "r"(x0), "r"(x1), "r"(x2), "r"(x8) : "memory");
}

// Pack 8-bit R, G, B, A components into a 32-bit Little-Endian pixel word
static inline unsigned int make_rgba(unsigned char r, unsigned char g, unsigned char b, unsigned char a = 0xFF) {
    return ((unsigned int)a << 24) |
           ((unsigned int)b << 16) |
           ((unsigned int)g << 8)  |
           ((unsigned int)r);
}

void _start() {
    volatile unsigned int* vram = (volatile unsigned int*)VRAM_BASE;

    // Render smooth procedural color gradient across all 320x240 pixels
    for (int y = 0; y < FB_HEIGHT; ++y) {
        for (int x = 0; x < FB_WIDTH; ++x) {
            unsigned char r = (unsigned char)((x * 255) / (FB_WIDTH - 1));
            unsigned char g = (unsigned char)((y * 255) / (FB_HEIGHT - 1));
            unsigned char b = (unsigned char)(((x + y) * 255) / (FB_WIDTH + FB_HEIGHT - 2));
            unsigned char a = 0xFF;

            *vram++ = make_rgba(r, g, b, a);
        }
    }

    const char msg[] = "[Graphics] Level 1 MMIO Framebuffer rendered 320x240 pixels into VRAM (0x00800000)!\n";
    sys_write(1, msg, sizeof(msg) - 1);

    sys_exit(0);
}

}
