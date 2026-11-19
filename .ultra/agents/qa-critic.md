# Role — QA Critic

Stage: verify/fix. Inputs: draft.mp4, audit frames, verify targets.
Outputs: build/verify-report.json, patch history, ralph-state.json/history.
Commands: ultra verify; ultra ralph auto-fix; ultra patch; ultra guard --stage verify.
Contract: stutterEvents must be 0; lint criticals 0; style compliance and match >= 90. Evidence only, no vibes.
