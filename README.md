# Ultra Workflow

[![CI](https://github.com/akspro9866-art/ultra-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/akspro9866-art/ultra-workflow/actions/workflows/ci.yml)

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
node ultra-workflow/dist/ultra.mjs status --json          # process + stages + exact nextCommand
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
| `ffmpeg-only` | neither browser nor Pillow, or `ULTRA_FORCE_TIER=ffmpeg-only` | dedicated pure-FFmpeg engine (`engines/ffmpeg-only`): drawtext with bundled TTFs, drawbox, zoompan punch-ins, sourceClip trims, noise grain, color grade → valid CFR `yuv420p`/ProRes alpha; live-tested in phase10 |

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

## v6 — Studio harness, pre-prod approval, 4K mastering, editable delivery

- **Pre-Production Approval Gate** — `plan-init` writes a strict `plan.json` + `PLAN.md`;
  `preprod-render` emits `build/preprod/moodboard.png` + `storyboard*.png` with bundled
  fonts on every tier (pure FFmpeg). `build`/`render` are hard-blocked until
  `approve --by user` stores the SHA-256 of plan.json + ultra.json; edits invalidate it.
- **4K mastering** — `meta.deliveryResolution: "4k"` or `render --4k` produces exact
  `3840x2160` / `2160x3840` / `2160x2160`, CFR yuv420p H.264 High@L5.1 CRF16,
  AAC 48 kHz stereo 320k, +faststart, with a post-render ffprobe assertion and
  `build/delivery-manifest.json`. `--4k-strategy hybrid` (default) logs the
  lanczos + accurate_rnd + full_chroma + unsharp upscale; `native` requires a 4K build.
  `build --proxy` iterates at max 1280px without changing the delivery target.
- **Editable project export** — `export-project` packages FCPXML 1.10, OTIO JSON,
  `project.ultra.json` (relative asset paths only), DESIGN/Motion/PLAN, assets,
  scenes, bundled fonts, motifs, grade LUT, captions, and a zero-CDN `index.html`
  inspector into a CRC-verified `build/editable-project.zip`.
- **Studio harness** — root `AGENTS.md` + `.ultra/rules/` (approval gate, anti-slop,
  zero hallucination, 4K/editable delivery) + `.ultra/skills/` (preprod, extract,
  clone, edit) + five `.ultra/agents/` role contracts. `orchestrate --status`
  reports the active role, artifact contract, parallel-safe steps and next command;
  `workspace/state.json` tracks stage, approval, artifacts and Ralph state.
- **Context + RAG** — `ultra rag query` runs an offline BM25 index over styles,
  motifs, rules, skills, effects and all 13 synth presets (`dist/rag-index.json`).
  `context-pack --stage ... --budget-tokens N` writes a deterministic brief with only
  active rules, top RAG hits, blockers, verified paths and the exact next command.
- **Ralph loop** — `ralph init/auto-fix/status` deterministically clamps captions and
  text into safe zones, lifts WCAG contrast from the project palette, replaces banned
  transitions, corrects loudness, snapshots the best project and stops with
  `ralph-history.md` when stalled/regressed or the completion promise is met.
- **Guard** — `guard --stage plan|build|verify|delivery` grounds every asset/sourceClip/
  custom scene/placeholder and checks evidence against ffprobe, verify-report,
  delivery-manifest and the editable zip. It exits non-zero on any false claim.

```bash
ultra plan-init --mode edit-in-style --style punchy-shortform --aspect 9:16 --resolution 4k
ultra preprod-render        # show moodboard + storyboard; WAIT for the user
ultra approve --by user
ultra build --proxy && ultra verify --style punchy-shortform
ultra ralph init --max-iter 5 --min-score 90 && ultra ralph auto-fix
ultra render --4k && ultra export-project && ultra guard --stage delivery
```

### Honest architecture limitations
- Cloud chat roles execute **sequentially**; only multi-agent IDEs can truly parallelize
  director + asset-producer (the contracts and parallel-safe boundaries are documented).
- True **native** 4K re-render is memory-heavy; the cloud-safe default is hybrid upscale,
  logged explicitly. 4K assertions still verify the exact delivered dimensions.
- `guard` catches grounding/evidence lies, not taste; style-match/rubric scoring remains
  agent/human judgment.
- FCPXML/OTIO are interchange artifacts validated structurally; NLE-specific quirks and
  round-trip import are not claimed.

## v5 — Linux-hardened studio edition

- **Bundled offline typography** — four SIL OFL TTFs in `assets/fonts/`
  (`UltraDisplay-Bold`, `UltraSans-Regular/Bold`, `UltraMono-Regular`, 159 KiB total)
  register as local `@font-face` rules in HyperFrames, default fonts in py-canvas and
  `drawtext=fontfile=` in the FFmpeg-only engine. `doctor --json` lists
  `fonts.bundledFonts[]`. Source generator: `python scripts/make-bundled-fonts.py`.
- **Word-level captions** — `ultra captions-align --out workspace/captions.json`
  parses `.srt`, `.vtt`, word-JSON, or performs deterministic speech-burst forced
  alignment from `--script` + `audio-envelope.json`. Chunks follow the Style Pack's
  `captionChunkWords`, flag numeric/emphasis keywords, and carry `safeBox` coordinates.
  `sourceClip` scenes ingest `workspace/captions.json` directly (active-word pill /
  underline / color) in HyperFrames, py-canvas and the FFmpeg-only tier.
- **Platform safe zones** — `--aspect 9:16|16:9|1:1` on `raw-probe` / `captions-align`
  and optional `meta.aspectProfile` in `ultra.json`. 9:16 reserves top 12%, bottom 22%,
  right 15%, left 5%; 16:9 uses a 6% title-safe perimeter; 1:1 uses 8%. The
  HyperFrames DOM linter and the py-canvas linter emit structured `layout` defects
  when captions/text enter a platform danger zone.
- **`ultra status [--json]`** — detects `extract-style` / `clone-reference` /
  `edit-in-style` / `uninitialized`, lists completed stages vs missing prerequisites
  and prints the exact `nextCommand` so long multi-turn cloud chats never lose place.
- **Forced tier testing** — `ULTRA_FORCE_TIER=full-cdp|browserless-py|ffmpeg-only`
  in `doctor` and the orchestrator; the new phase10 suite proves the FFmpeg-only tier
  end-to-end with zero Chromium and zero Python rendering.
- **Three built-in Style Packs** ready for `--style` immediately:
  `punchy-shortform` (9:16), `kinetic-editorial` (16:9), `dark-tech-launch` (16:9).
  Each ships `style.json`, `STYLE.md`, 2 bespoke deterministic motifs and 3 exemplar
  PNGs rendered through Ultra Workflow itself (640px wide).
- **GitHub Actions CI on `ubuntu-latest`** — LF guard, typecheck, cloud pack + zip
  integrity/size, all Style Packs, all 10 TS suites + Python, zero-API scan, and the
  cloud zip uploaded as a downloadable artifact (30 days).

```bash
node ultra/ultra.mjs captions-align --script script.txt \
  --envelope workspace/raw-probe/audio-envelope.json \
  --style punchy-shortform --aspect 9:16
node ultra/ultra.mjs status --json
ULTRA_FORCE_TIER=ffmpeg-only node ultra/ultra.mjs doctor --json
```

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
npm test                 # all 11 TS suites + Python mock-bpy Blender test
npm run test:python      # py_compile + tests/test_blender_script.py
npm run pack:cloud       # → dist/ultra.mjs + rag-index.json + cloud zip (≤ 2.5 MiB, LF)
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
| phase10 | **production hardening**: bundled fonts in zip with zero CRLF scripts, all 3 built-in packs validate, SRT + forced-alignment captions with 9:16 safe zones + danger-zone lint, live `ULTRA_FORCE_TIER=ffmpeg-only` build/verify/render, `status --json` stage tracking |
| phase11 | **studio harness**: BM25 RAG + context-pack budget + guard grounding failures, moodboard/storyboard + approval hash gate, Ralph deterministic self-heal, exact 4K master (3840x2160, CFR yuv420p, AAC 48k stereo) + FCPXML/OTIO/editable zip + delivery guard, and isolated zero-install rag/context/preprod-render |
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
