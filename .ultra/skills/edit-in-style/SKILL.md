# Edit In Style Skill — Process 2B (gated Stage 1)

1. `ultra status --json`; `ultra style-list`; `ultra raw-probe my_video.mp4 --style <slug> --aspect <aspect>`.
2. `ultra captions-align` from SRT/VTT/word JSON or script + envelope.
3. **Stage 1 (mandatory):** `ultra plan-init --mode edit-in-style --style <slug>` -> storyboard sourceClip trims, punch-ins, captions, overlays -> `ultra preprod-render` -> show `moodboard.png` + `storyboard.png` -> WAIT for explicit user approval -> `ultra approve --by user`.
4. **Stage 2:** `ultra build --proxy` -> `ultra verify --style <slug>` or `ultra ralph auto-fix` until `stutterEvents === 0`, style compliance and match >= 90.
5. **Stage 3:** `ultra render --4k` -> `ultra export-project` -> `ultra guard --stage delivery`.
Build/render are hard-blocked until Stage 1 is approved with a matching hash.
