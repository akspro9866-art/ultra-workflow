# 01 — Pre-Production Approval Gate

- Every edit/build must begin with `workspace/plan.json` (strict schema) and `PLAN.md`.
- `ultra preprod-render` must emit a real moodboard.png and storyboard*.png using bundled fonts on every render tier.
- Show both images to the user and wait for explicit approval. Self-approval is forbidden.
- `ultra approve --by user` writes `approval.json` containing SHA-256(plan.json + ultra.json if present).
- `ultra build` and `ultra render` fail when approval is missing, revoked, or the hash changed.
- `--skip-approval` exists only for automated unit tests; never use it in a user-facing delivery.
