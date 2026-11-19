# Clone Reference Skill — Process 2A (autonomous, NO approval pause)

No `plan.json`, moodboard, storyboard, `approve` or approval wait belongs in this process.

1. `ultra probe reference.mp4` — measure cuts, ASL, palettes, audio envelope.
2. Author `DESIGN.md`, Motion.md and `ultra.json` replicating the reference; `ultra validate-spec`.
3. `ultra asset-plan` -> native assets / `ultra synth-audio` -> `ultra validate-assets`.
4. `ultra build --proxy` -> `ultra verify reference.mp4`; patch or `ultra ralph auto-fix` until `stutterEvents === 0` and lint passes.
5. `ultra render --4k` -> exact 4K master + `delivery-manifest.json`.
6. `ultra export-project` -> `ultra guard --stage delivery` -> deliver MP4 + editable project.
