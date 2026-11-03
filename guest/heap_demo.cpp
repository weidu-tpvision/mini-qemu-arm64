// guest/heap_demo.cpp - Freestanding C++ Dynamic Heap Allocation Demo for ARM64
// Uses Linux sys_brk (syscall #214), sys_write (syscall #64), and sys_exit (syscall #93)

// Simple bump allocator over sys_brk
extern "C" void* my_malloc(long size) {
    // 1. Query current program break
    register long x0 asm("x0") = 0;
    register long x8 asm("x8") = 214; // sys_brk
    asm volatile("svc #0" : "+r"(x0) : "r"(x8) : "memory");
    long current_brk = x0;

    // 2. Request new break (current_brk + size)
    x0 = current_brk + size;
    x8 = 214;
    asm volatile("svc #0" : "+r"(x0) : "r"(x8) : "memory");

    return (void*)current_brk;
}

extern "C" void _start() {
    // 1. Dynamically allocate an array of 5 64-bit integers on the heap (40 bytes)
    long* array = (long*)my_malloc(40);

    // 2. Populate array with data
    array[0] = 10;
    array[1] = 20;
    array[2] = 30;
    array[3] = 40;
    array[4] = 50;

    // 3. Compute sum from heap
    long sum = 0;
    for (int i = 0; i < 5; i++) {
        sum += array[i]; // sum = 150
    }

    // 4. Print confirmation message via sys_write
    const char msg[] = "[Heap Demo] Successfully allocated 40 bytes on heap via sys_brk! Sum = 150\n";
    long msg_len = sizeof(msg) - 1;

    register long x0 asm("x0") = 1;          // stdout
    register long x1 asm("x1") = (long)msg;  // buffer
    register long x2 asm("x2") = msg_len;    // count
    register long x8 asm("x8") = 64;         // sys_write
    asm volatile("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");

    // 5. Exit with sum as exit code (150)
    x0 = sum;
    x8 = 93; // sys_exit
    asm volatile("svc #0" : : "r"(x0), "r"(x8) : "memory");
}
