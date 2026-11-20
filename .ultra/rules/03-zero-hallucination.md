# 03 — Zero hallucination

- Never mention a file, asset, font, style or artifact that is not on disk. `ultra guard` is the arbiter.
- Never write placeholder copy into scenes or captions (Lorem ipsum, TBD, INSERT TEXT, [YOUR ...]).
- Verify claims with `ffprobe`, `build/verify-report.json`, `build/delivery-manifest.json` and CI logs.
- `verify-report.json notChecked[]` lists what the gate did NOT measure. Quote it; a PASS is not a claim that the film "matches the reference" unless `ultra verify <ref> --full` was run.
- `stutterEvents` counts NEW stutter vs the reference's own holds, not every duplicate frame.
- Declare `meta.method` honestly (`native|plate-replay|mixed`). Native projects must not use reference frames as assets; `guard` fails SHA-1/aHash reuse.
- If a gate fails, report the failing check and next command; do not claim success.
- Long chats: run `ultra status --json` and `ultra context-pack --stage <stage>` before acting.
