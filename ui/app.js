// ui/app.js - Mini-QEMU Interactive Browser Controller & AOT Workbench
import { MiniQEMU } from "/src/emulator.js";
import { Decoder, InstructionType } from "/src/decoder.js";
import { Arm2X86Translator } from "/src/arm2x86.js";
import { StaticRecompiler } from "/src/static_recompiler.js";
import {
  KEY_MASK_UP, KEY_MASK_DOWN, KEY_MASK_LEFT, KEY_MASK_RIGHT,
  KEY_MASK_ACTION_A, KEY_MASK_ACTION_B, KEY_MASK_RESET
} from "/src/memory.js";

// DOM Elements
const programSelect = document.getElementById("programSelect");
const programDescText = document.getElementById("programDescText");
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const runBtn = document.getElementById("runBtn");
const stepBtn = document.getElementById("stepBtn");
const resetBtn = document.getElementById("resetBtn");
const speedSlider = document.getElementById("speedSlider");
const speedLabel = document.getElementById("speedLabel");
const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");
const cycleCounter = document.getElementById("cycleCounter");
const loadedBinaryInfo = document.getElementById("loadedBinaryInfo");

const pcVal = document.getElementById("pcVal");
const spVal = document.getElementById("spVal");
const fpVal = document.getElementById("fpVal");
const lrVal = document.getElementById("lrVal");
const pcBox = document.getElementById("pcBox");
const spBox = document.getElementById("spBox");
const fpBox = document.getElementById("fpBox");
const lrBox = document.getElementById("lrBox");

const flagN = document.getElementById("flagN");
const flagZ = document.getElementById("flagZ");
const flagC = document.getElementById("flagC");
const flagV = document.getElementById("flagV");

const pipeFetchText = document.getElementById("pipeFetchText");
const pipeBitsText = document.getElementById("pipeBitsText");
const pipeTypeBadge = document.getElementById("pipeTypeBadge");
const pipeDisasmText = document.getElementById("pipeDisasmText");
const pipeSemText = document.getElementById("pipeSemText");

const regsTableBody = document.getElementById("regsTableBody");
const disasmTableBody = document.getElementById("disasmTableBody");
const x86CodeBlock = document.getElementById("x86CodeBlock");
const aotCodeBlock = document.getElementById("aotCodeBlock");
const runBenchBtn = document.getElementById("runBenchBtn");
const benchResultBadge = document.getElementById("benchResultBadge");

const terminalWindow = document.getElementById("terminalWindow");
const clearConsoleBtn = document.getElementById("clearConsoleBtn");

const memAddrInput = document.getElementById("memAddrInput");
const memGoBtn = document.getElementById("memGoBtn");
const memPrevBtn = document.getElementById("memPrevBtn");
const memNextBtn = document.getElementById("memNextBtn");
const jumpTextBtn = document.getElementById("jumpTextBtn");
const jumpStackBtn = document.getElementById("jumpStackBtn");
const jumpDataBtn = document.getElementById("jumpDataBtn");
const jumpHeapBtn = document.getElementById("jumpHeapBtn");
const jumpVramBtn = document.getElementById("jumpVramBtn");
const jumpVramHexBtn = document.getElementById("jumpVramHexBtn");
const clearScreenBtn = document.getElementById("clearScreenBtn");
const hexTableBody = document.getElementById("hexTableBody");
const stackTableBody = document.getElementById("stackTableBody");

// Dynamic Heap Allocator Elements
const heapBrkVal = document.getElementById("heapBrkVal");
const heapAllocVal = document.getElementById("heapAllocVal");
const heapFreeVal = document.getElementById("heapFreeVal");
const heapPagesVal = document.getElementById("heapPagesVal");
const heapMapTitle = document.getElementById("heapMapTitle");
const heapVisualStrip = document.getElementById("heapVisualStrip");
const heapTableBody = document.getElementById("heapTableBody");

// Level 1 MMIO Virtual Screen Elements & Framebuffer State
const memToolbar = document.getElementById("memToolbar");
const vramHeaderBadge = document.getElementById("vramHeaderBadge");
const instantRenderBtn = document.getElementById("instantRenderBtn");
const vramCanvas = document.getElementById("vramCanvas");
const vramCtx = vramCanvas ? vramCanvas.getContext("2d") : null;
const scanlineOverlay = document.getElementById("scanlineOverlay");
const crtScanlineToggle = document.getElementById("crtScanlineToggle");
const vramFrameCount = document.getElementById("vramFrameCount");
const vramFpsBadge = document.getElementById("vramFpsBadge");
const vramStatusText = document.getElementById("vramStatusText");
const pixelSwatch = document.getElementById("pixelSwatch");
const pixelCoordText = document.getElementById("pixelCoordText");
const pixelAddrText = document.getElementById("pixelAddrText");
const pixelRgbaText = document.getElementById("pixelRgbaText");
const FB_WIDTH = 320;
const FB_HEIGHT = 240;
const FB_SIZE = FB_WIDTH * FB_HEIGHT * 4;
let vramImageData = vramCtx ? vramCtx.createImageData(FB_WIDTH, FB_HEIGHT) : null;
let renderedFrames = 0;
let lastFpsTime = performance.now();
let frameCounterInSec = 0;

// Emulator Instance & Runtime State
const emulator = new MiniQEMU();
let isRunning = false;
let runTimer = null;
let currentMemAddr = 0x00400000;
let currentLoadedBuffer = null;
let currentLoadedName = "fib.elf";
let currentAotSource = "";
let changedRegisters = new Set();
let changedMemoryBytes = new Set();

const SPEED_LEVELS = {
  "1": { label: "1 Hz", delay: 1000, turbo: false },
  "2": { label: "5 Hz", delay: 200, turbo: false },
  "3": { label: "20 Hz", delay: 50, turbo: false },
  "4": { label: "100 Hz", delay: 10, turbo: false },
  "5": { label: "Max Speed", delay: 0, turbo: true }
};

const ABI_ROLES = {
  0: "Arg0/Ret", 1: "Arg1", 2: "Arg2", 3: "Arg3",
  4: "Arg4", 5: "Arg5", 6: "Arg6", 7: "Arg7",
  8: "Syscall#", 9: "Temp0", 10: "Temp1", 11: "Temp2",
  12: "Temp3", 13: "Temp4", 14: "Temp5", 15: "Temp6",
  16: "IP0", 17: "IP1", 18: "Plat",
  19: "Saved0", 20: "Saved1", 21: "Saved2", 22: "Saved3",
  23: "Saved4", 24: "Saved5", 25: "Saved6", 26: "Saved7",
  27: "Saved8", 28: "Saved9", 29: "FP", 30: "LR"
};

// Wire up emulator event hooks
emulator.onWrite = (text) => {
  appendTerminal(text, "stdout");
};

emulator.onHalt = (exitCode) => {
  setStatus("HALTED", `HALTED (X0=${exitCode})`, "status-halted");
  appendTerminal(`\n>>> Process exited cleanly via Linux sys_exit (X0 = ${exitCode}) <<<\n`, "halt");
  stopRunning();
};

function appendTerminal(text, type = "sys-msg") {
  const span = document.createElement("span");
  span.className = `terminal-entry ${type}`;
  span.textContent = text;
  terminalWindow.appendChild(span);
  terminalWindow.scrollTop = terminalWindow.scrollHeight;
}

function setStatus(code, label, className) {
  statusBadge.className = `status-badge ${className}`;
  statusText.textContent = label || code;
}

function regLabel(index, useSP = false) {
  if (index === 31) return useSP ? "SP" : "XZR";
  return `X${index}`;
}

