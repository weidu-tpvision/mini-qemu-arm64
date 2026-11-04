# Development Workflow: Plan -> Delegate -> Review

## 1. Architecture & Planning (Main Agent):
- For any non-trivial feature or refactor, first draft an architecture plan or spec.
- Identify the target files, dependencies, edge cases, and verification strategy.

## 2. Implementation Delegation:
- Always delegate the mechanical drafting/coding to the `drafter` subagent (or `self` with `Model: 'flash'`).
- Provide the subagent with the specific files to edit, acceptance criteria, and exact test commands.

## 3. Verification & Review (Main Agent):
- Once the subagent finishes, review the git diff against the architectural requirements.
- Run a final review check for security, edge cases, and performance before presenting to the user.
