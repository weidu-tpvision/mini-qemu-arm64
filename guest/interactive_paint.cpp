// guest/interactive_paint.cpp - Interactive MMIO Framebuffer Painter & Gamepad Demo
// Demonstrates bare-metal ARM64 interactive input handling and dynamic 60 FPS rendering.
//
// Hardware Architecture:
// - VRAM Framebuffer Base Address: 0x00800000 (320 x 240, 32-bit RGBA in Little-Endian 0xAABBGGRR)
// - MMIO Input Peripheral Base   : 0x00850000
//     * 0x00850000: Key state bitmask (Up=1, Down=2, Left=4, Right=8, Paint=16, Color=32, Clear=64, Exit=128)
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

void clear_canvas(unsigned int bg_color) {
    volatile unsigned int* fb = (volatile unsigned int*)VRAM_BASE;
    for (int i = 0; i < TOTAL_PIXELS; ++i) {
        fb[i] = bg_color;
    }
}

void _start() {
    volatile unsigned int* fb = (volatile unsigned int*)VRAM_BASE;
    const unsigned int bg_color = 0xFF2A170F; // Dark Slate (#0F172A in LE 0xAABBGGRR)

    int cur_x = 160;
    int cur_y = 120;
    unsigned int prev_keys = 0;
    unsigned int palette[4] = {
        0xFFF8BD38, // Cyan    (#38BDF8)
        0xFF0B9EF5, // Amber   (#F59E0B)
        0xFF81B910, // Emerald (#10B981)
        0xFF5E3FF4  // Rose    (#F43F5E)
    };
    int color_idx = 0;

    clear_canvas(bg_color);
    volatile unsigned int* cursor_ptr = &fb[cur_y * FB_WIDTH + cur_x];
    unsigned int saved_pixel = bg_color;

    while (1) {
        // Restore pixel underneath previous frame's white cursor dot
        *cursor_ptr = saved_pixel;

        unsigned int keys = REG_KEY_STATE;
        unsigned int mouse_btn = REG_POINTER_BTN;

        if (keys & KEY_EXIT) break;

        if ((keys & KEY_CLEAR) && !(prev_keys & KEY_CLEAR)) {
            prev_keys = keys;
            clear_canvas(bg_color);
            cursor_ptr = &fb[cur_y * FB_WIDTH + cur_x];
            saved_pixel = bg_color;
        }

        // Move cursor with directional controls
        if (keys & KEY_UP)    { cur_y -= 2; if (cur_y < 4) cur_y = 4; }
        if (keys & KEY_DOWN)  { cur_y += 2; if (cur_y > 235) cur_y = 235; }
        if (keys & KEY_LEFT)  { cur_x -= 2; if (cur_x < 4) cur_x = 4; }
        if (keys & KEY_RIGHT) { cur_x += 2; if (cur_x > 315) cur_x = 315; }

        // Mouse pointer override if mouse clicked
        if (mouse_btn & 1) {
            cur_x = REG_POINTER_X;
            cur_y = REG_POINTER_Y;
        }

        // Rising-edge detection on Color cycle key
        if ((keys & KEY_COLOR) && !(prev_keys & KEY_COLOR)) {
            color_idx = (color_idx + 1) & 3;
        }
        prev_keys = keys;

        cursor_ptr = &fb[cur_y * FB_WIDTH + cur_x];

        // Paint 5-pixel cross brush stroke
        if ((keys & KEY_PAINT) || (mouse_btn & 1)) {
            unsigned int color = palette[color_idx];
            cursor_ptr[0] = color;
            cursor_ptr[1] = color;
            cursor_ptr[-1] = color;
            cursor_ptr[FB_WIDTH] = color;
            cursor_ptr[-FB_WIDTH] = color;
        }

        // Save underlying pixel and draw white cursor dot
        saved_pixel = *cursor_ptr;
        *cursor_ptr = 0xFFFFFFFF;

        // Yield execution to host VSync (60 FPS)
        sys_yield();
    }

    sys_exit(0);
}

}