// 1. Initialize Register Table in DOM
function initRegistersTable() {
  regsTableBody.innerHTML = "";
  for (let i = 0; i < 31; i++) {
    const tr = document.createElement("tr");
    tr.id = `reg-row-${i}`;
    tr.className = "reg-row";
    const abi = ABI_ROLES[i] ? `<span class="reg-abi">${ABI_ROLES[i]}</span>` : "";
    tr.innerHTML = `
      <td class="reg-name">X${i}${abi}</td>
      <td class="reg-hex" id="reg-hex-${i}">0x0000000000000000</td>
      <td class="reg-dec" id="reg-dec-${i}">0</td>
    `;
    regsTableBody.appendChild(tr);
  }
}

// 2. Update CPU State (Registers, Flags, PC/SP, and Live Pipeline Bar)
function updateCPUState(changed = []) {
  const pc = Number(emulator.cpu.pc);
  const sp = emulator.cpu.sp;
  const fp = emulator.cpu.getReg(29);
  const lr = emulator.cpu.getReg(30);

  pcVal.textContent = `0x${pc.toString(16).padStart(8, "0")}`;
  spVal.textContent = `0x${sp.toString(16).padStart(8, "0")}`;
  fpVal.textContent = `0x${fp.toString(16).padStart(8, "0")}`;
  lrVal.textContent = `0x${lr.toString(16).padStart(8, "0")}`;

  const { N, Z, C, V } = emulator.cpu.flags;
  flagN.className = `flag-chip ${N ? "active" : ""}`;
  flagN.textContent = `N: ${N ? 1 : 0}`;
  flagZ.className = `flag-chip ${Z ? "active" : ""}`;
  flagZ.textContent = `Z: ${Z ? 1 : 0}`;
  flagC.className = `flag-chip ${C ? "active" : ""}`;
  flagC.textContent = `C: ${C ? 1 : 0}`;
  flagV.className = `flag-chip ${V ? "active" : ""}`;
  flagV.textContent = `V: ${V ? 1 : 0}`;

  cycleCounter.textContent = emulator.cycleCount.toLocaleString();

  // Reset previously changed highlights
  changedRegisters.forEach(idx => {
    const row = document.getElementById(`reg-row-${idx}`);
    if (row) row.classList.remove("changed");
  });
  changedRegisters.clear();

  // Update register values
  for (let i = 0; i < 31; i++) {
    const val = emulator.cpu.getReg(i);
    const hexElem = document.getElementById(`reg-hex-${i}`);
    const decElem = document.getElementById(`reg-dec-${i}`);
    if (hexElem) hexElem.textContent = `0x${val.toString(16).padStart(16, "0")}`;
    if (decElem) decElem.textContent = BigInt.asIntN(64, val).toString();
  }

  // Apply diff highlights
  if (changed && changed.length > 0) {
    changed.forEach(item => {
      if (item.index >= 0 && item.index < 31) {
        const row = document.getElementById(`reg-row-${item.index}`);
        if (row) {
          row.classList.add("changed");
          changedRegisters.add(item.index);
        }
      }
    });
  }

  updatePipelineBar(pc);
}

function updatePipelineBar(pc) {
  if (emulator.cpu.halted) {
    pipeFetchText.textContent = `PC=0x${pc.toString(16).padStart(8, "0")} | HALTED`;
    pipeTypeBadge.textContent = "SYS_EXIT";
    pipeDisasmText.textContent = `Return X0 = ${emulator.cpu.exitCode}`;
    pipeSemText.textContent = "Process terminated cleanly";
    return;
  }

  const raw = emulator.memory.read32(pc);
  const decoded = Decoder.decode(raw);
  const hexPC = `0x${pc.toString(16).padStart(8, "0")}`;
  const hexRaw = `0x${raw.toString(16).padStart(8, "0")}`;
  const binStr = raw.toString(2).padStart(32, "0").replace(/(.{8})/g, "$1 ").trim();

  pipeFetchText.textContent = `PC=${hexPC} | ${hexRaw}`;
  pipeBitsText.textContent = binStr;
  pipeTypeBadge.textContent = decoded.type;
  pipeDisasmText.textContent = decoded.disassembly;
  pipeSemText.textContent = getInstructionAnnotation(decoded, pc);
}

// 3. Disassemble loaded binary segment (with smart .rodata ASCII string detection)
function disassembleLoadedBinary() {
  disasmTableBody.innerHTML = "";

  const segments = emulator.memory.segments || [];
  if (segments.length === 0) return;

  const codeSeg = segments.find(s => (s.flags & 1) !== 0) || segments[0];
  const startAddr = codeSeg.vaddr;
  const endAddr = startAddr + codeSeg.filesz;

  // Track ADR string pointers so we know where embedded data starts
  const dataStartAddresses = new Set();

  for (let addr = startAddr; addr < endAddr; ) {
    if (dataStartAddresses.has(addr) || addr + 4 > endAddr) {
      // Split remaining data into segments bounded by ADR targets
      const sortedTargets = Array.from(dataStartAddresses)
        .filter(a => a >= addr && a < endAddr)
        .sort((a, b) => a - b);
      if (sortedTargets[0] !== addr) sortedTargets.unshift(addr);
      sortedTargets.push(endAddr);

      for (let i = 0; i < sortedTargets.length - 1; i++) {
        const segStart = sortedTargets[i];
        const segLen = sortedTargets[i + 1] - segStart;
        if (segLen > 0) {
          renderDataRows(segStart, emulator.memory.readBlock(segStart, segLen));
        }
      }
      break;
    }

    const rawInstr = emulator.memory.read32(addr);
    const decoded = Decoder.decode(rawInstr);

    // If we hit an UNKNOWN instruction, render remaining bytes as data segments
    if (decoded.type === InstructionType.UNKNOWN) {
      const remLen = endAddr - addr;
      const bytes = emulator.memory.readBlock(addr, remLen);
      renderDataRows(addr, bytes);
      break;
    }

    if (decoded.type === InstructionType.ADR) {
      const target = addr + decoded.offsetBytes;
      if (target > addr && target < endAddr) {
        dataStartAddresses.add(target);
      }
    }

    const hexAddr = `0x${addr.toString(16).padStart(8, "0")}`;
    const hexInstr = rawInstr.toString(16).padStart(8, "0");
    const hasBP = emulator.hasBreakpoint(addr);

    const tr = document.createElement("tr");
    tr.id = `disasm-row-${addr}`;
    tr.className = "disasm-row";
    tr.dataset.addr = addr;

    tr.innerHTML = `
      <td class="disasm-bp-col" title="Toggle breakpoint at ${hexAddr}">
        <span class="bp-marker ${hasBP ? "active" : ""}" data-addr="${addr}"></span>
      </td>
      <td class="disasm-addr">${hexAddr}</td>
      <td class="disasm-hex">${hexInstr}</td>
      <td class="disasm-instr">${escapeHtml(decoded.disassembly)}</td>
      <td class="disasm-comment">${escapeHtml(getInstructionAnnotation(decoded, addr))}</td>
    `;

    const currentAddr = addr;
    tr.addEventListener("click", () => {
      toggleBreakpointAt(currentAddr);
    });

    disasmTableBody.appendChild(tr);
    addr += 4;
  }

  updateDisassemblyPointer();
}

function isPrintableSlice(bytes) {
  let printable = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 10 || b === 13) printable++;
  }
  return bytes.length > 0 && (printable / bytes.length) >= 0.75;
}

