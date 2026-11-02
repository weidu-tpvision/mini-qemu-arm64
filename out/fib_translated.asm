; =============================================================================
; Auto-generated x86-64 Assembly translated from ARM64 Binary
; Source File   : bin/fib.elf
; Target Arch   : x86-64 (Intel / AMD 64-bit)
; Syntax        : Intel / NASM
; =============================================================================

global _start
section .text

_start:
    mov rax, 0                                       ; [ARM: movz x0, #0                  | 0xd2800000] ; bytes: 48 c7 c0 00 00 00 00
    mov rbx, 1                                       ; [ARM: movz x1, #1                  | 0xd2800021] ; bytes: 48 c7 c3 01 00 00 00
    mov rcx, 10                                      ; [ARM: movz x2, #10                 | 0xd2800142] ; bytes: 48 c7 c1 0a 00 00 00

label_1_0x40000c:
    lea rdx, [rax + rbx]                             ; [ARM: add x3, x0, x1               | 0x8b010003] ; bytes: 48 8d 14 18
    mov rax, rbx                                     ; [ARM: mov x0, x1                   | 0xaa0103e0] ; bytes: 48 89 d8
    mov rbx, rdx                                     ; [ARM: mov x1, x3                   | 0xaa0303e1] ; bytes: 48 89 d3
    sub rcx, 1                                       ; [ARM: subs x2, x2, #1              | 0xf1000442] ; bytes: 48 83 e9 01
    jnz label_1_0x40000c                             ; [ARM: b.ne [offset -16B]           | 0x54ffff81] ; bytes: 75 f0
    mov r10, 93                                      ; [ARM: movz x8, #93                 | 0xd2800ba8] ; bytes: 48 c7 c0 5d 00 00 00
    mov rdi, rax ; mov rax, 60 ; syscall             ; [ARM: svc #0                       | 0xd4000001] ; bytes: 48 89 c7 48 c7 c0 3c 00 00 00 0f 05