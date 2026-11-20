# Clone Reference Skill — Process 2A (autonomous, NO approval pause)

No `plan.json`, moodboard, storyboard, `approve` or approval wait belongs in this process.

1. `ultra probe reference.mp4 --geometry` — hard + soft cuts, geometry, palettes, audio envelope, `cloneFeasibility`. If it says the reference cannot support exact cloning, tell the user before building.
2. Author `DESIGN.md`, Motion.md and `ultra.json` replicating the reference (declare `meta.method: "native"`); `ultra validate-spec`.
3. `ultra asset-plan` -> native assets / `ultra synth-audio` -> `ultra validate-assets` (read the asset-similarity warnings BEFORE building).
4. Iterate fast: `ultra preview --frame <N>` and `patch -> build --scene <id> -> verify --scene <id> <ref>`; then `ultra build --proxy` -> `ultra verify reference.mp4`; patch or `ultra ralph auto-fix` until NEW `stutterEvents === 0` and lint passes. Run `ultra verify reference.mp4 --full` before claiming a match; quote `notChecked[]`.
5. `ultra render --4k` -> exact 4K master + `delivery-manifest.json`.
6. `ultra export-project` -> `ultra guard --stage delivery` -> deliver MP4 + editable project.