function renderDataRows(startAddr, bytes) {
  const hexAddr = `0x${startAddr.toString(16).padStart(8, "0")}`;
  const previewHex = Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("");

  let directiveText = "";
  let commentText = "";

  if (isPrintableSlice(bytes)) {
    const text = new TextDecoder().decode(bytes).replace(/\n/g, "\\n");
    directiveText = `.ascii "${escapeHtml(text)}"`;
    commentText = `Embedded read-only string data (${bytes.length} bytes)`;
  } else {
    const words = [];
    for (let i = 0; i + 4 <= Math.min(bytes.length, 16); i += 4) {
      const w = ((bytes[i]) | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
      words.push(`0x${w.toString(16).padStart(8, "0")}`);
    }
    const suffix = bytes.length > 16 ? ", …" : "";
    directiveText = `.word ${words.join(", ")}${suffix}`;
    commentText = `Embedded read-only 32-bit word table (${bytes.length} bytes / ${Math.floor(bytes.length / 4)} words)`;
  }

  const tr = document.createElement("tr");
  tr.className = "disasm-row data-row";
  tr.innerHTML = `
    <td class="disasm-bp-col"></td>
    <td class="disasm-addr">${hexAddr}</td>
    <td class="disasm-hex">${previewHex}…</td>
    <td class="disasm-instr">${directiveText}</td>
    <td class="disasm-comment">${commentText}</td>
  `;
  tr.addEventListener("click", () => {
    switchMemoryTab("hexView");
    updateMemoryGrid(startAddr);
  });
  disasmTableBody.appendChild(tr);
}

function getInstructionAnnotation(decoded, addr = 0) {
  if (!decoded) return "";
  const fmtTarget = (offset) => `0x${(addr + offset).toString(16).padStart(8, "0")}`;

  switch (decoded.type) {
    case InstructionType.MOVZ:
    case InstructionType.MOVN:
      return `${regLabel(decoded.rd)} ← ${decoded.immValue} (0x${decoded.immValue.toString(16)})`;
    case InstructionType.MOVK:
      return `${regLabel(decoded.rd)}[${decoded.shift + 15}:${decoded.shift}] ← 0x${decoded.imm16.toString(16)} (keep other bits)`;
    case InstructionType.ADR:
      return `${regLabel(decoded.rd)} ← ${fmtTarget(decoded.offsetBytes)} (PC-relative address)`;
    case InstructionType.ADRP: {
      const pageBase = (addr & ~0xfff) + Number(decoded.offsetBytes);
      return `${regLabel(decoded.rd)} ← 0x${pageBase.toString(16).padStart(8, "0")} (4KB Page Base)`;
    }
    case InstructionType.ADD_IMM:
      return `${regLabel(decoded.rd, true)} ← ${regLabel(decoded.rn, true)} + ${decoded.immValue}`;
    case InstructionType.SUB_IMM:
      return `${regLabel(decoded.rd, true)} ← ${regLabel(decoded.rn, true)} - ${decoded.immValue}`;
    case InstructionType.SUBS_IMM:
      return decoded.rd === 31
        ? `Compare ${regLabel(decoded.rn, true)} with ${decoded.immValue} → set NZCV`
        : `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn, true)} - ${decoded.immValue} (set NZCV)`;
    case InstructionType.ADD_REG:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} + ${regLabel(decoded.rm)}`;
    case InstructionType.SUB_REG:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} - ${regLabel(decoded.rm)}`;
    case InstructionType.SUBS_REG:
      return decoded.rd === 31
        ? `Compare ${regLabel(decoded.rn)} with ${regLabel(decoded.rm)} → set NZCV`
        : `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} - ${regLabel(decoded.rm)} (set NZCV)`;
    case InstructionType.MUL:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} × ${regLabel(decoded.rm)} (64-bit)`;
    case InstructionType.MADD:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.ra)} + (${regLabel(decoded.rn)} × ${regLabel(decoded.rm)})`;
    case InstructionType.MSUB:
      return decoded.ra === 31
        ? `${regLabel(decoded.rd)} ← -(${regLabel(decoded.rn)} × ${regLabel(decoded.rm)})`
        : `${regLabel(decoded.rd)} ← ${regLabel(decoded.ra)} - (${regLabel(decoded.rn)} × ${regLabel(decoded.rm)})`;
    case InstructionType.UDIV:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} ÷ ${regLabel(decoded.rm)} (unsigned)`;
    case InstructionType.SDIV:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} ÷ ${regLabel(decoded.rm)} (signed)`;
    case InstructionType.AND_REG:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} & ${regLabel(decoded.rm)}`;
    case InstructionType.ORR_REG:
      return decoded.rn === 31
        ? `Copy ${regLabel(decoded.rd)} ← ${regLabel(decoded.rm)}`
        : `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} | ${regLabel(decoded.rm)}`;
    case InstructionType.EOR_REG:
      return `${regLabel(decoded.rd)} ← ${regLabel(decoded.rn)} ^ ${regLabel(decoded.rm)} (XOR)`;
    case InstructionType.MVN_REG:
      return `${regLabel(decoded.rd)} ← ~${regLabel(decoded.rm)} (Bitwise NOT)`;
    case InstructionType.CSEL:
      return `${regLabel(decoded.rd)} ← (${decoded.condName.toUpperCase()}) ? ${regLabel(decoded.rn)} : ${regLabel(decoded.rm)}`;
    case InstructionType.CSINC:
      return (decoded.rn === 31 && decoded.rm === 31)
        ? `${regLabel(decoded.rd)} ← (${decoded.disassembly.split(", ").pop().toUpperCase()}) ? 1 : 0`
        : `${regLabel(decoded.rd)} ← (${decoded.condName.toUpperCase()}) ? ${regLabel(decoded.rn)} : (${regLabel(decoded.rm)} + 1)`;
    case InstructionType.CSINV:
      return `${regLabel(decoded.rd)} ← (${decoded.condName.toUpperCase()}) ? ${regLabel(decoded.rn)} : ~${regLabel(decoded.rm)}`;
    case InstructionType.CSNEG:
      return `${regLabel(decoded.rd)} ← (${decoded.condName.toUpperCase()}) ? ${regLabel(decoded.rn)} : -${regLabel(decoded.rm)}`;
    case InstructionType.UBFM:
      return `${regLabel(decoded.rd)} ← Unsigned Bitfield / Shift (${decoded.disassembly})`;
    case InstructionType.SBFM:
      return `${regLabel(decoded.rd)} ← Signed Bitfield / Sign-Extend (${decoded.disassembly})`;
    case InstructionType.STR_IMM:
    case InstructionType.STRW_IMM:
    case InstructionType.STRH_IMM:
    case InstructionType.STRB_IMM:
      if (decoded.postIndex) {
        return `Store ${regLabel(decoded.rt)} to [${regLabel(decoded.rn, true)}], then ${regLabel(decoded.rn, true)} += ${decoded.offsetBytes}`;
      }
      if (decoded.preIndex) {
        return `${regLabel(decoded.rn, true)} += ${decoded.offsetBytes}, then store ${regLabel(decoded.rt)} to [${regLabel(decoded.rn, true)}]`;
      }
      return decoded.isRegOffset
        ? `Store ${regLabel(decoded.rt)} to [${regLabel(decoded.rn, true)} + ${regLabel(decoded.rm)} << ${decoded.regShift}]`
        : `Store ${regLabel(decoded.rt)} to [${regLabel(decoded.rn, true)} + ${decoded.offsetBytes}]`;
    case InstructionType.LDR_IMM:
    case InstructionType.LDRW_IMM:
    case InstructionType.LDRSW_IMM:
    case InstructionType.LDRH_IMM:
    case InstructionType.LDRSH_IMM:
    case InstructionType.LDRB_IMM:
    case InstructionType.LDRSB_IMM:
      if (decoded.postIndex) {
        return `Load ${regLabel(decoded.rt)} from [${regLabel(decoded.rn, true)}], then ${regLabel(decoded.rn, true)} += ${decoded.offsetBytes}`;
      }
      if (decoded.preIndex) {
        return `${regLabel(decoded.rn, true)} += ${decoded.offsetBytes}, then load ${regLabel(decoded.rt)} from [${regLabel(decoded.rn, true)}]`;
      }
      return decoded.isRegOffset
        ? `Load ${regLabel(decoded.rt)} from [${regLabel(decoded.rn, true)} + ${regLabel(decoded.rm)} << ${decoded.regShift}]`
        : `Load ${regLabel(decoded.rt)} from [${regLabel(decoded.rn, true)} + ${decoded.offsetBytes}]`;
    case InstructionType.STP:
      return `Push pair (${regLabel(decoded.rt1)}, ${regLabel(decoded.rt2)}) to [${regLabel(decoded.rn, true)}]`;
    case InstructionType.LDP:
      return `Pop pair (${regLabel(decoded.rt1)}, ${regLabel(decoded.rt2)}) from [${regLabel(decoded.rn, true)}]`;
    case InstructionType.B_COND:
      return `If ${decoded.condName.toUpperCase()} → jump to ${fmtTarget(decoded.offsetBytes)}`;
    case InstructionType.CBZ:
      return `If ${regLabel(decoded.rt)} == 0 → jump to ${fmtTarget(decoded.offsetBytes)}`;
    case InstructionType.CBNZ:
      return `If ${regLabel(decoded.rt)} != 0 → jump to ${fmtTarget(decoded.offsetBytes)}`;
    case InstructionType.TBZ:
      return `If bit ${decoded.bitPos} of ${regLabel(decoded.rt)} == 0 → jump to ${fmtTarget(decoded.offsetBytes)}`;
    case InstructionType.TBNZ:
      return `If bit ${decoded.bitPos} of ${regLabel(decoded.rt)} != 0 → jump to ${fmtTarget(decoded.offsetBytes)}`;
    case InstructionType.B:
      return `Unconditional jump → ${fmtTarget(decoded.offsetBytes)}`;
    case InstructionType.BL:
      return `Call subroutine ${fmtTarget(decoded.offsetBytes)} (LR ← 0x${(addr + 4).toString(16)})`;
    case InstructionType.BR:
      return `Indirect jump to ${regLabel(decoded.rn)}`;
    case InstructionType.BLR:
      return `Call function pointer in ${regLabel(decoded.rn)}`;
    case InstructionType.RET:
      return `Return from subroutine to ${regLabel(decoded.rn)} (LR)`;
    case InstructionType.MRS:
      return `${regLabel(decoded.rt)} ← ${decoded.sysregName.toUpperCase()} (Read Thread/System Register)`;
    case InstructionType.MSR:
      return `${decoded.sysregName.toUpperCase()} ← ${regLabel(decoded.rt)} (Write Thread/System Register)`;
    case InstructionType.SVC:
      return `Linux ARM64 Syscall Trap (svc #${decoded.imm16 ?? 0}, X8 = syscall#)`;
    default:
      return "";
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toggleBreakpointAt(addr) {
  const active = emulator.toggleBreakpoint(addr);
  const row = document.getElementById(`disasm-row-${addr}`);
  if (row) {
    const marker = row.querySelector(".bp-marker");
    if (marker) {
      if (active) marker.classList.add("active");
      else marker.classList.remove("active");
    }
  }
  appendTerminal(`[Debugger] Breakpoint ${active ? "set" : "cleared"} at 0x${addr.toString(16).padStart(8, "0")}\n`);
}

function updateDisassemblyPointer() {
  const currentPC = Number(emulator.cpu.pc);
  const rows = disasmTableBody.querySelectorAll(".disasm-row");
  rows.forEach(r => r.classList.remove("active-pc"));

  const activeRow = document.getElementById(`disasm-row-${currentPC}`);
  if (activeRow) {
    activeRow.classList.add("active-pc");
    activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// 4. Memory Hex Inspector & Call Stack Frame Inspector
function updateMemoryGrid(startAddr = currentMemAddr) {
  currentMemAddr = Math.max(0, Number(startAddr) & ~0xf); // Align to 16 bytes
  memAddrInput.value = `0x${currentMemAddr.toString(16).padStart(8, "0")}`;
  hexTableBody.innerHTML = "";

  const ROWS = 16; // 16 rows * 16 bytes = 256 bytes
  for (let r = 0; r < ROWS; r++) {
    const rowAddr = currentMemAddr + r * 16;
    const bytes = emulator.memory.readBlock(rowAddr, 16);

    let hexHtml = "";
    let asciiPart = "";

    for (let c = 0; c < 16; c++) {
      const byteAddr = rowAddr + c;
      const b = bytes[c];
      const hexStr = b.toString(16).padStart(2, "0");
      const isChanged = changedMemoryBytes.has(byteAddr);
      const cls = isChanged ? "byte-changed" : (b !== 0 ? "nonzero" : "zero");

      hexHtml += `<span class="hex-byte ${cls}">${hexStr}</span>` + (c === 7 ? "  " : " ");
      asciiPart += (b >= 32 && b <= 126) ? String.fromCharCode(b) : ".";
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="hex-addr">0x${rowAddr.toString(16).padStart(8, "0")}</td>
      <td class="hex-bytes">${hexHtml}</td>
      <td class="hex-ascii">${escapeHtml(asciiPart)}</td>
    `;
    hexTableBody.appendChild(tr);
  }

  updateStackView();
}

function updateStackView() {
  stackTableBody.innerHTML = "";
  const sp = Number(emulator.cpu.sp);
  const fp = Number(emulator.cpu.getReg(29));
  const stackTop = 0x00700000;

  // Show 16 64-bit stack slots around SP and stack base (0x00700000 down to 0x006fff80)
  const lowestAddr = Math.min(sp - 32, stackTop - 128) & ~0x7;
  const highestAddr = stackTop;

  for (let addr = highestAddr; addr >= lowestAddr; addr -= 8) {
    const val = emulator.memory.read64(addr);
    const hexAddr = `0x${addr.toString(16).padStart(8, "0")}`;
    const hexVal = `0x${val.toString(16).padStart(16, "0")}`;

    let badges = "";
    if (addr === sp) badges += `<span class="stack-badge badge-sp">← SP</span>`;
    if (addr === fp && fp !== 0) badges += `<span class="stack-badge badge-fp">← FP (X29)</span>`;
    if (val >= 0x00400000n && val < 0x00401000n) {
      badges += `<span class="stack-badge badge-lr">Return Addr</span>`;
    } else if (val !== 0n && !badges) {
      badges = `<span style="color: var(--text-muted);">${BigInt.asIntN(64, val).toString()}</span>`;
    }

    const isModified = changedMemoryBytes.has(addr) || changedMemoryBytes.has(addr + 4);
    const tr = document.createElement("tr");
    tr.className = `reg-row ${isModified ? "changed" : ""}`;
    tr.innerHTML = `
      <td class="reg-name">${hexAddr}</td>
      <td class="reg-hex" style="color: ${val === 0n ? "#475569" : "var(--text-primary)"};">${hexVal}</td>
      <td class="reg-dec">${badges || "—"}</td>
    `;
    stackTableBody.appendChild(tr);
  }
}

// 5. Populate Binary Translators (x86-64 & Static AOT JS)
function updateTranslatedViews(buffer, name) {
  benchResultBadge.textContent = "";
  try {
    const x86Translator = new Arm2X86Translator(buffer, name);
    x86CodeBlock.textContent = x86Translator.translate(false);
  } catch (err) {
    x86CodeBlock.textContent = `; Translation error: ${err.message}`;
  }

  try {
    const aotRecompiler = new StaticRecompiler(buffer, name);
    currentAotSource = aotRecompiler.recompile(false);
    aotCodeBlock.textContent = currentAotSource;
  } catch (err) {
    currentAotSource = "";
    aotCodeBlock.textContent = `// Recompilation error: ${err.message}`;
  }
}

// 6. Level 1 MMIO Virtual Screen Renderer & Pixel Probe
function isGraphicsBinary(filename = "") {
  const f = filename.toLowerCase();
  return f.includes("graphics") || f.includes("plasma") || f.includes("pattern") ||
         f.includes("screen") || f.includes("framebuffer") || f.includes("paint") ||
         f.includes("interactive");
}

function isInteractiveBinary(filename = "") {
  const f = filename.toLowerCase();
  return f.includes("interactive") || f.includes("paint") || f.includes("game");
}

function isHeapBinary(filename = "") {
  const f = filename.toLowerCase();
  return f.includes("heap") || f.includes("dynamic") || f.includes("malloc") || f.includes("alloc");
}

function runUntilFrameOrHalt(emuInstance, maxCycles = 2000000) {
  let steps = 0;
  while (!emuInstance.cpu.halted && steps < maxCycles) {
    const res = emuInstance.step(false);
    steps++;
    if (res.halted || res.yielded || res.hitBreakpoint) {
      break;
    }
  }
  return Number(emuInstance.cpu.getReg(0));
}

function switchMemoryTab(tabId) {
  document.querySelectorAll(".mem-tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.memtab === tabId);
  });
  document.querySelectorAll(".mem-tab-content").forEach(c => {
    c.style.display = c.id === tabId ? "block" : "none";
  });
  if (memToolbar) {
    memToolbar.style.display = (tabId === "hexView" || tabId === "heapView") ? "flex" : "none";
  }
  if (vramHeaderBadge) {
    vramHeaderBadge.textContent =
      tabId === "screenView" ? "320×240 RGBA" :
      tabId === "stackView" ? "64-bit Frames" :
      tabId === "heapView" ? "Dynamic Heap" : "4 KB Pages";
  }
  if (tabId === "screenView") {
    renderVramScreen(true);
  } else if (tabId === "heapView") {
    updateHeapView();
  }
}

function updateHeapView() {
  if (!heapBrkVal) return;
  const stats = emulator.getHeapStats();
  heapBrkVal.textContent = `0x${stats.brk.toString(16).padStart(8, "0")}`;
  heapAllocVal.textContent = `${stats.allocatedBytes.toLocaleString()} B (${stats.allocatedCount} chunks)`;
  heapFreeVal.textContent = `${stats.freeBytes.toLocaleString()} B (${stats.freeCount} holes)`;
  heapPagesVal.textContent = `${stats.pageCount} (${Math.round(stats.mappedBytes / 1024)} KB)`;
  if (heapMapTitle) {
    heapMapTitle.textContent = `VISUAL HEAP MAP (0x${stats.heapStart.toString(16).padStart(8, "0")} → 0x${stats.brk.toString(16).padStart(8, "0")} • ${stats.heapSize} B)`;
  }

  const allItems = [
    ...stats.chunks,
    ...(stats.mmapRegions || []).map(r => ({
      addr: r.addr,
      size: r.len,
      payloadSize: r.len,
      payloadAddr: r.addr,
      isAllocated: true,
      isMmap: true
    }))
  ];

  if (heapVisualStrip) {
    heapVisualStrip.innerHTML = "";
    if (allItems.length === 0) {
      heapVisualStrip.innerHTML = `<span style="color: var(--text-muted); font-size: 11px; align-self: center; margin: auto;">No heap allocations yet (brk = 0x${stats.heapStart.toString(16)}). Run program to allocate memory.</span>`;
    } else {
      allItems.forEach(c => {
        const box = document.createElement("div");
        const isAlloc = c.isAllocated;
        box.className = `heap-chunk-box ${isAlloc ? "heap-chunk-alloc" : "heap-chunk-free"}`;
        const widthPx = Math.max(54, Math.min(220, Math.round(c.size * 1.2)));
        box.style.width = `${widthPx}px`;
        const label = c.isMmap ? "MMAP" : c.isRaw ? "RAW" : (isAlloc ? "ALLOC" : "FREE");
        const addrHex = `0x${c.addr.toString(16)}`;
        box.title = `Chunk @ ${addrHex} • Size: ${c.size}B (Payload: ${c.payloadSize}B) • ${label} (Click to inspect in Hex)`;
        box.innerHTML = `<span style="font-weight: 700;">${label}</span><span>${c.size}B</span>`;
        box.addEventListener("click", () => {
          switchMemoryTab("hexView");
          updateMemoryGrid(c.addr);
        });
        heapVisualStrip.appendChild(box);
      });
    }
  }

  if (heapTableBody) {
    heapTableBody.innerHTML = "";
    if (allItems.length === 0) {
      heapTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No heap chunks recorded.</td></tr>`;
    } else {
      allItems.forEach(c => {
        const isAlloc = c.isAllocated;
        const badgeLabel = c.isMmap ? "MMAP" : c.isRaw ? "RAW" : (isAlloc ? "ALLOC" : "FREE");
        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        tr.title = "Click to inspect chunk header in Memory Hex view";
        tr.innerHTML = `
          <td class="hex-addr">0x${c.addr.toString(16).padStart(8, "0")}</td>
          <td><span class="heap-badge ${isAlloc ? "badge-alloc" : "badge-free"}">${badgeLabel}</span></td>
          <td style="color: var(--text-primary); font-weight: 600;">${c.size} B</td>
          <td style="color: ${isAlloc ? "var(--accent-cyan)" : "var(--text-muted)"};">${c.payloadSize} B</td>
          <td class="mono" style="color: ${isAlloc ? "var(--accent-amber)" : "var(--text-muted)"};">0x${c.payloadAddr.toString(16).padStart(8, "0")}</td>
        `;
        tr.addEventListener("click", () => {
          switchMemoryTab("hexView");
          updateMemoryGrid(c.addr);
        });
        heapTableBody.appendChild(tr);
      });
    }
  }
}

function renderVramScreen(force = false) {
  if (!vramCtx || !vramImageData) return;
  if (!force && !emulator.isVramDirty()) return;

  emulator.getVramBuffer(vramImageData.data);
  vramCtx.putImageData(vramImageData, 0, 0);
  emulator.clearVramDirty();
  renderedFrames++;

  if (vramFrameCount) vramFrameCount.textContent = renderedFrames;
  if (vramStatusText) {
    vramStatusText.textContent = emulator.cpu.halted ? "Frame Ready" : "Rendering";
    vramStatusText.className = emulator.cpu.halted ? "text-emerald" : "text-cyan";
  }

  frameCounterInSec++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    if (vramFpsBadge) {
      const fps = Math.round((frameCounterInSec * 1000) / (now - lastFpsTime));
      vramFpsBadge.textContent = `${fps} FPS`;
    }
    frameCounterInSec = 0;
    lastFpsTime = now;
  }
}

function instantRenderFrame() {
  stopRunning();
  if (emulator.cpu.halted) {
    emulator.reset();
  }
  const t0 = performance.now();
  const prevCycles = emulator.cycleCount;
  runUntilFrameOrHalt(emulator, 2000000);
  const frameCycles = emulator.cycleCount - prevCycles;
  const elapsed = (performance.now() - t0).toFixed(1);
  updateCPUState();
  updateDisassemblyPointer();
  updateMemoryGrid(currentMemAddr);
  updateHeapView();
  renderVramScreen(true);
  appendTerminal(`[Screen] Frame rendered in ${elapsed} ms (+${frameCycles.toLocaleString()} cycles, total ${emulator.cycleCount.toLocaleString()}).\n`);
}

function clearVramScreen() {
  if (!vramCtx || !vramImageData) return;
  for (let i = 0; i < FB_SIZE; i += 4) {
    emulator.memory.write32(0x00800000 + i, 0xff000000); // Opaque black
  }
  renderVramScreen(true);
  appendTerminal("[Screen] Framebuffer cleared (0x00800000).\n");
}

// 7. Execution Step & Loop Control
function stepSingle() {
  if (emulator.cpu.halted) return;

  const res = emulator.step(false);
  changedMemoryBytes = new Set(res.changedMem || []);

  // If the instruction wrote to memory outside stack, optionally show it if user is on RAM
  updateCPUState(res.changedRegs);
  updateDisassemblyPointer();
  updateMemoryGrid(currentMemAddr);
  updateHeapView();
  renderVramScreen();

  if (res.halted) {
    stopRunning();
    renderVramScreen(true);
  } else if (res.yielded) {
    renderVramScreen(true);
  } else if (res.hitBreakpoint) {
    stopRunning();
    setStatus("PAUSED", `BP @ 0x${res.nextPC.toString(16).padStart(8, "0")}`, "status-paused");
    appendTerminal(`[Debugger] Execution paused at breakpoint 0x${res.nextPC.toString(16).padStart(8, "0")}\n`);
  }
}

function startRunning() {
  if (emulator.cpu.halted) {
    resetEmulator();
  }
  isRunning = true;
  runBtn.textContent = "⏸ Pause";
  runBtn.className = "btn btn-danger";
  setStatus("RUNNING", "RUNNING", "status-running");

  const speedConfig = SPEED_LEVELS[speedSlider.value] || SPEED_LEVELS["3"];

  if (speedConfig.turbo) {
    function turboLoop() {
      if (!isRunning || emulator.cpu.halted) return;
      let lastRes = null;
      const batchSize = 15000; // High-throughput chunk for smooth 60 FPS scanline sweeps
      for (let i = 0; i < batchSize; i++) {
        lastRes = emulator.step(false);
        if (lastRes.halted || lastRes.hitBreakpoint) {
          changedMemoryBytes = new Set(lastRes.changedMem || []);
          updateCPUState(lastRes.changedRegs);
          updateDisassemblyPointer();
          updateMemoryGrid(currentMemAddr);
          updateHeapView();
          renderVramScreen(true);
          stopRunning();
          if (lastRes.hitBreakpoint) {
            setStatus("PAUSED", `BP @ 0x${lastRes.nextPC.toString(16)}`, "status-paused");
          }
          return;
        }
        if (lastRes.yielded) {
          changedMemoryBytes = new Set(lastRes.changedMem || []);
          updateCPUState(lastRes.changedRegs);
          updateHeapView();
          renderVramScreen(true);
          runTimer = requestAnimationFrame(turboLoop);
          return;
        }
      }
      if (lastRes) {
        changedMemoryBytes = new Set(lastRes.changedMem || []);
        updateCPUState(lastRes.changedRegs);
      }
      updateDisassemblyPointer();
      updateMemoryGrid(currentMemAddr);
      updateHeapView();
      renderVramScreen();
      runTimer = requestAnimationFrame(turboLoop);
    }
    runTimer = requestAnimationFrame(turboLoop);
  } else {
    runTimer = setInterval(() => {
      if (!isRunning || emulator.cpu.halted) {
        stopRunning();
        renderVramScreen(true);
        return;
      }
      stepSingle();
    }, speedConfig.delay);
  }
}

function stopRunning() {
  isRunning = false;
  runBtn.textContent = "▶ Run";
  runBtn.className = "btn btn-primary";

  if (runTimer) {
    clearInterval(runTimer);
    cancelAnimationFrame(runTimer);
    runTimer = null;
  }

  if (!emulator.cpu.halted) {
    setStatus("PAUSED", "PAUSED", "status-paused");
  }
  updateHeapView();
  renderVramScreen(true);
}

function resetEmulator() {
  stopRunning();
  emulator.reset();
  activeKeyMask = 0;
  isCanvasMouseDown = false;
  updateInputState();
  changedRegisters.clear();
  changedMemoryBytes.clear();
  updateCPUState();
  updateDisassemblyPointer();
  updateMemoryGrid(currentMemAddr);
  updateHeapView();
  renderVramScreen(true);
  setStatus("READY", "READY", "status-ready");
  appendTerminal(`[Mini-QEMU] Reset to entry point 0x${emulator.cpu.pc.toString(16).padStart(8, "0")}.\n`);
}

// 7. Binary Loading Logic
async function loadBinaryFromUrl(url, filename, desc = "") {
  stopRunning();
  try {
    setStatus("READY", `Loading ${filename}...`, "status-ready");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP error ${res.status}: ${res.statusText}`);

    const buffer = await res.arrayBuffer();
    loadBinaryBuffer(buffer, filename, desc);
  } catch (err) {
    console.error("Failed to load binary:", err);
    appendTerminal(`[Error] Failed to load ${filename}: ${err.message}\n`);
  }
}

function loadBinaryBuffer(buffer, filename, desc = "") {
  currentLoadedBuffer = buffer;
  currentLoadedName = filename;

  const entry = emulator.loadElf(buffer, filename);
  loadedBinaryInfo.textContent = `${filename} (Entry: 0x${entry.toString(16).padStart(8, "0")})`;
  if (desc) {
    programDescText.textContent = desc;
  }

  currentMemAddr = Number(entry);
  activeKeyMask = 0;
  isCanvasMouseDown = false;
  updateInputState();
  changedRegisters.clear();
  changedMemoryBytes.clear();

  initRegistersTable();
  updateCPUState();
  disassembleLoadedBinary();
  updateMemoryGrid(currentMemAddr);
  updateTranslatedViews(buffer, filename);

  setStatus("READY", "READY", "status-ready");
  appendTerminal(`[Mini-QEMU] Loaded "${filename}" (${buffer.byteLength}B) -> Entry 0x${entry.toString(16).padStart(8, "0")}\n`);

  if (instantRenderBtn) {
    instantRenderBtn.textContent = isInteractiveBinary(filename) ? "⚡ Step Frame" : "⚡ Instant";
  }

  if (isGraphicsBinary(filename)) {
    speedSlider.value = "5";
    speedLabel.textContent = SPEED_LEVELS["5"].label;
    switchMemoryTab("screenView");
    if (runBenchBtn) runBenchBtn.textContent = "⚡ Benchmark 3 Frames";
  } else if (isHeapBinary(filename)) {
    switchMemoryTab("heapView");
    if (runBenchBtn) runBenchBtn.textContent = "⚡ Benchmark 5,000 Runs";
  } else {
    if (runBenchBtn) runBenchBtn.textContent = "⚡ Benchmark 5,000 Runs";
  }
}

async function loadBinariesList() {
  try {
    const res = await fetch("/api/binaries");
    if (!res.ok) throw new Error("Could not fetch /api/binaries");
    const binaries = await res.json();

    programSelect.innerHTML = "";
    binaries.forEach((bin) => {
      const opt = document.createElement("option");
      opt.value = bin.url;
      opt.dataset.filename = bin.filename;
      opt.dataset.desc = bin.description;
      opt.textContent = `${bin.title} (${bin.filename})`;
      programSelect.appendChild(opt);
    });

    if (binaries.length > 0) {
      loadBinaryFromUrl(binaries[0].url, binaries[0].filename, binaries[0].description);
    }
  } catch (err) {
    console.error("Failed to fetch binaries list:", err);
  }
}

// 8. Live In-Browser AOT Benchmark
runBenchBtn.addEventListener("click", () => {
  if (!currentLoadedBuffer || !currentAotSource) return;

  const isGfx = isGraphicsBinary(currentLoadedName);
  const ITERATIONS = isGfx ? 3 : 5000;
  const MAX_CYCLES = isGfx ? 2000000 : 2000;

  // Create executable JS function from lifted source
  const bodySource = currentAotSource.replace(/export\s+function\s+runNative\s*\(\)\s*\{/, "").replace(/\}\s*$/, "");
  const nativeFn = new Function(bodySource);

  // 1. Run Interpreter
  const benchEmu = new MiniQEMU();
  benchEmu.suppressStdout = true;
  benchEmu.loadElf(currentLoadedBuffer, currentLoadedName);

  const t0 = performance.now();
  let interpRes = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    benchEmu.cpu.reset();
    benchEmu.cpu.pc = benchEmu.entryPoint;
    benchEmu.cycleCount = 0;
    interpRes = runUntilFrameOrHalt(benchEmu, MAX_CYCLES);
  }
  const interpMs = Math.max(0.05, performance.now() - t0);

  // 2. Run Static AOT JS
  const t1 = performance.now();
  let aotRes = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    aotRes = nativeFn();
  }
  const aotMs = Math.max(0.05, performance.now() - t1);

  const speedup = (interpMs / aotMs).toFixed(1);
  benchResultBadge.textContent = `${speedup}x Faster (${interpMs.toFixed(1)}ms vs ${aotMs.toFixed(2)}ms)`;
  appendTerminal(`[AOT Benchmark] ${ITERATIONS.toLocaleString()} runs of ${currentLoadedName}: Interpreter=${interpMs.toFixed(2)}ms (X0=${interpRes}) | Static AOT=${aotMs.toFixed(2)}ms (X0=${aotRes}) -> ${speedup}x Speedup!\n`, "halt");
});

// 9. Event Listeners & View Tabs
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => { c.style.display = "none"; });
    btn.classList.add("active");
    const target = document.getElementById(btn.dataset.tab);
    if (target) target.style.display = "block";
  });
});

