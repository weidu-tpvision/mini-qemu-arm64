// guest/interactive_paint.cpp - Interactive MMIO Framebuffer Painter & Gamepad Demo
// Demonstrates bare-metal ARM64 interactive input handling and dynamic rendering.
//
// Hardware Architecture:
// - VRAM Framebuffer Base Address: 0x00800000 (320 x 240, 32-bit RGBA)
// - MMIO Input Peripheral Base   : 0x00850000
//     * 0x00850000: Key state bitmask (Up=1, Down=2, Left=4, Right=8, Paint=16, Color=32, Clear=64)
//     * 0x00850004: Last key ASCII code
//     * 0x00850008: Pointer X (0..319)
//     * 0x0085000C: Pointer Y (0..239)
//     * 0x00850010: Pointer Buttons (Bit 0 = Left click)
//     * 0x00850014: Frame counter
// - Syscall 124 (sys_sched_yield): VSync frame yield back to host display

extern "C" {

#define VRAM_BASE       0x00800000
#define FB_WIDTH        320
#define FB_HEIGHT       240
#define TOTAL_PIXELS    (FB_WIDTH * FB_HEIGHT)

#define INPUT_BASE      0x00850000
#define REG_KEY_STATE   (*(volatile unsigned int*)(INPUT_BASE + 0x00))
#define REG_LAST_KEY    (*(volatile unsigned int*)(INPUT_BASE + 0x04))
#define REG_POINTER_X   (*(volatile unsigned int*)(INPUT_BASE + 0x08))
#define REG_POINTER_Y   (*(volatile unsigned int*)(INPUT_BASE + 0x0C))
#define REG_POINTER_BTN (*(volatile unsigned int*)(INPUT_BASE + 0x10))
#define REG_FRAME_COUNT (*(volatile unsigned int*)(INPUT_BASE + 0x14))

#define KEY_UP       (1 << 0)
#define KEY_DOWN     (1 << 1)
#define KEY_LEFT     (1 << 2)
#define KEY_RIGHT    (1 << 3)
#define KEY_PAINT    (1 << 4) // Space / Enter / Z / Mouse Left
#define KEY_COLOR    (1 << 5) // Shift / X / C
#define KEY_CLEAR    (1 << 6) // R
#define KEY_EXIT     (1 << 7) // Q / Esc

static inline void sys_exit(int code) {
    register long x0 __asm__("x0") = code;
    register long x8 __asm__("x8") = 93;
    __asm__ volatile("svc #0" : : "r"(x0), "r"(x8) : "memory");
}

static inline void sys_yield() {
    register long x8 __asm__("x8") = 124; // __NR_sched_yield
    __asm__ volatile("svc #0" : : "r"(x8) : "memory");
}

static inline void put_pixel(int x, int y, unsigned int rgba) {
    if (x >= 0 && x < FB_WIDTH && y >= 0 && y < FB_HEIGHT) {
        volatile unsigned int* fb = (volatile unsigned int*)VRAM_BASE;
        fb[y * FB_WIDTH + x] = rgba;
    }
}

void clear_canvas(unsigned int bg_color) {
    volatile unsigned int* fb = (volatile unsigned int*)VRAM_BASE;
    for (int i = 0; i < TOTAL_PIXELS; ++i) {
        fb[i] = bg_color;
    }
}

void _start() {
    clear_canvas(0xFF0F172A); // Dark slate canvas

    int cur_x = 160;
    int cur_y = 120;
    unsigned int palette[4] = {
        0xFF38BDF8, // Cyan
        0xFFF59E0B, // Amber
        0xFF10B981, // Emerald Green
        0xFFF43F5E  // Rose Red
    };
    int color_idx = 0;

    while (1) {
        unsigned int keys = REG_KEY_STATE;
        unsigned int mouse_btn = REG_POINTER_BTN;

        if (keys & KEY_EXIT) break;

        // Move cursor with directional controls
        if (keys & KEY_UP)    if (cur_y > 4) cur_y -= 2;
        if (keys & KEY_DOWN)  if (cur_y < FB_HEIGHT - 5) cur_y += 2;
        if (keys & KEY_LEFT)  if (cur_x > 4) cur_x -= 2;
        if (keys & KEY_RIGHT) if (cur_x < FB_WIDTH - 5) cur_x += 2;

        // Mouse pointer override if mouse active
        if (mouse_btn & 1) {
            cur_x = REG_POINTER_X;
            cur_y = REG_POINTER_Y;
        }

        if (keys & KEY_CLEAR) {
            clear_canvas(0xFF0F172A);
        }

        if (keys & KEY_COLOR) {
            color_idx = (color_idx + 1) & 3;
        }

        // Paint brush stroke (3x3 pixels)
        if ((keys & KEY_PAINT) || (mouse_btn & 1)) {
            unsigned int color = palette[color_idx];
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dx = -1; dx <= 1; ++dx) {
                    put_pixel(cur_x + dx, cur_y + dy, color);
                }
            }
        }

        // Draw crosshair cursor (temporarily or persistent tip)
        put_pixel(cur_x, cur_y, 0xFFFFFFFF);

        // Yield execution to host VSync (60 FPS)
        sys_yield();
    }

    sys_exit(0);
}

}
