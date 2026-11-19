# Edit In Style Skill

1. `ultra status --json`; `ultra style-list`; choose `--style <slug>`.
2. `ultra raw-probe my_video.mp4 --style <slug> --aspect <aspect>`.
3. `ultra captions-align` from SRT/VTT/word JSON or script + envelope.
4. `ultra plan-init --mode edit-in-style --style <slug>`; storyboard the sourceClip trims, punch-ins, captions and overlays. Show preprod PNGs; wait; approve.
5. `ultra build --proxy` -> `ultra verify --style <slug>` or `ultra ralph auto-fix` until style compliance passes (>=90 match).
6. `ultra render --4k` -> `ultra export-project` -> `ultra guard --stage delivery`.
