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

### 1.1 Model-Aware Delegation Gate (check FIRST)

Delegation only pays off when the main agent runs on a **stronger** model than the subagent. Before Stage 2, check which model you (the main agent) are running as:

| Main agent model | Mode | Behavior |
| :--- | :--- | :--- |
| Gemini Pro (Model 4), Claude Opus, or any model stronger than Flash | **Delegate mode** | Follow Plan → Delegate (Flash subagent) → Review. |
| Gemini Flash (Model 3.8) or lighter | **Solo mode** | **Do NOT spawn subagents** (`self`/`drafter`/Flash). Plan, implement, test, and self-review directly in your own context. |
| Unknown / cannot determine | **Solo mode** | Same as above. |

- **Why:** a Flash subagent spawned by a Flash main agent adds coordination overhead and context hand-off loss with zero model-quality gain. The user switches the main agent to Flash 3.8 when Pro/Opus quota is exhausted.
- **Solo mode still applies every other rule** in this file: plan before coding, all safety/autonomy rules in §3, and a final self-review of the diff (Stage 3) before reporting.
- To keep context lean in Solo mode, read only the files you need and use targeted test runs (`node tests/<suite>.js`) before the full `npm test`.

---

## 2. Core Execution Workflow: Plan → Delegate → Review

> Stage 2 applies only in **Delegate mode** (see §1.1). In **Solo mode**, the main agent performs Stage 2 itself.

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
- **Dedicated Scratch Location (`tests/scratch/*.js`):**
  - Write all ad-hoc verification, benchmark, or reproduction scripts to `tests/scratch/<name>.js` (e.g., `tests/scratch/verify_<feature>.js`) using `write_file` (`Overwrite: true`), and execute `node tests/scratch/<name>.js`.
  - **Zero Shell Deletions (`Remove-Item` / `rm`):** Because `tests/scratch/*` is ignored by `.gitignore`, **do NOT run `Remove-Item` or `rm` via `run_command`** to delete scratch scripts (which would trigger an unnecessary shell deletion prompt). Leave or overwrite files in `tests/scratch/`.
- **Safety Constraints on Test Code:**
  - Scripts placed in `tests/scratch/` must be strictly non-destructive (e.g. read-only emulator runs, unit assertions).
  - Scripts must NEVER perform deletions (`rm -rf`, `Remove-Item`, `fs.rmSync`, `shutil.rmtree`), execute system configuration changes, or make outbound network calls.
  - **Do NOT delete the `tests/scratch/` directory or `tests/scratch/.gitkeep`.**

### C. Native Tool Discipline (Never Shell Out to Read/Search Files)
- **Always use native tools:** Use `read_file`, `edit_file`, and `write_file`.
- **Do NOT run shell inspect commands:** Never execute `Select-String`, `Get-Content`, `cat`, `grep`, or `dir` through `run_command` just to inspect code. Use the native `read_file` tool for file contents, and `git ls-files <dir>` for directory listing.

### D. Synchronous Wait Timeout
- For test runs (`npm test`, `node tests/...`), always pass `WaitMsBeforeAsync: 10000` to allow the process to finish synchronously, avoiding premature background task switching.

### E. Programmatic Enforcement Hook (`.agents/hooks.json` & `.agents/safety_hook.js`)
- `PreToolUse` lifecycle hooks on `run_command` and `write_file`/`edit_file` automatically enforce the rules before execution:
  - **Hard-Blocks (`deny`):** Command chaining (`;`, `&&`, `||`), inline evaluation (`node -e`, `node -pe`, `node --eval=`, `python -c`, `powershell -c`, `bash -c`, `cmd /c`, `iex`), shell deletion commands (`rm`, `Remove-Item`, `del`), shell file inspection (`cat`, `grep`, `Get-Content`, `Select-String` — use `read_file` or `git ls-files <dir>`), and any `tests/scratch/*.js` script containing `child_process`, `worker_threads`, network modules, `fetch`, `WebSocket`, `process.binding`, non-relative dynamic `import`, or fs deletion APIs.
  - **Shell Metacharacter Guard:** Any command containing shell metacharacters (`|`, `&`, `<`, `>`, `` ` ``, `$`, `(`, `)`, `{`, `}`, `%`, `^`, `"`, `'`, or newlines) cannot be auto-approved and falls through to `ask`.
  - **Sandbox Rewrite (`allow` + Node Permission Model):** Auto-approved test suites (`npm test`, `npm run test`, `node tools/run_tests.js`), ELF builders, emulator runs, and clean scratch scripts (`node tests/scratch/verify_<feature>.js`) are automatically rewritten to execute under Node 24's permission model (`--permission --allow-fs-read=<REPO_ROOT> --allow-fs-write=...`) with exact per-command `permissionOverrides` and normalized `WaitMsBeforeAsync: 10000`.
  - **File-Write Guardrail (`force_ask`):** Modifications to protected repository infrastructure (`.agents/**`, `.gemini/**`, `.git/**`, `GEMINI.md`, `AGENTS.md`, `package.json`, `.gitignore`, `tools/run_tests.js`, `tools/safety_hook.js`) require explicit user confirmation.

---

## 4. Decision Matrix: Subagents vs. Forking (Branching)

Choose the right mechanism depending on the task objectives:

| Feature | Subagent (`invoke_subagent`) | Forking / Branching Conversation |
| :--- | :--- | :--- |
| **Primary Purpose** | **Division of Labor** within a single objective. | **Exploratory Comparison** between conflicting paths. |
| **Typical Use Case** | Plan $\rightarrow$ Code $\rightarrow$ Test $\rightarrow$ Review pipelines. | Comparing two mutually exclusive designs (e.g. Approach A vs. Approach B). |
| **Context Behavior** | Isolated scratchpad; reports only final summary/diff back to parent. | Both branches stay independently alive for side-by-side evaluation. |
| **Model Strategy** | Parent = Pro (Model 4) or Opus, Child = Flash (Model 3.8). Never spawn when the parent is already Flash (§1.1). | Both branches typically run the same primary model. |

---

## 5. Subagent Configuration & Project Conventions

### Agent Configuration (`.gemini/agents/drafter.md`)
```yaml
name: drafter
description: Fast implementation specialist for writing code, drafting modules, and fixing tests.
model: flash
```
*(See `.gemini/agents/drafter.md` for complete prompt rules. Invoke `self` with `Model: 'flash'` directly or register `drafter` via `define_subagent` before calling `invoke_subagent`).*

### Orchestration Rule & Hooks (`.agents/rules/workflow.md`, `.agents/hooks.json`)
*(See `.agents/rules/workflow.md` and `.gemini/rules/workflow.md` for multi-stage workflow constraints, and `.agents/hooks.json` for the `PreToolUse` safety and autonomy gate).*

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
