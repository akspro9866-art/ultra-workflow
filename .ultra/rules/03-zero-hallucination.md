# 03 — Zero hallucination

- Never mention a file, asset, font, style or artifact that is not on disk. `ultra guard` is the arbiter.
- Never write placeholder copy into scenes or captions (Lorem ipsum, TBD, INSERT TEXT, [YOUR ...]).
- Verify claims with `ffprobe`, `build/verify-report.json`, `build/delivery-manifest.json` and CI logs.
- If a gate fails, report the failing check and next command; do not claim success.
- Long chats: run `ultra status --json` and `ultra context-pack --stage <stage>` before acting.
