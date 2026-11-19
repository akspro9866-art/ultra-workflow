# Ultra Workflow

Zero-API, **zero-install** deterministic video compiler for agent chat sandboxes.
The chat agent is the multimodal brain; Ultra is the engine — no AI SDKs, no API
keys, no internet required inside Gemini/Muse VMs.

```
probe → DESIGN/Motion/ultra.json → validate-spec → asset-plan → (generate assets)
      → validate-assets → build → verify ⇄ patch (≤3) → render → deliver MP4
```

## Cloud quick start (Gemini / Meta Muse — no npm install)

Primary — clone the GitHub repo (prebuilt `dist/ultra.mjs` is tracked):

```bash
git clone https://github.com/akspro9866-art/ultra-workflow ultra-workflow
node ultra-workflow/dist/ultra.mjs doctor --json
node ultra-workflow/dist/ultra.mjs probe reference.mp4
# agent writes workspace/DESIGN.md, Motion.md, ultra.json (+ workspace/scenes/*.html)
node ultra-workflow/dist/ultra.mjs validate-spec && node ultra-workflow/dist/ultra.mjs asset-plan
# agent generates assets natively…
node ultra-workflow/dist/ultra.mjs validate-assets && node ultra-workflow/dist/ultra.mjs build
node ultra-workflow/dist/ultra.mjs verify reference.mp4   # stutterEvents must be 0
node ultra-workflow/dist/ultra.mjs render                 # build/ultra-final.mp4
```

Fallback — no GitHub access: attach `ultra-workflow-cloud.zip`, then
`unzip -q ultra-workflow-cloud.zip -d ultra && node ultra/ultra.mjs doctor --json`
(same commands with `node ultra/ultra.mjs`).

`ultra.mjs` is a single esbuild bundle (zod + commander + ws + all internals) with
a native **CDP browser driver** — it discovers any chromium/chrome/edge (system
or Playwright/Puppeteer cache; `ULTRA_BROWSER_PATH` overrides) and needs nothing
else. Paste `CHAT_START_PROMPT.txt` into a fresh Gemini/Muse chat; the bundled
`SKILL.md` is the autonomous playbook.

## Two first-class processes (v3)

| Process | Prompt file | What it does |
|---|---|---|
| **1 · EXTRACT STYLE** (1–10 references → downloadable pack) | `prompts/PROCESS1_EXTRACT_STYLE.txt` | `ultra style-probe` measures ASL/silence/beat-snap/palettes/audio envelope across all clips → agent Map-Reduces 8 style groups, authors `style.json` + `STYLE.md` + offline `motifs/*.html` + `exemplars/` → `style-validate` → `style-export` → delivers `<slug>-style-pack.zip` |
| **2A · CLONE REFERENCE** | `prompts/PROCESS2A_CLONE_REFERENCE.txt` | the original 1:1 pipeline (`probe → assets → build → verify <ref> → patch → render`) |
| **2B · EDIT MY VIDEO IN STYLE** | `prompts/PROCESS2B_EDIT_MY_VIDEO_IN_STYLE.txt` | `raw-probe my_video.mp4 --style <slug>` → `sourceClip` trims with J/L cuts, punch-ins, styled captions → `build` → `verify --style <slug>` (style compliance + `stutterEvents === 0` + `style-match.png`) → `render` |

Users import downloaded packs in Qoder with `prompts/QODER_IMPORT_STYLE_TO_REPO.txt`:
`node dist/ultra.mjs style-import <slug>-style-pack.zip --repack` installs to
`styles/<slug>/`, updates `styles/registry.json` and repacks the cloud zip, so
every future Gemini/Muse chat can use `--style <slug>`.

New v3 CLI: `style-probe`, `style-list`, `style-validate`, `style-export`,
`style-import`, `raw-probe`, and `verify --style <slug>` (the reference-clone
`verify <ref.mp4>` is unchanged). Scene specs now support
`sourceClip: { path, inSec, outSec, muteSourceAudio, jCutLeadSec, lCutTrailSec,
scale, panX, panY, cropMode }` for editing the user's own footage.

## Three cloud chat platforms & render tiers (v4)

Works in **Google Gemini**, **Meta Muse**, and **ChatGPT** containers — zero
install, zero external AI APIs, no API keys.

ChatGPT has two load paths:

```bash
# a) direct raw download inside the container
curl -L -o ultra-workflow-cloud.zip \
  https://raw.githubusercontent.com/akspro9866-art/ultra-workflow/main/dist/ultra-workflow-cloud.zip
unzip -q ultra-workflow-cloud.zip -d ultra
node ultra/ultra.mjs doctor --json --host chatgpt
# b) or upload ultra-workflow-cloud.zip into the chat and unzip it the same way
```
Ready-to-paste ChatGPT prompts: `prompts/CHATGPT_PROCESS1_EXTRACT_STYLE.txt`,
`prompts/CHATGPT_PROCESS2A_CLONE_REFERENCE.txt`,
`prompts/CHATGPT_PROCESS2B_EDIT_MY_VIDEO_IN_STYLE.txt`.

`doctor` reports a `renderTier`:

| Tier | When | Rendering |
|---|---|---|
| `full-cdp` | Chromium/Chrome/Edge available | HyperFrames + Three.js + optional Remotion/Revideo + CDP screenshots (phases 1–8 unchanged) |
| `browserless-py` | no browser (or `ULTRA_NO_BROWSER=1`) with Python 3 + Pillow + FFmpeg — standard ChatGPT container | `engines/py-canvas` renders deterministically with Pillow (easing, reveals, captions, sourceClip, chart/counter vectors, image Ken Burns, seeded grain, blender wireframe fallback) and pipes raw frames into FFmpeg; DOM lint becomes a Python layout linter; audit pairs compose via FFmpeg (no Chromium at all) |
| `ffmpeg-only` | neither browser nor Pillow | reduced py-canvas FFmpeg filtergraph fallback for text/background scenes |

In browserless ChatGPT containers use native **Image Generation** for stills and
B-roll keyframes (`asset-plan --host chatgpt` flags them
`native-image-plus-2.5d-rig`) and the built-in synthesizer for sound:

```bash
node ultra/ultra.mjs synth-audio --preset whoosh --out workspace/assets/whoosh.wav
node ultra/ultra.mjs synth-audio --preset beat-pulse --out workspace/assets/bed.wav --duration 4 --bpm 120 --mood tech
node ultra/ultra.mjs synth-audio --from-assets          # every pending sfx/music
```
Presets — SFX: `whoosh`, `whoosh-fast`, `sub-hit`, `riser`, `pop`, `ui-click`,
`glitch-zap`, `shutter`, `swoosh-reverse`, `chime`; music: `beat-pulse`,
`ambient-tech`, `minimal-tension`. Output is 48 kHz 16-bit stereo WAV with
soft-clipped, dither-added broadcast levels.

## Scene authoring: primitives + escape hatch

`ultra.json` primitives cover structured motion: keyframes/easing, split-text
`reveal` (chars/words/lines + masks), 2.5D `camera` rig, `clipReveal`
(wipe/iris/diagonal), SVG `svgDraw`, `glass` shapes, grain/halftone/vignette/
chromatic/glow effects, and `motionBlurSamples: 1..4` subframe motion blur.
For exotic reference shots, hand-author `workspace/scenes/<name>.html` (or inline
`customCode`) and animate via `window.ultraRender(frame, fps, timeSec, progress,
audio)` with `window.UltraEase`; `window.__ULTRA_AUDIO` carries the frame-accurate
RMS envelope + beats from `probe`. Revideo-style vector scenes render
cloud-native via `engine: "revideo"` + `enginePayload.sceneType`
(vectors/diagram/sequence/chart/counter/code).

## Local development

```bash
npm install
npm run typecheck
npm test                 # 7 TS suites + Python mock-bpy Blender test
npm run test:python      # py_compile + tests/test_blender_script.py
npm run pack:cloud       # → dist/ultra-workflow-cloud.zip (lean, <3 MB)
```

Requirements (local dev / native engines): Node ≥ 20, FFmpeg + ffprobe on PATH,
Chromium-compatible browser (auto-discovered), Python 3.11+ for the Blender test.
Blender 3.6–4.5 is optional (Three.js WebGL alpha fallback otherwise).

Optional heavy engines (isolated workspaces, never needed in cloud):

```bash
npm run setup:engines
```
- **Remotion** activates natively once installed (check your org's Remotion licensing).
- **Revideo** native rendering is opt-in (`ULTRA_REVIDEO_NATIVE=1`); otherwise the
  built-in cloud-native choreography renders those scenes (deterministic, no hangs).

## Tests

| Suite | Covers |
|-------|--------|
| phase1 | probe metadata/cuts/onsets/palettes/audio-envelope/contact sheets + doctor |
| phase2 | asset-plan/validate + stitcher (xfade, alpha overlay, LUT, ducking) |
| phase3 | 3s 60fps deterministic render + DOM/contrast/palette/overlap linter |
| phase4 | multi-engine routing + fallback + SHA-1 cache hit |
| phase5 | transparent 3D overlay (Three.js fallback / native Blender) + composite |
| phase6 | verify → break → patch → rebuild → verify → render (strict stutter gate) |
| phase7 | **isolated zero-install cloud run** from the packed zip (custom HTML + vector choreography + 3D alpha + verify + render) |
| phase8 | **dual-process style system**: style-probe → pack validate/export/import → raw-probe silence edit plan → sourceClip build → `verify --style` compliance + style-match.png → render |
| phase9 | **ChatGPT container simulation**: zero-install zip + `ULTRA_NO_BROWSER=1` → `renderTier: browserless-py` → synth-audio WAVs (ffprobe 48k/2ch) → py-canvas multi-scene build (sourceClip + kinetic title + revideo chart + alpha wireframe) → verify (stutterEvents 0, ffmpeg audit pairs) → render |
| Python | `tests/test_blender_script.py` — mock-bpy end-to-end pipeline |

## Outputs

`workspace/probe.json`, `workspace/probe-frames/`, `contact-sheet-*.png`,
`workspace/audio-envelope.json`, `workspace/assets-todo.json` +
`assets.manifest.json`, `build/build-manifest.json`, `build/scenes/`,
`build/draft.mp4`, `build/audit-frames/pair_*.png` (2A) or
`build/audit-frames/style-match.png` (2B), `build/verify-report.json`
(quantitative flags + SSIM sceneSimilarity + style compliance + 100-pt rubric),
`build/ultra-final.mp4`. Style workflow: `workspace/style-probe/aggregate.json` +
`batch-overview.png` + `candidates/`, `workspace/raw-probe/raw-edit-plan.json`,
`styles/<slug>/` packs, `build/<slug>-style-pack.zip`. Synthesizer WAVs
(`synth-audio`) go wherever `--out` points (often `workspace/assets/`).

See `SPEC.md` for the full contract.