document.querySelectorAll(".mem-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    switchMemoryTab(btn.dataset.memtab);
  });
});

programSelect.addEventListener("change", () => {
  const opt = programSelect.options[programSelect.selectedIndex];
  loadBinaryFromUrl(opt.value, opt.dataset.filename || opt.textContent, opt.dataset.desc || "");
});

uploadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopRunning();
  try {
    const arrayBuffer = await file.arrayBuffer();
    loadBinaryBuffer(arrayBuffer, file.name, `Custom uploaded ARM64 ELF binary (${file.size} bytes)`);
  } catch (err) {
    appendTerminal(`[Error] Failed to load ELF: ${err.message}\n`);
  }
});

runBtn.addEventListener("click", () => {
  if (isRunning) stopRunning();
  else startRunning();
});

stepBtn.addEventListener("click", () => {
  stopRunning();
  stepSingle();
});

resetBtn.addEventListener("click", resetEmulator);

speedSlider.addEventListener("input", () => {
  const cfg = SPEED_LEVELS[speedSlider.value];
  speedLabel.textContent = cfg.label;
  if (isRunning) {
    stopRunning();
    startRunning();
  }
});

clearConsoleBtn.addEventListener("click", () => {
  terminalWindow.innerHTML = "";
});

// Memory navigation & clickable registers
memGoBtn.addEventListener("click", () => {
  const addr = parseInt(memAddrInput.value.trim(), 16);
  if (!isNaN(addr)) updateMemoryGrid(addr);
});

memAddrInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const addr = parseInt(memAddrInput.value.trim(), 16);
    if (!isNaN(addr)) updateMemoryGrid(addr);
  }
});

memPrevBtn.addEventListener("click", () => updateMemoryGrid(currentMemAddr - 64));
memNextBtn.addEventListener("click", () => updateMemoryGrid(currentMemAddr + 64));

jumpTextBtn.addEventListener("click", () => updateMemoryGrid(Number(emulator.entryPoint || 0x00400000)));
jumpDataBtn.addEventListener("click", () => updateMemoryGrid(0x00402000));
jumpStackBtn.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.sp) - 32));

if (jumpHeapBtn) {
  jumpHeapBtn.addEventListener("click", () => {
    switchMemoryTab("hexView");
    updateMemoryGrid(Number(emulator.heapStart || 0x00500000));
  });
}

if (jumpVramBtn) {
  jumpVramBtn.addEventListener("click", () => {
    switchMemoryTab("hexView");
    updateMemoryGrid(0x00800000);
  });
}

if (jumpVramHexBtn) {
  jumpVramHexBtn.addEventListener("click", () => {
    switchMemoryTab("hexView");
    updateMemoryGrid(0x00800000);
  });
}

if (instantRenderBtn) {
  instantRenderBtn.addEventListener("click", instantRenderFrame);
}

