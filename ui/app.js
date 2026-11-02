// ui/app.js - Mini-QEMU Interactive Browser Controller & AOT Workbench
import { MiniQEMU } from "/src/emulator.js";
import { Decoder, InstructionType } from "/src/decoder.js";
import { Arm2X86Translator } from "/src/arm2x86.js";
import { StaticRecompiler } from "/src/static_recompiler.js";

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
const hexTableBody = document.getElementById("hexTableBody");
const stackTableBody = document.getElementById("stackTableBody");

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
      // Render remaining bytes as embedded ASCII / byte data
      const remLen = endAddr - addr;
      const bytes = emulator.memory.readBlock(addr, remLen);
      renderDataRows(addr, bytes);
      break;
    }

    const rawInstr = emulator.memory.read32(addr);
    const decoded = Decoder.decode(rawInstr);

    // If we hit an UNKNOWN instruction that looks like printable ASCII text, render as data
    if (decoded.type === InstructionType.UNKNOWN && isPrintableSlice(emulator.memory.readBlock(addr, Math.min(8, endAddr - addr)))) {
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
  const text = new TextDecoder().decode(bytes).replace(/\n/g, "\\n");
  const hexAddr = `0x${startAddr.toString(16).padStart(8, "0")}`;
  const previewHex = Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, "0")).join("");

  const tr = document.createElement("tr");
  tr.className = "disasm-row data-row";
  tr.innerHTML = `
    <td class="disasm-bp-col"></td>
    <td class="disasm-addr">${hexAddr}</td>
    <td class="disasm-hex">${previewHex}…</td>
    <td class="disasm-instr">.ascii "${escapeHtml(text)}"</td>
    <td class="disasm-comment">Embedded read-only string data (${bytes.length} bytes)</td>
  `;
  tr.addEventListener("click", () => {
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
    case InstructionType.ADR:
      return `${regLabel(decoded.rd)} ← ${fmtTarget(decoded.offsetBytes)} (PC-relative address)`;
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
    case InstructionType.STR_IMM:
    case InstructionType.STRW_IMM:
    case InstructionType.STRB_IMM:
      return `Store ${regLabel(decoded.rt)} to [${regLabel(decoded.rn, true)} + ${decoded.offsetBytes}]`;
    case InstructionType.LDR_IMM:
    case InstructionType.LDRW_IMM:
    case InstructionType.LDRB_IMM:
      return `Load ${regLabel(decoded.rt)} from [${regLabel(decoded.rn, true)} + ${decoded.offsetBytes}]`;
    case InstructionType.STP:
      return `Push pair (${regLabel(decoded.rt1)}, ${regLabel(decoded.rt2)}) to [${regLabel(decoded.rn, true)}]`;
    case InstructionType.LDP:
      return `Pop pair (${regLabel(decoded.rt1)}, ${regLabel(decoded.rt2)}) from [${regLabel(decoded.rn, true)}]`;
    case InstructionType.B_COND:
      return `If ${decoded.condName.toUpperCase()} → jump to ${fmtTarget(decoded.offsetBytes)}`;
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

// 6. Execution Step & Loop Control
function stepSingle() {
  if (emulator.cpu.halted) return;

  const res = emulator.step(false);
  changedMemoryBytes = new Set(res.changedMem || []);

  // If the instruction wrote to memory outside stack, optionally show it if user is on RAM
  updateCPUState(res.changedRegs);
  updateDisassemblyPointer();
  updateMemoryGrid(currentMemAddr);

  if (res.halted) {
    stopRunning();
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
      for (let i = 0; i < 60; i++) {
        lastRes = emulator.step(false);
        if (lastRes.halted || lastRes.hitBreakpoint) {
          changedMemoryBytes = new Set(lastRes.changedMem || []);
          updateCPUState(lastRes.changedRegs);
          updateDisassemblyPointer();
          updateMemoryGrid(currentMemAddr);
          if (lastRes.hitBreakpoint) {
            stopRunning();
            setStatus("PAUSED", `BP @ 0x${lastRes.nextPC.toString(16)}`, "status-paused");
          }
          return;
        }
      }
      if (lastRes) {
        changedMemoryBytes = new Set(lastRes.changedMem || []);
        updateCPUState(lastRes.changedRegs);
      }
      updateDisassemblyPointer();
      updateMemoryGrid(currentMemAddr);
      runTimer = requestAnimationFrame(turboLoop);
    }
    runTimer = requestAnimationFrame(turboLoop);
  } else {
    runTimer = setInterval(() => {
      if (!isRunning || emulator.cpu.halted) {
        stopRunning();
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
}

function resetEmulator() {
  stopRunning();
  emulator.reset();
  changedRegisters.clear();
  changedMemoryBytes.clear();
  updateCPUState();
  updateDisassemblyPointer();
  updateMemoryGrid(currentMemAddr);
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
  changedRegisters.clear();
  changedMemoryBytes.clear();

  initRegistersTable();
  updateCPUState();
  disassembleLoadedBinary();
  updateMemoryGrid(currentMemAddr);
  updateTranslatedViews(buffer, filename);

  setStatus("READY", "READY", "status-ready");
  appendTerminal(`[Mini-QEMU] Loaded "${filename}" (${buffer.byteLength}B) -> Entry 0x${entry.toString(16).padStart(8, "0")}\n`);
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

  const ITERATIONS = 5000;
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
    interpRes = benchEmu.run(2000, false);
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
    document.querySelectorAll(".mem-tab-btn").forEach(b => b.classList.remove("active"));
    document.getElementById("hexView").style.display = "none";
    document.getElementById("stackView").style.display = "none";
    btn.classList.add("active");
    const target = document.getElementById(btn.dataset.memtab);
    if (target) target.style.display = "block";
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

pcBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.pc)));
spBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.sp) - 32));
fpBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.getReg(29))));
lrBox.addEventListener("click", () => updateMemoryGrid(Number(emulator.cpu.getReg(30))));

// Keyboard Shortcuts: Space/F5 (Run/Pause), F10/S (Step), R (Reset)
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

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
