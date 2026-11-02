// guest/fib_rec.cpp - Recursive Fibonacci(10) in Freestanding ARM64 C++
// Demonstrates nested stack frames (STP pre-index / LDP post-index) and BL/RET recursion.

extern "C" long fib(long n) {
    if (n <= 1) {
        return n;
    }
    // Requires saving LR (X30) and local state across recursive BL calls on the stack (SP)
    return fib(n - 1) + fib(n - 2);
}

extern "C" void _start() {
    long result = fib(10); // Returns 55

    // Linux AArch64 sys_exit (X8 = 93, X0 = exit status)
    register long x0 __asm__("x0") = result;
    register long x8 __asm__("x8") = 93;
    __asm__ volatile("svc #0" : : "r"(x0), "r"(x8));
}
