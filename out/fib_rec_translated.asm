; =============================================================================
; Auto-generated x86-64 Assembly translated from ARM64 Binary
; Source File   : fib_rec.elf
; Target Arch   : x86-64 (Intel / AMD 64-bit)
; Syntax        : Intel / NASM
; =============================================================================

global _start
section .text

_start:
    mov rax, 10                                      ; [ARM: movz x0, #10                 | 0xd2800140] ; bytes: 48 c7 c0 0a 00 00 00
    call func_1_0x400010                             ; [ARM: bl [offset +12B]             | 0x94000003] ; bytes: e8 13 00 00 00
    mov r10, 93                                      ; [ARM: movz x8, #93                 | 0xd2800ba8] ; bytes: 48 c7 c0 5d 00 00 00
    mov rdi, rax ; mov rax, 60 ; syscall             ; [ARM: svc #0                       | 0xd4000001] ; bytes: 48 89 c7 48 c7 c0 3c 00 00 00 0f 05

func_1_0x400010:
    cmp rax, 1                                       ; [ARM: cmp x0, #1                   | 0xf100041f] ; bytes: 48 83 f8 01
    jg label_2_0x40001c                              ; [ARM: b.gt [offset +8B]            | 0x5400004c] ; bytes: 7f 01
    ret                                              ; [ARM: ret                          | 0xd65f03c0] ; bytes: c3

label_2_0x40001c:
    sub rsp, 32 ; mov [rsp], rbp ; mov [rsp+8], r11  ; [ARM: stp x29, x30, [sp, #-32]!    | 0xa9be7bfd] ; bytes: 48 89 2c 24 4c 89 5c 24 08
    mov [rsp+16], rax                                ; [ARM: str x0, [sp, #16]            | 0xf9000be0] ; bytes: 48 89 04 24
    sub rax, 1                                       ; [ARM: sub x0, x0, #1               | 0xd1000400] ; bytes: 48 83 e8 01
    call func_1_0x400010                             ; [ARM: bl [offset -24B]             | 0x97fffffa] ; bytes: e8 e3 ff ff ff
    mov rbx, [rsp+16]                                ; [ARM: ldr x1, [sp, #16]            | 0xf9400be1] ; bytes: 48 8b 04 24
    mov [rsp+24], rax                                ; [ARM: str x0, [sp, #24]            | 0xf9000fe0] ; bytes: 48 89 04 24
    lea rax, [rbx - 2]                               ; [ARM: sub x0, x1, #2               | 0xd1000820] ; bytes: 48 8d 43 fe
    call func_1_0x400010                             ; [ARM: bl [offset -40B]             | 0x97fffff6] ; bytes: e8 d2 ff ff ff
    mov rbx, [rsp+24]                                ; [ARM: ldr x1, [sp, #24]            | 0xf9400fe1] ; bytes: 48 8b 04 24
    lea rax, [rbx + rax]                             ; [ARM: add x0, x1, x0               | 0x8b000020] ; bytes: 48 8d 04 03
    mov rbp, [rsp] ; mov r11, [rsp+8] ; add rsp, 32  ; [ARM: ldp x29, x30, [sp], #32      | 0xa8c27bfd] ; bytes: 48 8b 2c 24 4c 8b 5c 24 08
    ret                                              ; [ARM: ret                          | 0xd65f03c0] ; bytes: c3