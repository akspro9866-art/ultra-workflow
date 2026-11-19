# 01 — Pre-Production Approval Gate (Process 2B ONLY)

**Scope:** `edit-in-style` / Process 2B ("Edit My Own Footage in Style") ONLY.

- Process 1 (`extract-style`) is **EXEMPT**: `style-probe` → distill → `style-validate` → `style-export` runs autonomously.
- Process 2A (`clone-reference`) is **EXEMPT**: `probe` → `build --proxy` → `verify`/`ralph` → `render --4k` → `export-project` → `guard --stage delivery` runs autonomously.
- Neither exempt process may be paused for a mood board, storyboard or `approve`.

## Process 2B requirements
1. `ultra plan-init --mode edit-in-style` creates `workspace/plan.json` + `PLAN.md`.
2. `ultra preprod-render` must exist: `build/preprod/moodboard.png` and `build/preprod/storyboard*.png`.
3. Show both images to the user and WAIT for explicit approval. Self-approval is forbidden.
4. `ultra approve --by user` stores SHA-256(plan.json + ultra.json if present).
5. `ultra build` / `ultra render` fail when the plan, moodboard/storyboard or matching unrevoked approval is missing/stale.
6. `ultra guard --stage delivery` requires verified approval **only** for `edit-in-style`.
7. `--skip-approval` is test-only; never use it in a user-facing 2B delivery. `--require-approval` can force the gate for any mode.
