# 04 — 4K and editable delivery

- Iterate with `ultra build --proxy` (max 1280px) and verify the proxy. Draft speed never changes the delivery target.
- Master with `ultra render --4k`; output must be exact 3840x2160 / 2160x3840 / 2160x2160, CFR yuv420p H.264 High@L5.1, AAC 48 kHz stereo 320k, -14 LUFS, +faststart.
- `hybrid` is the default 4K strategy: high-quality lanczos + accurate rounding + full chroma + subtle unsharp; `native` requires a 4K build. The strategy is logged in `build/delivery-manifest.json`.
- `ultra export-project` must produce FCPXML 1.10, OTIO JSON, project.ultra.json, DESIGN.md/Motion.md/PLAN.md, assets/scenes/fonts/motifs/grade, captions and a zero-CDN index.html — all with relative paths and CRC-verified zip.
- `ultra guard --stage delivery` must pass before any delivery claim.