if (clearScreenBtn) {
  clearScreenBtn.addEventListener("click", clearVramScreen);
}

if (crtScanlineToggle && scanlineOverlay) {
  crtScanlineToggle.addEventListener("change", (e) => {
    if (e.target.checked) {
      scanlineOverlay.classList.remove("disabled");
    } else {
      scanlineOverlay.classList.add("disabled");
    }
  });
}

let activeKeyMask = 0;
let isCanvasMouseDown = false;

function updateInputState(lastKey = 0) {
  emulator.setKeyState(activeKeyMask, lastKey);

  const dpadUp = document.getElementById("dpadUp");
  const dpadDown = document.getElementById("dpadDown");
  const dpadLeft = document.getElementById("dpadLeft");
  const dpadRight = document.getElementById("dpadRight");
  const btnA = document.getElementById("btnActionA");
  const btnB = document.getElementById("btnActionB");
  const btnR = document.getElementById("btnActionR");

  if (dpadUp) dpadUp.classList.toggle("active", (activeKeyMask & KEY_MASK_UP) !== 0);
  if (dpadDown) dpadDown.classList.toggle("active", (activeKeyMask & KEY_MASK_DOWN) !== 0);
  if (dpadLeft) dpadLeft.classList.toggle("active", (activeKeyMask & KEY_MASK_LEFT) !== 0);
  if (dpadRight) dpadRight.classList.toggle("active", (activeKeyMask & KEY_MASK_RIGHT) !== 0);
  if (btnA) btnA.classList.toggle("active", (activeKeyMask & KEY_MASK_ACTION_A) !== 0);
  if (btnB) btnB.classList.toggle("active", (activeKeyMask & KEY_MASK_ACTION_B) !== 0);
  if (btnR) btnR.classList.toggle("active", (activeKeyMask & KEY_MASK_RESET) !== 0);

  const badge = document.getElementById("inputStatusBadge");
  if (badge) {
    if (activeKeyMask !== 0) {
      const activeKeys = [];
      if (activeKeyMask & KEY_MASK_UP) activeKeys.push("UP");
      if (activeKeyMask & KEY_MASK_DOWN) activeKeys.push("DOWN");
      if (activeKeyMask & KEY_MASK_LEFT) activeKeys.push("LEFT");
      if (activeKeyMask & KEY_MASK_RIGHT) activeKeys.push("RIGHT");
      if (activeKeyMask & KEY_MASK_ACTION_A) activeKeys.push("PAINT");
      if (activeKeyMask & KEY_MASK_ACTION_B) activeKeys.push("COLOR");
      if (activeKeyMask & KEY_MASK_RESET) activeKeys.push("RESET");
      badge.textContent = `🎮 ${activeKeys.join(" + ")}`;
      badge.style.color = "var(--accent-cyan)";
    } else {
      badge.textContent = "🎮 Keyboard / Pointer Ready";
      badge.style.color = "";
    }
  }
}

