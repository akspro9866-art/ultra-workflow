# SKILL.md — Ultra Workflow autonomous playbook (Gemini / Meta Muse, zero-install)

You are the multimodal brain. Ultra is the deterministic engine. The attached
`ultra-workflow-cloud.zip` is **100% self-contained**: no `npm install`, no
internet, no CDN, no API keys. Work through the rules below **in order**.

## 0 · Boot (once per chat, zero install)

Primary — clone the GitHub repo (the prebuilt bundle is tracked):

```bash
git clone https://github.com/akspro9866-art/ultra-workflow ultra-workflow
node ultra-workflow/dist/ultra.mjs doctor --json
```

Fallback — no GitHub access: attach `ultra-workflow-cloud.zip` instead:

```bash
unzip -q ultra-workflow-cloud.zip -d ultra
node ultra/ultra.mjs doctor --json
```

No `npm install`, no internet needed in either mode. `browser` must be available
(system chromium/chrome/edge or a Playwright/Puppeteer cache is auto-discovered;
`ULTRA_BROWSER_PATH` overrides). `remotion.installed` / `revideo.installed` will
be false in a fresh VM — expected: vector scenes use the built-in choreography
runtime and every engine falls back to HyperFrames. Then:
`ULTRA="node ultra-workflow/dist/ultra.mjs"` (or `node ultra/ultra.mjs` from the zip).

## 1 · ANALYZE (Rule 1 — measure, never guess)

```bash
$ULTRA probe <reference.mp4>
```
Inspect natively: `workspace/probe.json` (exact fps/resolution/duration, cuts,
onsets, **per-scene dominant palettes + luminance/contrast**, frame RMS
`workspace/audio-envelope.json` with beat peaks) and every
`workspace/contact-sheet-*.png` (timestamp + cut number + palette swatches per
tile). Use those measured hexes — do not eyeball colors.

Write:
- `workspace/DESIGN.md` — exact palette hexes from probe, typography, texture, LUT.
- `workspace/Motion.md` — shot table aligned to cut/beat timestamps.
- `workspace/ultra.json` — contiguous scenes tiling `[0, durationSec]`.

```bash
$ULTRA validate-spec
```

## 2 · ASSETS (Rule 2)

```bash
$ULTRA asset-plan    # then generate every listed asset natively → targetPath
$ULTRA validate-assets
```

## 3 · SCENE AUTHORING — primitives first, bespoke escape hatch when needed

**Use `ultra.json` primitives** for structured motion: keyframes + easing,
`textElements[].reveal` (per-char/per-word/per-line kinetic reveals with masks),
`camera` 2.5D rig (rotateX/Y/Z, zoom, pan keyframes), `clipReveal`
(wipe/iris/diagonal), SVG layers with `svgDraw: true` (stroke-dashoffset path
drawing), `glass` shapes, effects (grain/halftone/vignette/chromatic/glow/blur),
and `motionBlurSamples: 1..4` for fast moves.

**Custom scene escape hatch** — for exotic reference shots, hand-author
`workspace/scenes/<name>.html` (full document or fragment) and reference it with
`"customHtmlFile": "<name>.html"` (or inline `customCode: { html, css, js }`).
Your page may use raw HTML/CSS/SVG/Canvas/Three.js. Ultra injects:
- `window.__ULTRA_SEEK(frame, fps)` — deterministic virtual clock (Ultra calls it).
- `window.ultraRender(frame, fps, timeSec, progress, audio)` — implement this to
  animate; `audio` is `{ fps, durationSec, frames[0..1], beatsSec }`.
- `window.UltraEase` — offline easing/spring curves.
- `window.__ULTRA_AUDIO` — the same envelope object.
The DOM/contrast/clipping/blank linter runs on your custom scene too; add
`data-audit="text"` attributes to text you want palette/contrast-checked.

**Revideo-style vector choreography** (cloud-native, no install): use
`"engine": "revideo"` with `enginePayload.sceneType` ∈
`vectors|diagram|sequence|chart|counter|code` (+ `title`, `values`, `labels`,
`lines`, `target`, `suffix`). It renders deterministically in Chromium.

```bash
$ULTRA build
```
Frame-stepped (zero rAF drift), SHA-1 cached; fallbacks recorded in
`build/build-manifest.json`. Draft → `build/draft.mp4`.

## 4 · VERIFY (Rule 5)

```bash
$ULTRA verify <reference.mp4>
```
Inspect `build/verify-report.json` and EVERY `build/audit-frames/pair_XX.png`
(Left ORIGINAL / Right DRAFT). The report now includes:
- `quantitative.stutterEvents` (**strict gate: must be 0**), `staticHoldFrames`
  (informational — designed holds are fine), black/loudness/CFR flags;
- `sceneSimilarity[]` — SSIM per matched frame pair (spot color/alignment drift);
- `lint` — clip/overlap/contrast/brokenMedia/blankFrame/palette defects.

Score the 100-point rubric (Timing / Typography-Layout / Color-Texture /
Motion-Transitions / Zero Slop-Jitter, 20 each). Any critical defect or score
< 90 means FAIL.

## 5 · PATCH LOOP (≤ 3 rounds)

`workspace/patch.json` → `{ "patches": [{ "sceneId", "reason", "changes": {…} }] }`

```bash
$ULTRA patch workspace/patch.json
$ULTRA build && $ULTRA verify <reference.mp4>
```
Repeat until pass and score ≥ 90. If 3 rounds are insufficient, report exactly
what still fails — never hide defects.

## 6 · FINAL RENDER (Rule 6)

```bash
$ULTRA render   # gated on a passing verify-report.json
```
Deliver `build/ultra-final.mp4` + the rubric scores + the engine table + patch
history.

## Anti-slop checklist (hard requirements)

- [ ] Every visible color comes from the reference palette (probe hexes / DESIGN).
- [ ] No default Arial/Times fallbacks standing in for the reference typeface voice.
- [ ] No generic neon-purple AI gradients, floating orbs, or filler iconography.
- [ ] Motion uses real easing curves keyed to probe cuts/beats — no linear robot moves.
- [ ] `stutterEvents === 0` and lint critical defects = 0 in verify-report.json.
- [ ] Rubric score ≥ 90 with honest per-pair inspection before `ultra render`.
- [ ] Zero external AI SDKs, zero API keys, zero network required.
