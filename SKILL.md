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

## Platforms & render tiers (Gemini · Meta Muse · ChatGPT)

Ultra is zero-install on all three. ChatGPT can load it either way:
`curl -L -o ultra-workflow-cloud.zip https://raw.githubusercontent.com/akspro9866-art/ultra-workflow/main/dist/ultra-workflow-cloud.zip`
(or upload the zip), then `unzip -q ultra-workflow-cloud.zip -d ultra && node ultra/ultra.mjs doctor --json --host chatgpt`.

`doctor` reports `renderTier`:
- **full-cdp** — Chromium available: the full HyperFrames/Three.js/CDP pipeline
  runs unchanged (also Gemini/Muse VMs with a browser, or a local PC).
- **browserless-py** — no browser (or `ULTRA_NO_BROWSER=1`) with Python 3 +
  Pillow + FFmpeg (standard ChatGPT Linux container): `engines/py-canvas`
  deterministically renders hyperframes/revideo/blender scenes with Pillow
  (easing, word/line reveals, captions, sourceClip trims, chart/counter vectors,
  image Ken Burns + seeded grain + motion blur, 3D wireframe) and pipes raw
  frames to FFmpeg; Rule 5 lint + audit pairs run without Chromium.
- **ffmpeg-only** — neither browser nor Pillow, or `ULTRA_FORCE_TIER=ffmpeg-only`:
  dedicated pure-FFmpeg engine (`engines/ffmpeg-only`) with bundled-TTF drawtext,
  drawbox, zoompan punch-ins, sourceClip trims, noise grain and color grade; emits
  valid CFR yuv420p (or ProRes alpha). Never crash, always render.

In ChatGPT containers use native Image Generation for stills/B-roll keyframes
(`asset-plan --host chatgpt` flags `native-image-plus-2.5d-rig`) and the built-in
synthesizer for sound:
`$ULTRA synth-audio --preset whoosh|pop|sub-hit|riser|swoosh-reverse|chime|ui-click|glitch-zap|shutter|whoosh-fast --out …`
and music beds `beat-pulse|ambient-tech|minimal-tension` with `--bpm --mood`
(or `--from-assets` to fill every pending sfx/music asset in assets-todo.json).
Ready-to-paste ChatGPT prompts live in `prompts/CHATGPT_PROCESS1_EXTRACT_STYLE.txt`,
`prompts/CHATGPT_PROCESS2A_CLONE_REFERENCE.txt`,
`prompts/CHATGPT_PROCESS2B_EDIT_MY_VIDEO_IN_STYLE.txt`.

## v5 studio additions (always use when available)

- **`$ULTRA status --json`** — call it at the start of every turn in a long chat.
  It reports the detected process (`extract-style|clone-reference|edit-in-style|
  uninitialized`), completed stages, pending-asset count, draft/verify state and
  the exact `nextCommand`. Never guess where you are; run status.
- **`$ULTRA captions-align`** — word-level captions from `.srt` / `.vtt` /
  word-JSON, or deterministic forced alignment from a plain script:
  `$ULTRA captions-align --script script.txt --envelope workspace/raw-probe/audio-envelope.json --style <slug> --aspect 9:16 --out workspace/captions.json`.
  `sourceClip` scenes ingest `workspace/captions.json` automatically for active-word
  pill/underline/color captions.
- **`--aspect 9:16|16:9|1:1`** — pass to `raw-probe` and `captions-align` and set
  `meta.aspectProfile` in `ultra.json`. 9:16 reserves top 12%, bottom 22%, right
  15%, left 5%; 16:9 a 6% perimeter; 1:1 8%. The linter fails captions/text that
  enter those platform danger zones.
- **Built-in Style Packs** — `punchy-shortform` (9:16), `kinetic-editorial` (16:9),
  `dark-tech-launch` (16:9) ship in `styles/` with style.json, STYLE.md, 2 motifs
  and 3 rendered exemplars. Use them immediately with `--style <slug>` and as
  gold-standard references for Process 1.
- **Bundled fonts** — `assets/fonts/UltraDisplay-Bold.ttf`, `UltraSans-Regular/
  Bold.ttf`, `UltraMono-Regular.ttf` are offline OFL faces registered in every
  renderer. Design tokens may name `Ultra Display` / `Ultra Sans` / `Ultra Mono`.
- **Linux CI** — GitHub Actions runs every tier on `ubuntu-latest`; badge:
  `https://github.com/akspro9866-art/ultra-workflow/actions/workflows/ci.yml/badge.svg`.

## Process router — recognise the user's intent FIRST

