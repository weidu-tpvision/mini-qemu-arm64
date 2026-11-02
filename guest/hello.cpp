// guest/hello.cpp - Freestanding C++ String I/O Program for ARM64
// Uses Linux sys_write (syscall #64) and sys_exit (syscall #93)

extern "C" void _start() {
    // 1. Test memory store & load
    volatile long test_storage = 0;
    test_storage = 0x1234;
    long retrieved = test_storage;

    // 2. String buffer to print
    const char message[] = "Hello from ARM64 running on Windows via Mini-QEMU!\n";
    long message_len = sizeof(message) - 1; // 51 bytes

    // 3. Issue sys_write(fd=1, buf=message, count=message_len)
    register long x0 asm("x0") = 1;           // fd: stdout
    register long x1 asm("x1") = (long)message; // buffer pointer
    register long x2 asm("x2") = message_len; // count
    register long x8 asm("x8") = 64;          // __NR_write
    asm volatile(
        "svc #0\n"
        : "+r"(x0)
        : "r"(x1), "r"(x2), "r"(x8)
        : "memory"
    );

    // 4. Issue sys_exit(0)
    x0 = 0;
    x8 = 93; // __NR_exit
    asm volatile(
        "svc #0\n"
        :
        : "r"(x0), "r"(x8)
        : "memory"
    );
}
