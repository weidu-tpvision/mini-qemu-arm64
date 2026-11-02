; =============================================================================
; Auto-generated x86-64 Assembly translated from ARM64 Binary
; Source File   : math_func.elf
; Target Arch   : x86-64 (Intel / AMD 64-bit)
; Syntax        : Intel / NASM
; =============================================================================

global _start
section .text

_start:
    mov rax, 12                                      ; [ARM: movz x0, #12                 | 0xd2800180] ; bytes: 48 c7 c0 0c 00 00 00
    mov rbx, 8                                       ; [ARM: movz x1, #8                  | 0xd2800101] ; bytes: 48 c7 c3 08 00 00 00
    call func_1_0x400014                             ; [ARM: bl [offset +12B]             | 0x94000003] ; bytes: e8 13 00 00 00
    mov r10, 93                                      ; [ARM: movz x8, #93                 | 0xd2800ba8] ; bytes: 48 c7 c0 5d 00 00 00
    mov rdi, rax ; mov rax, 60 ; syscall             ; [ARM: svc #0                       | 0xd4000001] ; bytes: 48 89 c7 48 c7 c0 3c 00 00 00 0f 05

func_1_0x400014:
    sub rsp, 16                                      ; [ARM: sub sp, sp, #16              | 0xd10043ff] ; bytes: 48 83 ec 10
    mov [rsp], rbp ; mov [rsp+8], r11                ; [ARM: stp x29, x30, [sp]           | 0xa9007bfd] ; bytes: 48 89 2c 24 4c 89 5c 24 08
    mov rcx, rax ; imul rcx, rbx                     ; [ARM: mul x2, x0, x1               | 0x9b017c02] ; bytes: 48 89 c1 48 0f af cb
    mov rdx, 2                                       ; [ARM: movz x3, #2                  | 0xd2800043] ; bytes: 48 c7 c2 02 00 00 00
    push rax ; mov rax, rcx ; xor rdx, rdx ; div rdx ; mov rcx, rax ; pop rax ; [ARM: udiv x2, x2, x3              | 0x9ac30842] ; bytes: 50 48 89 c8 48 31 d2 48 f7 f2 48 89 c1 58
    mov rsi, rax ; xor rsi, rbx                      ; [ARM: eor x4, x0, x1               | 0xca010004] ; bytes: 48 89 c6 48 31 de
    lea rax, [rcx + rsi]                             ; [ARM: add x0, x2, x4               | 0x8b040040] ; bytes: 48 8d 04 31
    mov rbp, [rsp] ; mov r11, [rsp+8]                ; [ARM: ldp x29, x30, [sp]           | 0xa9407bfd] ; bytes: 48 8b 2c 24 4c 8b 5c 24 08
    add rsp, 16                                      ; [ARM: add sp, sp, #16              | 0x910043ff] ; bytes: 48 83 c4 10
    ret                                              ; [ARM: ret                          | 0xd65f03c0] ; bytes: c3