| User says | Process | Prompt + flow |
|---|---|---|
| 1–10 reference videos · “extract the style” · “make a style pack” | **1 · EXTRACT STYLE** | `prompts/PROCESS1_EXTRACT_STYLE.txt` · `style-probe` → write pack → `style-validate` (exit 0) → `style-export` → deliver `<slug>-style-pack.zip` |
| one reference video · “clone this video” | **2A · CLONE REFERENCE** | `prompts/PROCESS2A_CLONE_REFERENCE.txt` · rules 1–6 below |
| “my video in this style” · installed `--style <slug>` | **2B · EDIT MY VIDEO IN STYLE** | `prompts/PROCESS2B_EDIT_MY_VIDEO_IN_STYLE.txt` · `raw-probe` → `sourceClip` scenes → `verify --style` |

Style Packs live in `styles/<slug>/` with `styles/registry.json`; users import
downloaded packs in Qoder via `prompts/QODER_IMPORT_STYLE_TO_REPO.txt`
(`style-import <zip> --repack`). Every future chat can then use `--style <slug>`.

**Never skip** `style-validate` / `style-export` (Process 1) or Rule 5 `verify`
(2A/2B). A Style Pack is invalid until `style-validate` exits 0.

## Process 1 · EXTRACT STYLE (1–10 videos → downloadable pack)

1. `$ULTRA style-probe <ref1..refN> --out workspace/style-probe --hook-window <sec>`.
2. Inspect `aggregate.json` (Hook/Body/Outro ASL min/median/max, longest static
   hold, silence distribution, beat-snap ratio, palette clusters, luminance/
   contrast/saturation), `batch-overview.png`, every contact sheet and
   `candidates/*.png` natively. Map-Reduce across all 8 groups.
3. Author the pack: `style.json` exactly matching `core/style-schema.ts`,
   `STYLE.md` ≥300 chars citing measurements, 2–8 `exemplars/`, deterministic
   offline `motifs/*.html` using `__ULTRA_SEEK` (no CDN `<script src=http…>`),
   optional `grade.cube` referenced via `colorAndTexture.lutFile`, optional `assets/`.
4. `$ULTRA style-validate <dir>` until exit 0 → `$ULTRA style-export <dir> --out build/<slug>-style-pack.zip`
   → deliver the single zip with a summary table. Do not deliver an unvalidated pack.

## Process 2B · EDIT MY VIDEO IN STYLE

1. `$ULTRA status --json` → `$ULTRA style-list` → choose `--style <slug>`
   (built-ins: `punchy-shortform`, `kinetic-editorial`, `dark-tech-launch`).
2. `$ULTRA raw-probe my_video.mp4 --style <slug> --aspect 9:16 --out workspace/raw-probe` →
   inspect `raw-edit-plan.json` (silence/dead-air intervals, keepSegments,
   hookEnd, targetBodyAslSec, maxStaticHoldSec, punchInPoints, brollCutaways,
   captionWindows, chapter resets).
3. Captions: if an SRT/VTT exists run `$ULTRA captions-align --srt file.srt --style <slug> --aspect 9:16 --out workspace/captions.json`;
   otherwise `$ULTRA captions-align --script script.txt --envelope workspace/raw-probe/audio-envelope.json --style <slug> --aspect 9:16`.
   Author `ultra.json` from the plan: `sourceClip: {path, inSec, outSec,
   jCutLeadSec, lCutTrailSec, scale, panX, panY, cropMode, muteSourceAudio}`
   scenes render trimmed footage with camera punch-ins, the active-word caption
   track, motif/Revideo/3D overlays, the style's colorGrade + grain; set
   `meta.aspectProfile`; only transitions allowed by `style.transitions`
   (never `bannedTypes`).
4. `$ULTRA validate-spec` → `asset-plan`/`validate-assets` (if overlays/music) →
   `$ULTRA build`.
5. `$ULTRA verify --style <slug>`: quantitative gate (CFR, `stutterEvents === 0`,
   no black frames, LUFS within ±1.5 of style target) + style compliance (ASL
   ranges, maxStaticHoldSec, banned transitions, palette distance) +
   `build/audit-frames/style-match.png`. Inspect it natively (STYLE EXEMPLAR vs
   YOUR EDIT), grade Style Match 0–100; patch weak scenes (≤3 rounds) until ≥90.
6. `$ULTRA render` → deliver MP4 + compliance block + match score + patch history.

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

## 4 · VERIFY (Rule 5 — 2A reference clone)

```bash
$ULTRA verify <reference.mp4>
```
(Process 2B instead runs `$ULTRA verify --style <slug>` — see its section above.)
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
