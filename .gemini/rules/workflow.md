# Development Workflow: Plan -> Delegate -> Review

## 1. Architecture & Planning (Main Agent)
- For any non-trivial feature or refactor, first draft an architecture plan or spec.
- Identify the target files, dependencies, edge cases, and verification strategy.
- When specifying verification tasks for subagents, designate explicit test commands: `npm test`, `node tests/<suite>.js`, or `node tests/scratch/verify_<feature>.js` with `WaitMsBeforeAsync: 10000`.

## 2. Implementation Delegation
- **Model-Aware Gate (check first, see GEMINI.md §1.1):**
  - Main agent on Gemini Pro (Model 4), Claude Opus, or any model stronger than Flash → **Delegate mode** (below).
  - Main agent on Gemini Flash (Model 3.8) or lighter, or model unknown → **Solo mode**: do NOT spawn subagents; implement, test, and self-review directly. All constraints below still apply to your own actions.
- In Delegate mode, delegate mechanical drafting/coding to a Flash subagent:
  - Either invoke the built-in `self` subagent with `Model: 'flash'` (`invoke_subagent(TypeName='self', Model='flash', ...)`), OR
  - First register `drafter` via `define_subagent` (using `.gemini/agents/drafter.md`) and then call `invoke_subagent(TypeName='drafter', Model='flash', ...)`.
- Enforce the following safety and autonomy constraints during delegation:
  1. **No Inline Scripts:** Never run `node -e "..."`, `python -c "..."`, or inline shell code.
  2. **Scratch Test Directory (`tests/scratch/`):** Write temporary validation scripts inside `tests/scratch/` following the naming convention `tests/scratch/verify_<feature>.js` and execute `node tests/scratch/verify_<feature>.js`. Never run `Remove-Item`/`rm` in the shell to clean up scratch scripts (`tests/scratch/*` is git-ignored).
  3. **Strictly Non-Destructive:** Test scripts must only verify emulator state and never execute deletions (`fs.rmSync`, `rm -rf`, `Remove-Item`), spawn arbitrary shells, or make outbound network requests.
  4. **Single Atomic Commands & No Shell Metacharacters:** Execute one command per tool call (no `;`, `&&`, or `||`). Commands containing shell metacharacters (`|`, `&`, `<`, `>`, `` ` ``, `$`, `(`, `)`, `{`, `}`, `%`, `^`, `"`, `'`, newlines) require explicit confirmation and cannot be auto-approved.
  5. **Native File Tools & Directory Listing:** Use native `read_file`, `edit_file`, and `write_file` tools instead of shell inspectors (`cat`, `Get-Content`, `grep`, `Select-String`). Use `git ls-files <dir>` for directory listings.
  6. **Node 24 Permission Sandbox Rewrite:** All auto-allowed test executions, builders, and scratch runs are automatically rewritten by the safety hook to run with Node's permission model (`--permission --allow-fs-read=... --allow-fs-write=...`), isolating disk access to safe target directories.
  7. **File Write Guardrails:** Tool calls modifying protected repository infrastructure (`.agents/**`, `.gemini/**`, `.git/**`, `GEMINI.md`, `AGENTS.md`, `package.json`, `.gitignore`, `tools/run_tests.js`, `tools/safety_hook.js`) trigger a `force_ask` confirmation prompt.

## 3. Verification & Review (Main Agent)
- Once the subagent finishes (or, in Solo mode, once you finish implementing), review the git diff against the architectural requirements.
- Run a final review check for security, edge cases, and performance before presenting to the user.
