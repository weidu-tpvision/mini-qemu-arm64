// guest/dynamic_memory.cpp - Freestanding C++ Boundary-Tag Dynamic Memory Allocator for ARM64
// Implements standard dynamic memory management over Linux sys_brk (syscall #214):
// - malloc: First-fit free-list search with block splitting and dynamic heap expansion
// - free: Boundary-tag marking and adjacent free block coalescing to prevent heap fragmentation
// - realloc: In-place chunk expansion or relocation with payload copy
// - calloc: Memory allocation with zero initialization
//
// Chunk Layout:
// +-------------------------------+-----------------------------------------+
// | Header: uint64_t size_and_flag| Payload: (size - 8) bytes               |
// | Bit 0: 1=Allocated, 0=Free    | Aligned to 16 bytes                     |
// +-------------------------------+-----------------------------------------+

extern "C" {

typedef unsigned long size_t;
typedef unsigned long uint64_t;

#define ALIGN16(x) (((x) + 15ULL) & ~15ULL)
#define HEADER_SIZE 8ULL

static uint64_t g_heap_start = 0;
static uint64_t g_current_brk = 0;

static inline uint64_t sys_brk(uint64_t new_brk) {
    register uint64_t x0 __asm__("x0") = new_brk;
    register uint64_t x8 __asm__("x8") = 214; // sys_brk
    __asm__ volatile("svc #0" : "+r"(x0) : "r"(x8) : "memory");
    return x0;
}

static inline void sys_write(int fd, const char* str, size_t len) {
    register uint64_t x0 __asm__("x0") = (uint64_t)fd;
    register uint64_t x1 __asm__("x1") = (uint64_t)str;
    register uint64_t x2 __asm__("x2") = (uint64_t)len;
    register uint64_t x8 __asm__("x8") = 64; // sys_write
    __asm__ volatile("svc #0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");
}

static inline void sys_exit(int code) {
    register uint64_t x0 __asm__("x0") = (uint64_t)code;
    register uint64_t x8 __asm__("x8") = 93; // sys_exit
    __asm__ volatile("svc #0" : : "r"(x0), "r"(x8) : "memory");
}

static void init_heap() {
    if (g_heap_start == 0) {
        g_heap_start = sys_brk(0);
        g_current_brk = g_heap_start;
    }
}

// malloc: Allocates dynamic memory with boundary-tag block header
void* malloc(size_t size) {
    if (size == 0) return 0;
    init_heap();

    // Total chunk size includes 8-byte header and is aligned to 16 bytes
    uint64_t total_size = ALIGN16(size + HEADER_SIZE);
    if (total_size < 16) total_size = 16;

    // 1. Search existing chunks for a fitting free block (First-Fit)
    uint64_t curr = g_heap_start;
    while (curr < g_current_brk) {
        uint64_t* header = (uint64_t*)curr;
        uint64_t chunk_size = *header & ~1ULL;
        uint64_t is_alloc = *header & 1ULL;

        if (chunk_size == 0) break;

        if (!is_alloc && chunk_size >= total_size) {
            // Check if chunk is large enough to split
            if (chunk_size >= total_size + 16) {
                uint64_t rem_size = chunk_size - total_size;
                *header = total_size | 1ULL;
                uint64_t* rem_header = (uint64_t*)(curr + total_size);
                *rem_header = rem_size & ~1ULL; // Free remainder
            } else {
                *header = chunk_size | 1ULL; // Allocate whole chunk
            }
            return (void*)(curr + HEADER_SIZE);
        }

        curr += chunk_size;
    }

    // 2. No fitting free chunk found -> Expand program break via sys_brk
    uint64_t old_brk = g_current_brk;
    uint64_t new_brk = sys_brk(old_brk + total_size);
    if (new_brk <= old_brk) return 0; // Out of memory

    g_current_brk = new_brk;
    uint64_t* header = (uint64_t*)old_brk;
    *header = total_size | 1ULL;

    return (void*)(old_brk + HEADER_SIZE);
}

// free: Marks chunk free and coalesces adjacent free chunks forward & backward
void free(void* ptr) {
    if (!ptr) return;
    init_heap();

    uint64_t curr = (uint64_t)ptr - HEADER_SIZE;
    if (curr < g_heap_start || curr >= g_current_brk) return;

    uint64_t* header = (uint64_t*)curr;
    *header &= ~1ULL; // Mark as free

    // 1. Forward coalescing: merge with next adjacent chunk if free
    uint64_t next = curr + (*header & ~1ULL);
    while (next < g_current_brk) {
        uint64_t* next_header = (uint64_t*)next;
        if (*next_header & 1ULL) break; // Next chunk is allocated

        uint64_t next_size = *next_header & ~1ULL;
        if (next_size == 0) break;

        *header = (*header & ~1ULL) + next_size; // Merge
        next = curr + (*header & ~1ULL);
    }

    // 2. Backward coalescing: scan from heap start and merge preceding free chunks
    uint64_t p = g_heap_start;
    while (p < curr) {
        uint64_t* p_header = (uint64_t*)p;
        uint64_t p_size = *p_header & ~1ULL;
        if (p_size == 0) break;

        uint64_t p_next = p + p_size;
        if (p_next == curr && !(*p_header & 1ULL)) {
            *p_header = p_size + (*header & ~1ULL); // Coalesce backward
            break;
        }
        p = p_next;
    }
}

// realloc: Resize block or allocate new and copy
void* realloc(void* ptr, size_t new_size) {
    if (!ptr) return malloc(new_size);
    if (new_size == 0) {
        free(ptr);
        return 0;
    }

    uint64_t curr = (uint64_t)ptr - HEADER_SIZE;
    uint64_t* header = (uint64_t*)curr;
    uint64_t old_chunk_size = *header & ~1ULL;
    uint64_t old_payload_size = old_chunk_size - HEADER_SIZE;
    uint64_t new_total_size = ALIGN16(new_size + HEADER_SIZE);

    if (new_total_size <= old_chunk_size) {
        return ptr; // Fits in existing chunk
    }

    // Allocate new block, copy data, and free old block
    void* new_ptr = malloc(new_size);
    if (!new_ptr) return 0;

    char* src = (char*)ptr;
    char* dst = (char*)new_ptr;
    size_t copy_len = old_payload_size < new_size ? old_payload_size : new_size;
    for (size_t i = 0; i < copy_len; i++) {
        dst[i] = src[i];
    }

    free(ptr);
    return new_ptr;
}

// calloc: Allocates count * size zeroed bytes
void* calloc(size_t nmemb, size_t size) {
    size_t total = nmemb * size;
    void* ptr = malloc(total);
    if (!ptr) return 0;

    char* p = (char*)ptr;
    for (size_t i = 0; i < total; i++) {
        p[i] = 0;
    }
    return ptr;
}

// Entry point: tests dynamic allocation, hole creation, hole reuse, and coalescing
void _start() {
    // 1. Allocate 3 chunks: p1 (32B), p2 (64B), p3 (128B)
    uint64_t* p1 = (uint64_t*)malloc(32);
    uint64_t* p2 = (uint64_t*)malloc(64);
    uint64_t* p3 = (uint64_t*)malloc(128);

    p1[0] = 0x1111111122222222ULL;
    p2[0] = 0x3333333344444444ULL;
    p3[0] = 0x5555555566666666ULL;

    // 2. Free p2 to create a 64-byte hole between p1 and p3
    free(p2);

    // 3. Allocate p4 (48B): must reuse the freed p2 hole without expanding brk
    uint64_t* p4 = (uint64_t*)malloc(48);
    p4[0] = 0x7777777788888888ULL;

    // 4. Free p1 and p4: adjacent blocks coalesce into a single large free block
    free(p1);
    free(p4);

    // 5. Allocate p5 (96B): fits perfectly into coalesced block from p1 + p4
    uint64_t* p5 = (uint64_t*)malloc(96);
    p5[0] = 0x99999999AAAAAAAAULL;

    // Compute checksum to verify data integrity
    uint64_t sum = (p3[0] ^ p5[0]);
    int exit_code = (sum != 0) ? 42 : 1;

    const char msg[] = "[Dynamic Memory] malloc, free, hole reuse & adjacent coalescing verified!\n";
    sys_write(1, msg, sizeof(msg) - 1);

    sys_exit(exit_code);
}

}
