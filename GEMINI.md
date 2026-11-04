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
  - Runs local tests (e.g., `npm test` or test scripts) repeatedly until green.
  - Fixes intermediate lint and test regressions inside its isolated context.
  - Returns **only** a concise summary of changes, key design choices, and test pass/fail results (no giant raw dumps).

### Stage 3: Verification & Review (Main Agent)
- The Main Agent inspects the resulting file diff.
- Verifies edge cases, algorithmic efficiency, architectural integrity, and security.
- Approves the change or requests targeted adjustments before presenting the final result to the user.

---

## 3. Decision Matrix: Subagents vs. Forking (Branching)

Choose the right mechanism depending on the task objectives:

| Feature | Subagent (`invoke_subagent`) | Forking / Branching Conversation |
| :--- | :--- | :--- |
| **Primary Purpose** | **Division of Labor** within a single objective. | **Exploratory Comparison** between conflicting paths. |
| **Typical Use Case** | Plan $\rightarrow$ Code $\rightarrow$ Test $\rightarrow$ Review pipelines. | Comparing two mutually exclusive designs (e.g. Approach A vs. Approach B). |
| **Context Behavior** | Isolated scratchpad; reports only final summary/diff back to parent. | Both branches stay independently alive for side-by-side evaluation. |
| **Model Strategy** | Parent = Pro (Model 4), Child = Flash (Model 3.8). | Both branches typically run the same primary model. |

---

## 4. Subagent Configuration & Project Conventions

### Recommended Agent Configuration (`.gemini/agents/drafter.md`)
To define the subagent for Antigravity, configure:
```yaml
name: drafter
description: Fast implementation specialist for writing code, drafting modules, and fixing tests.
model: flash
```
```markdown
You are a fast, precise implementation agent. Your job is to implement code based on the exact specifications and architecture plan provided by the lead architect.

Guidelines:
1. Write clean, idiomatic code adhering to project conventions.
2. Run project tests and linters to verify your implementation before reporting back.
3. Once completed, provide a concise summary of the files modified, key implementation decisions, and verification test results. Do not dump raw file contents into your final message.
```

### Orchestration Rule (`.gemini/rules/workflow.md`)
```markdown
# Development Workflow: Plan -> Delegate -> Review

1. Architecture & Planning (Main Agent):
   - For any non-trivial feature or refactor, first draft an architecture plan or spec.
2. Implementation Delegation:
   - Delegate mechanical drafting and coding to the drafter subagent (or self with Model: 'flash').
   - Provide the subagent with target files, acceptance criteria, and test commands.
3. Verification & Review (Main Agent):
   - Once the subagent finishes, review the git diff against the architectural requirements.
   - Run a final review for security, edge cases, and performance before presenting to the user.
```

---

## 5. Development & Testing Commands

- **Run Tests:** `npm test`
- **Lint / Typecheck:** `npm run lint` / `npm run check` (where applicable)
- **Directory Structure:**
  - `src/`: Core emulator components, CPU registers, interpreter, recompiler, translator.
  - `tests/`: Automated unit and integration test suites.
  - `docs/`: Architectural documentation and instruction set references.
