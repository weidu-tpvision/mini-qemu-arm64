// tools/generate_ui_preview.js - Generates crisp UI preview images (SVG and PNG)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(ROOT_DIR, "docs");

if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// 1. Generate High-Resolution Vector SVG
function generateSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 780" width="1280" height="780" style="background:#0a0d14; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <defs>
    <linearGradient id="headerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0284c7" />
      <stop offset="100%" stop-color="#2563eb" />
    </linearGradient>
    <linearGradient id="runBtnGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#059669" />
      <stop offset="100%" stop-color="#10b981" />
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#000" flood-opacity="0.4"/>
    </filter>
  </defs>

  <style>
    .mono { font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace; }
    .panel { fill: #111726; stroke: #243048; stroke-width: 1px; rx: 8px; }
    .panel-hdr { fill: #161f33; }
    .hdr-text { font-size: 11px; font-weight: 700; fill: #94a3b8; letter-spacing: 0.5px; }
    .box { fill: #161f33; stroke: #243048; stroke-width: 1px; rx: 6px; }
    .label { font-size: 9px; font-weight: 700; fill: #64748b; letter-spacing: 0.5px; }
    .val-cyan { font-size: 12px; font-weight: 700; fill: #06b6d4; }
    .active-row { fill: rgba(16, 185, 129, 0.18); }
    .changed-row { fill: rgba(56, 189, 248, 0.15); }
    .bp-dot { fill: #ef4444; }
  </style>

  <!-- Top Navigation Bar -->
  <rect x="0" y="0" width="1280" height="60" fill="#111726" stroke="#243048" stroke-width="1"/>
  
  <!-- Brand -->
  <rect x="20" y="14" width="60" height="32" rx="6" fill="url(#headerGrad)"/>
  <text x="30" y="35" fill="#fff" font-weight="bold" font-size="13" class="mono">ARM64</text>
  <text x="92" y="28" fill="#f1f5f9" font-weight="700" font-size="15">Mini-QEMU Interactive Workbench</text>
  <text x="92" y="44" fill="#64748b" font-size="11">Computes 10th Fibonacci number (55) using registers X0, X1, X2 in a loop.</text>

  <!-- Toolbar Controls -->
  <rect x="520" y="14" width="215" height="32" rx="6" fill="#161f33" stroke="#243048" stroke-width="1"/>
  <text x="532" y="34" fill="#f1f5f9" font-size="11.5">Static Libc (heap_demo.elf)</text>
  <path d="M720 27 L725 34 L730 27 Z" fill="#94a3b8"/>

  <!-- Action Buttons -->
  <rect x="742" y="14" width="68" height="32" rx="6" fill="url(#runBtnGrad)"/>
  <text x="758" y="34" fill="#fff" font-weight="bold" font-size="11.5">▶ Run</text>

  <rect x="816" y="14" width="68" height="32" rx="6" fill="#161f33" stroke="#243048" stroke-width="1"/>
  <text x="831" y="34" fill="#f1f5f9" font-weight="600" font-size="11.5">↷ Step</text>

  <rect x="890" y="14" width="68" height="32" rx="6" fill="#161f33" stroke="#243048" stroke-width="1"/>
  <text x="904" y="34" fill="#f1f5f9" font-weight="600" font-size="11.5">↺ Reset</text>

  <!-- Speed control -->
  <rect x="966" y="14" width="118" height="32" rx="6" fill="#0f1523" stroke="#243048" stroke-width="1"/>
  <text x="975" y="34" fill="#94a3b8" font-size="11">Clock: <tspan class="mono" fill="#f1f5f9">20 Hz</tspan></text>

  <!-- Status Badge & Cycles -->
  <rect x="1092" y="15" width="84" height="30" rx="6" fill="rgba(16, 185, 129, 0.15)" stroke="rgba(16, 185, 129, 0.35)"/>
  <circle cx="1105" cy="30" r="4" fill="#10b981"/>
  <text x="1115" y="34" fill="#10b981" font-weight="bold" font-size="10.5" class="mono">RUNNING</text>

  <rect x="1184" y="15" width="82" height="30" rx="6" fill="#0f1523" stroke="#243048"/>
  <text x="1193" y="34" fill="#64748b" font-size="11" class="mono">Cycles: <tspan fill="#06b6d4" font-weight="bold">42</tspan></text>

  <!-- ================= PANEL 1: CPU STATE & REGISTERS ================= -->
  <g transform="translate(15, 72)" filter="url(#shadow)">
    <rect width="340" height="694" class="panel"/>
    <path d="M0 8 Q0 0 8 0 L332 0 Q340 0 340 8 L340 34 L0 34 Z" class="panel-hdr"/>
    <text x="14" y="21" class="hdr-text">CPU STATE &amp; REGISTERS</text>
    <text x="255" y="21" fill="#64748b" font-size="10" class="mono">AArch64 ABI</text>

    <!-- 4 Special Register Boxes -->
    <rect x="10" y="42" width="155" height="44" class="box"/>
    <text x="18" y="55" class="label">PROGRAM COUNTER (PC)</text>
    <text x="18" y="75" class="val-cyan mono">0x00400010</text>

    <rect x="175" y="42" width="155" height="44" class="box"/>
    <text x="183" y="55" class="label">STACK POINTER (SP)</text>
    <text x="183" y="75" class="val-cyan mono">0x00700000</text>

    <rect x="10" y="94" width="155" height="44" class="box"/>
    <text x="18" y="107" class="label">FRAME POINTER (X29)</text>
    <text x="18" y="127" class="val-cyan mono">0x00000000</text>

    <rect x="175" y="94" width="155" height="44" class="box"/>
    <text x="183" y="107" class="label">TLS POINTER (TPIDR_EL0)</text>
    <text x="183" y="127" class="val-cyan mono">0x00600000</text>

    <!-- Condition Flags NZCV -->
    <rect x="10" y="146" width="320" height="32" fill="#0f1523" stroke="#243048" stroke-width="1" rx="6"/>
    <text x="18" y="166" fill="#64748b" font-size="10" font-weight="bold">PSTATE FLAGS (NZCV)</text>
    
    <rect x="154" y="151" width="36" height="22" rx="4" fill="#161f33" stroke="#243048"/>
    <text x="163" y="166" fill="#64748b" font-size="10" font-weight="bold" class="mono">N:0</text>

    <rect x="196" y="151" width="36" height="22" rx="4" fill="rgba(16, 185, 129, 0.2)" stroke="#10b981"/>
    <text x="205" y="166" fill="#10b981" font-size="10" font-weight="bold" class="mono">Z:1</text>

    <rect x="238" y="151" width="36" height="22" rx="4" fill="rgba(16, 185, 129, 0.2)" stroke="#10b981"/>
    <text x="247" y="166" fill="#10b981" font-size="10" font-weight="bold" class="mono">C:1</text>

    <rect x="280" y="151" width="36" height="22" rx="4" fill="#161f33" stroke="#243048"/>
    <text x="289" y="166" fill="#64748b" font-size="10" font-weight="bold" class="mono">V:0</text>

    <!-- Registers Table Header -->
    <rect x="0" y="186" width="340" height="24" fill="#161f33"/>
    <text x="12" y="202" fill="#64748b" font-size="9.5" class="mono">REGISTER</text>
    <text x="95" y="202" fill="#64748b" font-size="9.5" class="mono">HEXADECIMAL (64-BIT)</text>
    <text x="275" y="202" fill="#64748b" font-size="9.5" class="mono">SIGNED</text>

    <!-- General Registers X0 - X18 -->
    <g class="mono" font-size="11">
      <rect x="0" y="212" width="340" height="22" class="changed-row"/>
      <text x="12" y="227" fill="#38bdf8" font-weight="bold">X0 <tspan fill="#64748b" font-size="9" font-weight="normal">Arg0/Ret</tspan></text>
      <text x="95" y="227" fill="#38bdf8">0x0000000000000037</text>
      <text x="325" y="227" fill="#38bdf8" text-anchor="end" font-weight="bold">55</text>

      <rect x="0" y="236" width="340" height="22" class="changed-row"/>
      <text x="12" y="251" fill="#38bdf8" font-weight="bold">X1 <tspan fill="#64748b" font-size="9" font-weight="normal">Arg1</tspan></text>
      <text x="95" y="251" fill="#38bdf8">0x0000000000000022</text>
      <text x="325" y="251" fill="#38bdf8" text-anchor="end" font-weight="bold">34</text>

      <rect x="0" y="260" width="340" height="22" class="changed-row"/>
      <text x="12" y="275" fill="#38bdf8" font-weight="bold">X2 <tspan fill="#64748b" font-size="9" font-weight="normal">Arg2</tspan></text>
      <text x="95" y="275" fill="#38bdf8">0x0000000000000037</text>
      <text x="325" y="275" fill="#38bdf8" text-anchor="end" font-weight="bold">55</text>

      <text x="12" y="299" fill="#06b6d4">X3 <tspan fill="#64748b" font-size="9">Arg3</tspan></text>
      <text x="95" y="299" fill="#f1f5f9">0x000000000000000a</text>
      <text x="325" y="299" fill="#94a3b8" text-anchor="end">10</text>

      <text x="12" y="323" fill="#06b6d4">X4 <tspan fill="#64748b" font-size="9">Arg4</tspan></text>
      <text x="95" y="323" fill="#f1f5f9">0x0000000000000000</text>
      <text x="325" y="323" fill="#64748b" text-anchor="end">0</text>

      <text x="12" y="347" fill="#06b6d4">X5 <tspan fill="#64748b" font-size="9">Arg5</tspan></text>
      <text x="95" y="347" fill="#f1f5f9">0x0000000000000000</text>
      <text x="325" y="347" fill="#64748b" text-anchor="end">0</text>

      <text x="12" y="371" fill="#06b6d4">X6 <tspan fill="#64748b" font-size="9">Arg6</tspan></text><text x="95" y="371" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="371" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="395" fill="#06b6d4">X7 <tspan fill="#64748b" font-size="9">Arg7</tspan></text><text x="95" y="395" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="395" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="419" fill="#06b6d4">X8 <tspan fill="#64748b" font-size="9">Syscall#</tspan></text><text x="95" y="419" fill="#f1f5f9">0x000000000000005d</text><text x="325" y="419" fill="#94a3b8" text-anchor="end">93</text>
      <text x="12" y="443" fill="#06b6d4">X9 <tspan fill="#64748b" font-size="9">Temp0</tspan></text><text x="95" y="443" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="443" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="467" fill="#06b6d4">X10 <tspan fill="#64748b" font-size="9">Temp1</tspan></text><text x="95" y="467" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="467" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="491" fill="#06b6d4">X11 <tspan fill="#64748b" font-size="9">Temp2</tspan></text><text x="95" y="491" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="491" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="515" fill="#06b6d4">X12 <tspan fill="#64748b" font-size="9">Temp3</tspan></text><text x="95" y="515" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="515" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="539" fill="#06b6d4">X13 <tspan fill="#64748b" font-size="9">Temp4</tspan></text><text x="95" y="539" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="539" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="563" fill="#06b6d4">X14 <tspan fill="#64748b" font-size="9">Temp5</tspan></text><text x="95" y="563" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="563" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="587" fill="#06b6d4">X15 <tspan fill="#64748b" font-size="9">Temp6</tspan></text><text x="95" y="587" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="587" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="611" fill="#06b6d4">X16 <tspan fill="#64748b" font-size="9">IP0</tspan></text><text x="95" y="611" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="611" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="635" fill="#06b6d4">X29 <tspan fill="#64748b" font-size="9">FP</tspan></text><text x="95" y="635" fill="#f1f5f9">0x0000000000000000</text><text x="325" y="635" fill="#64748b" text-anchor="end">0</text>
      <text x="12" y="659" fill="#06b6d4">X30 <tspan fill="#64748b" font-size="9">LR</tspan></text><text x="95" y="659" fill="#f1f5f9">0x000000000040000c</text><text x="325" y="659" fill="#94a3b8" text-anchor="end">4194316</text>
    </g>
  </g>

  <!-- ================= PANEL 2: DISASSEMBLY, PIPELINE & TRANSLATORS ================= -->
  <g transform="translate(368, 72)" filter="url(#shadow)">
    <rect width="524" height="450" class="panel"/>
    <path d="M0 8 Q0 0 8 0 L516 0 Q524 0 524 8 L524 34 L0 34 Z" class="panel-hdr"/>

    <!-- View Tabs -->
    <rect x="8" y="5" width="128" height="24" rx="5" fill="#0f1523" stroke="#243048"/>
    <text x="16" y="21" fill="#06b6d4" font-size="10.5" font-weight="bold">ARM64 Disassembly</text>
    <text x="148" y="21" fill="#64748b" font-size="10.5" font-weight="bold">x86-64 Translator</text>
    <text x="262" y="21" fill="#64748b" font-size="10.5" font-weight="bold">Static AOT (JS)</text>
    <text x="378" y="21" fill="#64748b" font-size="10" class="mono">fib.elf (0x00400000)</text>

    <!-- Live Fetch-Decode-Execute Pipeline Bar -->
    <rect x="0" y="34" width="524" height="28" fill="#0f1523"/>
    <rect x="8" y="39" width="42" height="18" rx="4" fill="rgba(6, 182, 212, 0.15)" stroke="rgba(6, 182, 212, 0.35)"/>
    <text x="13" y="51" fill="#06b6d4" font-size="8.5" font-weight="bold" class="mono">FETCH</text>
    <text x="56" y="52" fill="#e2e8f0" font-size="10" class="mono">PC=0x00400010</text>

    <rect x="148" y="39" width="212" height="18" rx="4" fill="rgba(245, 158, 11, 0.08)" stroke="rgba(245, 158, 11, 0.25)"/>
    <text x="155" y="51" fill="#f59e0b" font-size="9.5" class="mono">01010100 00000000 00000001 00100000</text>

    <rect x="366" y="39" width="48" height="18" rx="4" fill="rgba(16, 185, 129, 0.15)" stroke="rgba(16, 185, 129, 0.35)"/>
    <text x="371" y="51" fill="#10b981" font-size="8.5" font-weight="bold" class="mono">B_COND</text>
    <text x="420" y="52" fill="#fff" font-size="10" font-weight="bold" class="mono">b.eq +36B</text>

    <!-- Table Header -->
    <rect x="0" y="62" width="524" height="24" fill="#161f33"/>
    <text x="12" y="78" fill="#64748b" font-size="9" class="mono">●</text>
    <text x="32" y="78" fill="#64748b" font-size="9" class="mono">ADDRESS</text>
    <text x="120" y="78" fill="#64748b" font-size="9" class="mono">OPCODE</text>
    <text x="195" y="78" fill="#64748b" font-size="9" class="mono">INSTRUCTION</text>
    <text x="335" y="78" fill="#64748b" font-size="9" class="mono">SEMANTICS &amp; RESOLVED TARGET</text>

    <!-- Instruction Rows -->
    <g class="mono" font-size="11">
      <text x="32" y="104" fill="#64748b">0x00400000</text>
      <text x="120" y="104" fill="#f59e0b">d2800000</text>
      <text x="195" y="104" fill="#f1f5f9">movz x0, #0</text>
      <text x="335" y="104" fill="#94a3b8">X0 ← 0 (0x0)</text>

      <text x="32" y="131" fill="#64748b">0x00400004</text>
      <text x="120" y="131" fill="#f59e0b">d2800021</text>
      <text x="195" y="131" fill="#f1f5f9">movz x1, #1</text>
      <text x="335" y="131" fill="#94a3b8">X1 ← 1 (0x1)</text>

      <text x="32" y="158" fill="#64748b">0x00400008</text>
      <text x="120" y="158" fill="#f59e0b">d2800143</text>
      <text x="195" y="158" fill="#f1f5f9">movz x3, #10</text>
      <text x="335" y="158" fill="#94a3b8">X3 ← 10 (0xa)</text>

      <text x="32" y="185" fill="#64748b">0x0040000c</text>
      <text x="120" y="185" fill="#f59e0b">f100007f</text>
      <text x="195" y="185" fill="#f1f5f9">cmp x3, #0</text>
      <text x="335" y="185" fill="#94a3b8">Compare X3 with 0 → set NZCV</text>

      <!-- 0x00400010: ACTIVE PC ROW -->
      <rect x="0" y="198" width="524" height="27" class="active-row"/>
      <rect x="0" y="198" width="3" height="27" fill="#10b981"/>
      <text x="12" y="216" fill="#10b981" font-weight="bold">▶</text>
      <text x="32" y="216" fill="#10b981" font-weight="bold">0x00400010</text>
      <text x="120" y="216" fill="#f59e0b" font-weight="bold">54000120</text>
      <text x="195" y="216" fill="#ffffff" font-weight="bold">b.eq [offset +36B]</text>
      <text x="335" y="216" fill="#10b981">If EQ → jump to 0x00400034</text>

      <text x="32" y="243" fill="#64748b">0x00400014</text>
      <text x="120" y="243" fill="#f59e0b">8b010002</text>
      <text x="195" y="243" fill="#f1f5f9">add x2, x0, x1</text>
      <text x="335" y="243" fill="#94a3b8">X2 ← X0 + X1</text>

      <!-- 0x00400018: BREAKPOINT ROW -->
      <circle cx="16" cy="266" r="4.5" class="bp-dot"/>
      <text x="32" y="270" fill="#64748b">0x00400018</text>
      <text x="120" y="270" fill="#f59e0b">aa0103e0</text>
      <text x="195" y="270" fill="#f1f5f9">mov x0, x1</text>
      <text x="335" y="270" fill="#94a3b8">Copy X0 ← X1</text>

      <text x="32" y="297" fill="#64748b">0x0040001c</text>
      <text x="120" y="297" fill="#f59e0b">aa0203e1</text>
      <text x="195" y="297" fill="#f1f5f9">mov x1, x2</text>
      <text x="335" y="297" fill="#94a3b8">Copy X1 ← X2</text>

      <text x="32" y="324" fill="#64748b">0x00400020</text>
      <text x="120" y="324" fill="#f59e0b">d1000463</text>
      <text x="195" y="324" fill="#f1f5f9">sub x3, x3, #1</text>
      <text x="335" y="324" fill="#94a3b8">X3 ← X3 - 1</text>

      <text x="32" y="351" fill="#64748b">0x00400024</text>
      <text x="120" y="351" fill="#f59e0b">17fffff9</text>
      <text x="195" y="351" fill="#f1f5f9">b [offset -24B]</text>
      <text x="335" y="351" fill="#94a3b8">Unconditional jump → 0x0040000c</text>

      <text x="32" y="378" fill="#64748b">0x00400028</text>
      <text x="120" y="378" fill="#f59e0b">d2800ba8</text>
      <text x="195" y="378" fill="#f1f5f9">movz x8, #93</text>
      <text x="335" y="378" fill="#94a3b8">X8 ← 93 (0x5d)</text>

      <text x="32" y="405" fill="#64748b">0x0040002c</text>
      <text x="120" y="405" fill="#f59e0b">d4000001</text>
      <text x="195" y="405" fill="#f1f5f9">svc #0</text>
      <text x="335" y="405" fill="#94a3b8">Linux ARM64 Syscall Trap (svc #0)</text>
    </g>
  </g>

  <!-- ================= PANEL 3: GUEST TERMINAL ================= -->
  <g transform="translate(368, 534)" filter="url(#shadow)">
    <rect width="524" height="232" class="panel"/>
    <path d="M0 8 Q0 0 8 0 L516 0 Q524 0 524 8 L524 32 L0 32 Z" class="panel-hdr"/>
    <text x="14" y="21" class="hdr-text">GUEST TERMINAL (LINUX SYS_WRITE &amp; TRACE LOG)</text>

    <rect x="10" y="40" width="504" height="182" fill="#080c14" rx="4"/>
    <g class="mono" font-size="11" transform="translate(18, 62)">
      <text y="0" fill="#64748b">[Mini-QEMU] System initialized (VFS mounted, 48+ ISA opcodes ready).</text>
      <text y="22" fill="#38bdf8">[Mini-QEMU] Loaded "heap_demo.elf" -&gt; Entry 0x00400000</text>
      <text y="44" fill="#4ade80" font-weight="bold">[Heap Demo] Allocated 40 bytes on heap via sys_brk! Sum = 150</text>
      <text y="66" fill="#38bdf8">[VFS] sys_openat("save.txt", O_CREAT|O_RDWR) -&gt; fd 3, written 14 bytes</text>
      <text y="88" fill="#c084fc" font-weight="bold">[AOT Benchmark] 5,000 runs: Interpreter=21.4ms | Static AOT=0.25ms -&gt; 85.6x Speedup!</text>
      <text y="110" fill="#c084fc" font-weight="bold">&gt;&gt;&gt; Process exited cleanly via Linux sys_exit (X0 = 150) &lt;&lt;&lt;</text>
    </g>
  </g>

  <!-- ================= PANEL 4: MEMORY HEX INSPECTOR, STACK & DISPLAY ================= -->
  <g transform="translate(905, 72)" filter="url(#shadow)">
    <rect width="360" height="694" class="panel"/>
    <path d="M0 8 Q0 0 8 0 L352 0 Q360 0 360 8 L360 34 L0 34 Z" class="panel-hdr"/>
    
    <!-- Memory / Stack / Display Tabs -->
    <rect x="8" y="5" width="82" height="24" rx="5" fill="#0f1523" stroke="#243048"/>
    <text x="14" y="21" fill="#06b6d4" font-size="10" font-weight="bold">Memory Hex</text>
    <text x="98" y="21" fill="#64748b" font-size="10" font-weight="bold">Call Stack</text>
    <text x="165" y="21" fill="#38bdf8" font-size="10" font-weight="bold">📺 Display</text>
    <text x="275" y="21" fill="#64748b" font-size="9.5" class="mono">320×240 VRAM</text>

    <!-- Address jumper toolbar -->
    <rect x="8" y="40" width="344" height="32" fill="#0f1523" stroke="#243048" stroke-width="1" rx="6"/>
    <rect x="14" y="44" width="82" height="24" fill="#161f33" stroke="#243048" rx="4"/>
    <text x="19" y="60" fill="#f1f5f9" font-size="10.5" class="mono">0x00800000</text>
    
    <rect x="100" y="44" width="26" height="24" fill="#161f33" stroke="#243048" rx="4"/>
    <text x="106" y="60" fill="#94a3b8" font-size="10" font-weight="bold">Go</text>

    <rect x="130" y="44" width="20" height="24" fill="#161f33" stroke="#243048" rx="4"/>
    <text x="135" y="60" fill="#94a3b8" font-size="9">▲</text>

    <rect x="154" y="44" width="20" height="24" fill="#161f33" stroke="#243048" rx="4"/>
    <text x="159" y="60" fill="#94a3b8" font-size="9">▼</text>

    <rect x="180" y="44" width="38" height="24" fill="#161f33" stroke="#243048" rx="4"/>
    <text x="186" y="60" fill="#94a3b8" font-size="9.5">.text</text>

    <rect x="222" y="44" width="38" height="24" fill="#161f33" stroke="#243048" rx="4"/>
    <text x="229" y="60" fill="#94a3b8" font-size="9.5">RAM</text>

    <rect x="264" y="44" width="34" height="24" fill="#161f33" stroke="#243048" rx="4"/>
    <text x="274" y="60" fill="#94a3b8" font-size="9.5">SP</text>

    <rect x="302" y="44" width="44" height="24" fill="#161f33" stroke="#06b6d4" rx="4"/>
    <text x="308" y="60" fill="#38bdf8" font-size="9.5" font-weight="bold">VRAM</text>

    <!-- Hex Table Header -->
    <rect x="0" y="80" width="360" height="24" fill="#161f33"/>
    <text x="12" y="96" fill="#64748b" font-size="9" class="mono">ADDRESS</text>
    <text x="80" y="96" fill="#64748b" font-size="9" class="mono">00 01 02 03 04 05 06 07  08 09 0A 0B</text>
    <text x="285" y="96" fill="#64748b" font-size="9" class="mono">ASCII</text>

    <!-- Hex Dump Rows -->
    <g class="mono" font-size="10">
      <text x="12" y="120" fill="#64748b">0x00400000</text>
      <text x="80" y="120" fill="#e2e8f0">00 00 80 d2 21 00 80 d2  43 01 80 d2</text>
      <text x="285" y="120" fill="#06b6d4">....!...C...</text>

      <text x="12" y="144" fill="#64748b">0x00400010</text>
      <text x="80" y="144" fill="#e2e8f0">20 01 00 54 02 00 01 8b  e0 03 01 aa</text>
      <text x="285" y="144" fill="#06b6d4"> ..T........</text>

      <text x="12" y="168" fill="#64748b">0x00400020</text>
      <text x="80" y="168" fill="#e2e8f0">63 04 00 d1 f9 ff ff 17  a8 0b 80 d2</text>
      <text x="285" y="168" fill="#06b6d4">c...........</text>

      <text x="12" y="192" fill="#64748b">0x00400030</text>
      <text x="80" y="192" fill="#475569">01 00 00 d4 00 00 00 00  00 00 00 00</text>
      <text x="285" y="192" fill="#06b6d4">............</text>

      <!-- Call Stack Preview Section inside Right Panel -->
      <rect x="0" y="218" width="360" height="24" fill="#161f33"/>
      <text x="12" y="234" fill="#94a3b8" font-size="9.5" font-weight="bold">LIVE CALL STACK &amp; FRAMES (64-BIT WORDS)</text>

      <text x="12" y="258" fill="#06b6d4">0x00700000</text>
      <text x="90" y="258" fill="#475569">0x0000000000000000</text>
      <text x="265" y="258" fill="#64748b">[Stack Base]</text>

      <rect x="0" y="268" width="360" height="22" class="changed-row"/>
      <text x="12" y="283" fill="#38bdf8" font-weight="bold">0x006ffff8</text>
      <text x="90" y="283" fill="#38bdf8">0x000000000040000c</text>
      <text x="265" y="283" fill="#f59e0b" font-weight="bold">Saved LR</text>

      <rect x="0" y="292" width="360" height="22" class="active-row"/>
      <text x="12" y="307" fill="#10b981" font-weight="bold">0x006ffff0</text>
      <text x="90" y="307" fill="#f1f5f9">0x0000000000700000</text>
      <text x="265" y="307" fill="#10b981" font-weight="bold">← SP / FP</text>

      <!-- Level 1 MMIO Virtual Screen Preview Section -->
      <rect x="0" y="328" width="360" height="24" fill="#161f33"/>
      <text x="12" y="344" fill="#38bdf8" font-size="9.5" font-weight="bold">📺 LEVEL 1 MMIO FRAMEBUFFER (0x00800000 • 320×240)</text>

      <!-- Mini SMPTE Color Bars Preview -->
      <g transform="translate(20, 362)">
        <rect x="0" y="0" width="40" height="140" fill="#ffffff"/>
        <rect x="40" y="0" width="40" height="140" fill="#ffff00"/>
        <rect x="80" y="0" width="40" height="140" fill="#00ffff"/>
        <rect x="120" y="0" width="40" height="140" fill="#00ff00"/>
        <rect x="160" y="0" width="40" height="140" fill="#ff00ff"/>
        <rect x="200" y="0" width="40" height="140" fill="#ff0000"/>
        <rect x="240" y="0" width="40" height="140" fill="#0000ff"/>
        <rect x="280" y="0" width="40" height="140" fill="#1a1a1a"/>
        <rect x="0" y="0" width="320" height="140" fill="none" stroke="#243048" stroke-width="2" rx="4"/>
      </g>
      <text x="20" y="520" fill="#94a3b8" font-size="9.5">Hover: (140, 40) → 0x0080C88C • RGBA(0, 255, 0, 255) #00FF00</text>
    </g>
  </g>
</svg>`;
}

// 2. Generate a standard uncompressed/deflated PNG image
function generatePng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = createChunk("IHDR", ihdrData);

  const rowBytes = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    rawData[rowOffset] = 0;

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      if (y < 60) {
        if (x >= 20 && x <= 80 && y >= 14 && y <= 46) {
          rawData[pxOffset] = 2;
          rawData[pxOffset + 1] = 132;
          rawData[pxOffset + 2] = 199;
          rawData[pxOffset + 3] = 255;
        } else {
          rawData[pxOffset] = 17;
          rawData[pxOffset + 1] = 23;
          rawData[pxOffset + 2] = 38;
          rawData[pxOffset + 3] = 255;
        }
      } else {
        const inLeftPanel = (x >= 15 && x <= 355 && y >= 72 && y <= height - 14);
        const inMidPanelTop = (x >= 368 && x <= 892 && y >= 72 && y <= 522);
        const inMidPanelBtm = (x >= 368 && x <= 892 && y >= 534 && y <= height - 14);
        const inRightPanel = (x >= 905 && x <= width - 15 && y >= 72 && y <= height - 14);

        if (inLeftPanel || inMidPanelTop || inMidPanelBtm || inRightPanel) {
          rawData[pxOffset] = 22;
          rawData[pxOffset + 1] = 31;
          rawData[pxOffset + 2] = 51;
          rawData[pxOffset + 3] = 255;
        } else {
          rawData[pxOffset] = 10;
          rawData[pxOffset + 1] = 13;
          rawData[pxOffset + 2] = 20;
          rawData[pxOffset + 3] = 255;
        }
      }
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createChunk("IDAT", compressedData);
  const iendChunk = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(8 + len + 4);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const crc = crc32(chunk.subarray(4, 8 + len));
  chunk.writeUInt32BE(crc, 8 + len);
  return chunk;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const svgContent = generateSvg();
const svgPath = path.join(DOCS_DIR, "ui_preview.svg");
fs.writeFileSync(svgPath, svgContent, "utf8");
console.log(`[PASS] Generated vector UI preview: ${svgPath}`);

const pngBuffer = generatePng(1280, 780);
const pngPath = path.join(DOCS_DIR, "ui_preview.png");
fs.writeFileSync(pngPath, pngBuffer);
console.log(`[PASS] Generated raster UI preview: ${pngPath}`);
