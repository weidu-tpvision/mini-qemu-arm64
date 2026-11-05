# ELF Dynamic Linking & Shared Library (.so) Architecture

A comprehensive technical reference detailing the design, implementation, and execution pipeline of the **ELF Dynamic Linker, Shared Object Loader, and AArch64 Relocation Engine** in Mini-QEMU ARM64.

---

## 1. Overview & Objectives

In modern Linux environments, executables are rarely monolithic static binaries. Most production applications depend on shared libraries (`.so`, such as `libc.so.6`, `libm.so.6`, or custom vendor modules) to conserve disk and memory footprints, enable modular updates, and support dynamic plugin architectures.

To execute real-world dynamically-linked ARM64 binaries, Mini-QEMU implements an in-process **Dynamic Linker** ([src/dynamic_linker.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/src/dynamic_linker.js)) that handles:
1. **ELF Program Header Detection:** Recognizes `PT_INTERP` (requesting dynamic linkers like `/lib/ld-linux-aarch64.so.1`) and `PT_DYNAMIC` (pointing to the `_DYNAMIC` tag array).
2. **Dynamic Section Parsing:** Parses dynamic tags including `DT_NEEDED`, `DT_SONAME`, `DT_SYMTAB`, `DT_STRTAB`, `DT_RELA`, `DT_RELASZ`, `DT_RELAENT`, `DT_JMPREL`, and `DT_PLTRELSZ`.
3. **Shared Object Loading:** Loads ELF shared objects (`ET_DYN`) into high virtual memory (`0x20000000+`), respecting ELF program segment alignments and calculating the library's base load bias.
4. **Exported Symbol Resolution:** Parses `.dynsym` and `.dynstr` symbol tables in loaded shared objects, mapping exported function symbols and sizes.
5. **AArch64 Relocation Engine:** Resolves and applies relocations across `.rela.plt` (PLT jumps) and `.rela.dyn` (data/GOT entries), specifically:
   - `R_AARCH64_JUMP_SLOT` (1026)
   - `R_AARCH64_RELATIVE` (1027)
   - `R_AARCH64_GLOB_DAT` (1025)
6. **High-Level Emulation (HLE) Fallback Stubs:** Provides guest trampolines for standard C library functions (e.g. `puts`, `strlen`, `abs`) using isolated `svc #0xdd` traps, allowing dynamically linked executables to interact with host I/O and runtime functions without full OS libc dependencies.
7. **Seamless JIT & Interpreter Parity:** Both the Fetch-Decode-Execute interpreter and the JIT compiler execute dynamically linked binaries with 100% bit-exact parity.

---

## 2. Dynamic Linking Pipeline

```
                       [ ELF Binary (ET_EXEC / ET_DYN) ]
                                      │
                         Has PT_DYNAMIC / PT_INTERP?
                                     / \
                               YES  /   \  NO
                                   ▼     ▼
     ┌────────────────────────────────┐  [ Execute as Static Binary ]
     │      Parse _DYNAMIC Section    │
     │  • DT_STRTAB, DT_SYMTAB        │
     │  • DT_RELA, DT_JMPREL          │
     │  • DT_NEEDED entries           │
     └────────────────┬───────────────┘
                      │
                      ▼
     ┌────────────────────────────────┐
     │   Load DT_NEEDED Dependencies  │
     │  • Find .so in search paths    │
     │  • Allocate load bias (0x20000)│
     │  • Load segments into RAM      │
     │  • Harvest exported symbols    │
     └────────────────┬───────────────┘
                      │
                      ▼
     ┌────────────────────────────────┐
     │   Resolve Symbol References    │
     │  1. Search loaded .so libraries│
     │  2. Fallback to HLE stub map   │
     └────────────────┬───────────────┘
                      │
                      ▼
     ┌────────────────────────────────┐
     │   Process AArch64 Relocations  │
     │  • R_AARCH64_RELATIVE          │
     │  • R_AARCH64_JUMP_SLOT         │
     │  • R_AARCH64_GLOB_DAT          │
     └────────────────┬───────────────┘
                      │
                      ▼
     [ Launch Execution at e_entry ]
```

---

## 3. Supported Relocation Types

AArch64 relocation entries are represented by standard 24-byte `Elf64_Rela` structures:

```c
typedef struct {
    Elf64_Addr      r_offset; // Location to patch (Virtual Address)
    Elf64_Xword     r_info;   // Symbol index (high 32b) | Reloc type (low 32b)
    Elf64_Sxword    r_addend; // Explicit constant addend
} Elf64_Rela;
```

Mini-QEMU processes the following relocation types:

| Relocation Code | Constant Name | Formula | Description |
| :--- | :--- | :--- | :--- |
| `1027` | `R_AARCH64_RELATIVE` | `B + A` | Adjusts an absolute pointer by the library load bias $B$ and explicit addend $A$. |
| `1026` | `R_AARCH64_JUMP_SLOT` | `S` | Patches a Procedure Linkage Table (PLT) Global Offset Table (GOT) slot with resolved target symbol address $S$. |
| `1025` | `R_AARCH64_GLOB_DAT` | `S + A` | Patches a global data GOT slot with symbol address $S$ plus addend $A$. |

---

## 4. High-Level Emulation (HLE) Trampoline Stubs

When a dynamic executable imports standard C library symbols (e.g. `puts`, `strlen`, `abs`) that are not provided by a loaded `.so`, Mini-QEMU synthesizes lightweight guest trampolines in high memory (`0x70000000+`):

### 4.1 Trampoline Code Sequence
```armasm
movz  x8, #hleId      ; Load unique 16-bit stub identifier
svc   #0xdd           ; Trap into Mini-QEMU HLE dynamic syscall dispatcher
ret                   ; Return to guest caller using X30 (LR)
```

### 4.2 Syscall Trap (`0xdd`) Dispatcher
When `svc #0xdd` is decoded:
1. `handleSyscall(0xdd)` reads register `X8` to retrieve the `hleId`.
2. The registered JavaScript callback is invoked with arguments read from guest registers (`X0`–`X7`).
3. Return values are written to `X0` (or `D0` for floating point) and execution resumes through `ret`.

---

## 5. Verification & Testing

The dynamic linker is covered by [tests/test_dynamic_linker.js](file:///C:/Users/wei.du/WorkAtTPVision/test/emulator/tests/test_dynamic_linker.js):
- **Test 1:** `PT_INTERP` and `PT_DYNAMIC` ELF header validation.
- **Test 2:** Shared library loading and exported symbol discovery (`libcalc.so`).
- **Test 3:** `R_AARCH64_RELATIVE` and `R_AARCH64_JUMP_SLOT` relocation patching.
- **Test 4:** HLE trampoline stubs and libc fallback execution (`puts`, `abs`).
- **Test 5:** End-to-end dynamic application execution (`dynamic_app.elf` calling `libcalc.so` and HLE `abs`) with 100% bit-exact register match between pure interpreter and JIT compiler.
