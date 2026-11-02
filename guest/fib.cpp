// guest/fib.cpp - Freestanding C++ Fibonacci Program for ARM64
// This is pure, bare-metal C++ with zero standard library dependencies.

extern "C" void _start() {
    long a = 0;
    long b = 1;
    long n = 10;

    while (n > 0) {
        long next = a + b;
        a = b;
        b = next;
        n--;
    }

    // Result is in 'a' (55).
    // Issue Linux sys_exit (syscall #93) with exit code 'a'
    register long x0 asm("x0") = a;
    register long x8 asm("x8") = 93; // __NR_exit
    asm volatile(
        "svc #0\n"
        :
        : "r"(x0), "r"(x8)
        : "memory"
    );
}