if (vramCanvas) {
  const getCanvasPixelCoords = (e) => {
    const rect = vramCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const x = Math.max(0, Math.min(FB_WIDTH - 1, Math.floor(((e.clientX - rect.left) / rect.width) * FB_WIDTH)));
    const y = Math.max(0, Math.min(FB_HEIGHT - 1, Math.floor(((e.clientY - rect.top) / rect.height) * FB_HEIGHT)));
    return { x, y };
  };

  vramCanvas.addEventListener("mousedown", (e) => {
    isCanvasMouseDown = true;
    const { x, y } = getCanvasPixelCoords(e);
    emulator.setPointerState(x, y, 1);
    activeKeyMask |= KEY_MASK_ACTION_A;
    updateInputState();
    if (!isRunning && !emulator.cpu.halted && emulator.cycleCount === 0 && isInteractiveBinary(currentLoadedName)) {
      startRunning();
    }
  });

  vramCanvas.addEventListener("dblclick", (e) => {
    const { x, y } = getCanvasPixelCoords(e);
    const addr = 0x00800000 + (y * FB_WIDTH + x) * 4;
    switchMemoryTab("hexView");
    updateMemoryGrid(addr);
  });

  vramCanvas.addEventListener("mousemove", (e) => {
    const { x, y } = getCanvasPixelCoords(e);
    if (isCanvasMouseDown) {
      emulator.setPointerState(x, y, 1);
    }
    const px = emulator.readVramPixel(x, y);
    const addr = 0x00800000 + (y * FB_WIDTH + x) * 4;
    const hexColor = `#${px.r.toString(16).padStart(2, "0")}${px.g.toString(16).padStart(2, "0")}${px.b.toString(16).padStart(2, "0")}`.toUpperCase();
    if (pixelSwatch) pixelSwatch.style.background = hexColor;
    if (pixelCoordText) pixelCoordText.textContent = `X: ${x}, Y: ${y}`;
    if (pixelAddrText) {
      pixelAddrText.textContent = `@ 0x${addr.toString(16).padStart(8, "0")}`;
      pixelAddrText.dataset.addr = addr.toString();
    }
    if (pixelRgbaText) pixelRgbaText.textContent = `${hexColor} (${px.r},${px.g},${px.b})`;
  });

  const stopCanvasDrag = () => {
    if (isCanvasMouseDown) {
      isCanvasMouseDown = false;
      activeKeyMask &= ~KEY_MASK_ACTION_A;
      emulator.setPointerState(0, 0, 0);
      updateInputState();
    }
  };

  vramCanvas.addEventListener("mouseup", stopCanvasDrag);
  vramCanvas.addEventListener("mouseleave", stopCanvasDrag);
}

