# Project Architecture & Agent Guidelines

## 1. Multi-Agent Operating Model: Main-Agent (Pro) + Subagent (Flash)

This project adopts a two-tier agent architecture designed to preserve a clean, high-signal context window while accelerating implementation speed:

```
┌────────────────────────────────────────────────────────────────────────┐
│ Main Agent (Gemini Pro / Model 4) - Lead Architect & Reviewer          │
│ • Analyzes requirements, specs, and system architecture                │
│ • Maintains a clean, pristine, high-signal context window              │
│ • Never gets bogged down by repetitive compiler/test iterations        │
│                                                                        │
│   │ 1. Dispatches focused implementation task                          │
│   ▼                                                                    │
│ ┌──────────────────────────────────────────────────────────────────┐   │
│ │ Subagent (Gemini Flash / Model 3.8) - Fast Implementation Engine │   │
│ │ • Independent scratchpad & execution sandbox                     │   │
│ │ • Drafts code, runs lints/tests, and fixes errors in tight loops │   │
│ │ • Context bloat stays strictly isolated inside the subagent      │   │
│ └──────────────────────────────────────────────────────────────────┘   │
│   │                                                                    │
│   │ 2. Returns concise diff summary & test status                      │
│   ▼                                                                    │
│ • Reviews code against architectural plan and safety constraints       │
│ • Conducts final verification and reports back to user                 │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Execution Workflow: Plan → Delegate → Review

Whenever a non-trivial feature, refactor, or bug fix is requested, follow this three-stage pattern:

### Stage 1: Plan & Architecture (Main Agent)
- Analyze existing code and specifications.
- Determine precise file boundaries and data structures.
- Define acceptance criteria and verification commands (e.g., unit test commands).
- Produce a crisp execution plan before delegating.

### Stage 2: Delegate Drafting (Subagent / Flash)
- Delegate the mechanical code writing and initial verification to a subagent running **Flash (3.8)**:
  - Use `invoke_subagent(TypeName='drafter', Model='flash', Prompt=...)` or `invoke_subagent(TypeName='self', Model='flash', Prompt=...)`.
  - Pass clear instructions: target files, implementation specifications, and the exact test/validation commands to run.
- The subagent:
  - Edits target files.
  - Runs local tests (e.g., `npm test` or `node tests/<test>.js`) repeatedly until green.
  - Fixes intermediate lint and test regressions inside its isolated context.
  - Returns **only** a concise summary of changes, key design choices, and test pass/fail results (no giant raw dumps).

### Stage 3: Verification & Review (Main Agent)
- The Main Agent inspects the resulting file diff.
- Verifies edge cases, algorithmic efficiency, architectural integrity, and security.
- Approves the change or requests targeted adjustments before presenting the final result to the user.

---

## 3. Subagent Autonomy & Permission Optimization

To maximize autonomy and eliminate unnecessary permission confirmation prompts, all agents (Main and Subagents) must strictly follow these rules:

### A. One Command Per Tool Call (Strictly No Chaining)
- **Do NOT chain commands with `;`, `&&`, or `||`:**
  - ❌ *Disallowed:* `node tools/build.js; npm test` or `git log -n 5; ls docs`
  - ✅ *Allowed:* `npm test` as one tool call, and `node tools/build.js` as a separate tool call.
- **Why this matters:** When commands are chained with `;` or `&&`, the permission engine treats the entire line as an unknown command string. The user cannot see what each sub-command does, and automatic permission rules (e.g. `node tests/*`) cannot match compound strings.

### B. Sandbox Safety: Mandatory Scratch Directory (`tests/scratch/`)
- **Strictly No Inline Scripts (`node -e "..."` / `python -c "..."`):**
  - Inline scripts are opaque, cannot be reviewed beforehand, and create security risks (e.g., destructive file operations or unintentional modifications).
  - Agents must NEVER use `node -e` or inline shell script strings.
- **Dedicated Scratch Location (`tests/scratch/`):**
  - All ad-hoc verification, benchmark, or reproduction scripts must be written to `tests/scratch/verify_<feature>.js`.
  - The `tests/scratch/` directory is ignored by `.gitignore` to prevent repository clutter.
  - The workspace pre-approves execution for `node tests/*`, so `node tests/scratch/verify_<feature>.js` runs seamlessly without prompts.
- **Safety Constraints on Test Code:**
  - Scripts placed in `tests/scratch/` must be strictly non-destructive (e.g. read-only emulator runs, unit assertions).
  - Scripts must NEVER perform recursive deletions (`rm -rf`, `Remove-Item -Recurse`, `fs.rmSync`, `shutil.rmtree`), execute system configuration changes, or make outbound network calls.
  - **Do NOT delete the `tests/scratch/` directory itself.** The directory is permanent and tracked via `.gitkeep`. Only delete the individual scratch file created during verification.

### C. Native Tool Discipline (Never Shell Out to Read/Search Files)
- **Always use native tools:** Use `read_file`, `edit_file`, and `write_file`.
- **Do NOT run shell inspect commands:** Never execute `Select-String`, `Get-Content`, `cat`, `grep`, or `dir` through `run_command` just to inspect code. Native tools are faster, do not pollute terminal output, and require zero execution approvals.

### D. Synchronous Wait Timeout
- For test runs (`npm test`, `node tests/...`), always pass `WaitMsBeforeAsync: 10000` to allow the process to finish synchronously, avoiding premature background task switching.

---

## 4. Decision Matrix: Subagents vs. Forking (Branching)

Choose the right mechanism depending on the task objectives:

| Feature | Subagent (`invoke_subagent`) | Forking / Branching Conversation |
| :--- | :--- | :--- |
| **Primary Purpose** | **Division of Labor** within a single objective. | **Exploratory Comparison** between conflicting paths. |
| **Typical Use Case** | Plan $\rightarrow$ Code $\rightarrow$ Test $\rightarrow$ Review pipelines. | Comparing two mutually exclusive designs (e.g. Approach A vs. Approach B). |
| **Context Behavior** | Isolated scratchpad; reports only final summary/diff back to parent. | Both branches stay independently alive for side-by-side evaluation. |
| **Model Strategy** | Parent = Pro (Model 4), Child = Flash (Model 3.8). | Both branches typically run the same primary model. |

---

## 5. Subagent Configuration & Project Conventions

### Agent Configuration (`.gemini/agents/drafter.md`)
```yaml
name: drafter
description: Fast implementation specialist for writing code, drafting modules, and fixing tests.
model: flash
```
*(See `.gemini/agents/drafter.md` for complete prompt rules).*

### Orchestration Rule (`.gemini/rules/workflow.md`)
*(See `.gemini/rules/workflow.md` for multi-stage workflow constraints).*

---

## 6. Development & Testing Commands

- **Run All Tests:** `npm test`
- **Run Specific Test Suite:** `node tests/<test_name>.js`
  - Examples:
    - `node tests/test_jit.js`
    - `node tests/test_decoder.js`
    - `node tests/test_syscalls.js`
    - `node tests/test_neon_fp.js`
- **Directory Structure:**
  - `src/`: Core emulator components, CPU registers, interpreter, JIT compiler, translator.
  - `tests/`: Automated unit and integration test suites.
  - `tools/`: Build scripts and binary generators.
  - `docs/`: Architectural documentation and instruction set references.
