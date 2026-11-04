# Development Workflow: Plan -> Delegate -> Review

## 1. Architecture & Planning (Main Agent):
- For any non-trivial feature or refactor, first draft an architecture plan or spec.
- Identify the target files, dependencies, edge cases, and verification strategy.
- When specifying verification tasks for subagents, designate explicit test commands: `npm test` or `node tests/<suite>.js`.

## 2. Implementation Delegation:
- Always delegate mechanical drafting/coding to the `drafter` subagent (or `self` with `Model: 'flash'`).
- Enforce the following safety constraints during delegation:
  1. **No Inline Scripts:** Do not run `node -e "..."` or inline shell code.
  2. **Scratch Test Directory:** Put all temporary validation code inside `tests/scratch/` (e.g. `tests/scratch/verify_issue.js`), execute via `node tests/scratch/...`, and delete when finished.
  3. **Strictly Non-Destructive:** Test scripts must only verify emulator state and never execute deletions or external commands.
  4. **Single Atomic Commands:** Execute one command per tool call (no `;` or `&&`).
  5. **Native File Tools:** Use `read_file` instead of shell searches.

## 3. Verification & Review (Main Agent):
- Once the subagent finishes, review the git diff against the architectural requirements.
- Run a final review check for security, edge cases, and performance before presenting to the user.