if (pixelAddrText) {
  pixelAddrText.style.cursor = "pointer";
  pixelAddrText.title = "Click to inspect pixel address in Memory Hex";
  pixelAddrText.addEventListener("click", () => {
    const addr = parseInt(pixelAddrText.dataset.addr || "8388608", 10);
    switchMemoryTab("hexView");
    updateMemoryGrid(addr);
  });
}

// Wire on-screen D-Pad and Action buttons
const bindPressButton = (id, mask) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  const start = (e) => {
    e.preventDefault();
    activeKeyMask |= mask;
    updateInputState();
    if (!isRunning && !emulator.cpu.halted && emulator.cycleCount === 0 && isInteractiveBinary(currentLoadedName)) {
      startRunning();
    }
  };
  const end = (e) => {
    e.preventDefault();
    activeKeyMask &= ~mask;
    updateInputState();
  };
  btn.addEventListener("mousedown", start);
  btn.addEventListener("mouseup", end);
  btn.addEventListener("mouseleave", end);
  btn.addEventListener("touchstart", start, { passive: false });
  btn.addEventListener("touchend", end, { passive: false });
};

bindPressButton("dpadUp", KEY_MASK_UP);
bindPressButton("dpadDown", KEY_MASK_DOWN);
bindPressButton("dpadLeft", KEY_MASK_LEFT);
bindPressButton("dpadRight", KEY_MASK_RIGHT);
bindPressButton("btnActionA", KEY_MASK_ACTION_A);
bindPressButton("btnActionB", KEY_MASK_ACTION_B);
bindPressButton("btnActionR", KEY_MASK_RESET);

pcBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.pc)));
spBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.sp) - 32));
fpBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.getReg(29))));
lrBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.getReg(30))));

// Keyboard Event Handlers (Controls & Global Shortcuts)
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

  const isInteractive = isInteractiveBinary(currentLoadedName);

  // 1. Check Interactive Gamepad Keys
  let keyBit = 0;
  if (e.code === "ArrowUp" || (isInteractive && e.code === "KeyW")) keyBit = KEY_MASK_UP;
  else if (e.code === "ArrowDown" || (isInteractive && e.code === "KeyS" && !e.ctrlKey && !e.metaKey)) keyBit = KEY_MASK_DOWN;
  else if (e.code === "ArrowLeft" || (isInteractive && e.code === "KeyA")) keyBit = KEY_MASK_LEFT;
  else if (e.code === "ArrowRight" || (isInteractive && e.code === "KeyD")) keyBit = KEY_MASK_RIGHT;
  else if ((e.code === "Space" && (isInteractive || isRunning)) || e.code === "KeyZ" || (isInteractive && e.code === "Enter")) keyBit = KEY_MASK_ACTION_A;
  else if (e.code === "ShiftLeft" || e.code === "ShiftRight" || (isInteractive && (e.code === "KeyX" || e.code === "KeyC"))) keyBit = KEY_MASK_ACTION_B;
  else if (isInteractive && e.code === "KeyR" && !e.ctrlKey && !e.metaKey) keyBit = KEY_MASK_RESET;

  if (keyBit !== 0) {
    e.preventDefault();
    activeKeyMask |= keyBit;
    updateInputState(e.keyCode);
    if (!isRunning && !emulator.cpu.halted && emulator.cycleCount === 0 && isInteractive) {
      startRunning();
    }
    return;
  }

  // 2. Debugger Global Shortcuts
  if (e.code === "Space" || e.code === "F5") {
    e.preventDefault();
    if (isRunning) stopRunning();
    else startRunning();
  } else if (e.code === "F10" || (e.code === "KeyS" && !e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    stopRunning();
    stepSingle();
  } else if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    resetEmulator();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

  let keyBit = 0;
  if (e.code === "ArrowUp" || e.code === "KeyW") keyBit = KEY_MASK_UP;
  else if (e.code === "ArrowDown" || e.code === "KeyS") keyBit = KEY_MASK_DOWN;
  else if (e.code === "ArrowLeft" || e.code === "KeyA") keyBit = KEY_MASK_LEFT;
  else if (e.code === "ArrowRight" || e.code === "KeyD") keyBit = KEY_MASK_RIGHT;
  else if (e.code === "Space" || e.code === "KeyZ" || e.code === "Enter") keyBit = KEY_MASK_ACTION_A;
  else if (e.code === "ShiftLeft" || e.code === "ShiftRight" || e.code === "KeyX" || e.code === "KeyC") keyBit = KEY_MASK_ACTION_B;
  else if (e.code === "KeyR") keyBit = KEY_MASK_RESET;

  if (keyBit !== 0) {
    activeKeyMask &= ~keyBit;
    updateInputState();
  }
});

// Drag and Drop ELF files anywhere on the window
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length > 0) {
    const file = e.dataTransfer.files[0];
    const arrayBuffer = await file.arrayBuffer();
    loadBinaryBuffer(arrayBuffer, file.name, `Dropped ARM64 ELF binary (${file.size} bytes)`);
  }
});

// Initialize UI
initRegistersTable();
updateCPUState();
updateMemoryGrid(0x00400000);
loadBinariesList();
