# SPEC.md — Ultra Workflow v1.1 system contract

Ultra Workflow (`ultra`) is a **100% offline, zero-API, zero-install** CLI +
deterministic multi-engine video compiler for agent sandboxes (Google Gemini /
Meta Muse cloud VMs or any local shell). The chat agent is the multimodal brain;
Ultra is the engineering engine.

## 1. Zero-API / zero-install rule

- No AI SDKs, no API keys, no outbound AI calls.
- `dist/ultra-workflow-cloud.zip` runs with **no `npm install` and no internet**:
  `unzip -q ultra-workflow-cloud.zip -d ultra && node ultra/ultra.mjs doctor`.
- Zero-install contents (< 3 MB hard limit, ~262 KiB actual):
  `ultra.mjs` (single esbuild bundle: zod + commander + ws + all internals),
  `ultra` / `ultra.cmd` launchers, `package.json` (root anchor), `assets/vendor/`
  (offline `three.module.min.js` + `ultra-motion.js` easing runtime),
  `engines/blender/render_scene.py`, `SKILL.md`, `CHAT_START_PROMPT.txt`,
  `SPEC.md`, `README.md`. No Playwright binaries, no `node_modules` are bundled.

## 2. Browser layer

- `core/cdp-browser.ts` — native Chrome DevTools Protocol driver over `ws`:
  auto-discovers chromium/chromium-browser/google-chrome/google-chrome-stable/
  msedge, macOS app paths, Playwright caches (`~/.cache/ms-playwright`,
  `%LOCALAPPDATA%\ms-playwright`) and Puppeteer caches, plus `ULTRA_BROWSER_PATH`.
- Cloud-container-safe flags: `--headless=new --no-sandbox
  --disable-setuid-sandbox --disable-dev-shm-usage --use-gl=angle
  --use-angle=swiftshader --enable-webgl --hide-scrollbars --mute-audio
  --remote-debugging-port=0` (+ swiftshader/unsafe-webgl and file access).
- Deterministic page loading, `Runtime.evaluate`, viewport sizing
  (`Emulation.setDeviceMetricsOverride`), transparent background
  (`Emulation.setDefaultBackgroundColorOverride`), lossless PNG
  `Page.captureScreenshot` at exact frame steps.
- `core/browser.ts` prefers CDP; Playwright is only used when
  `ULTRA_BROWSER_DRIVER=playwright` (optional, never bundled).

## 3. Agent ↔ CLI handoff

| Rule | Command | Contract |
|------|---------|----------|
| 1 ANALYZE | `ultra probe <ref>` | `workspace/probe.json`: exact fps/resolution/duration, cuts, onsets, **per-scene top-5 palettes + avgLuminance + contrast** (FFmpeg rawvideo sampling), timestamped keyframes, 3×3 contact sheets with **cut numbers + palette swatches**; `workspace/audio-envelope.json`: RMS 0..1 per video frame at target fps + `beatsSec`. |
| 2 ASSETS | `ultra asset-plan` → agent → `ultra validate-assets` | Only missing/invalid assets, exact prompts/sizes/alpha rules, SHA-1 manifest, SVG XML / PNG alpha / audio-video / scene-graph validity. |
| 3/4 BUILD | `ultra build` | Frame-stepped deterministic rendering (`__ULTRA_SEEK`), anti-slop primitives, engine routing, SHA-1 cache; `build/draft.mp4`. |
| 5 VERIFY | `ultra verify <ref>` | Quantitative audit + DOM lint + labeled pairs + SSIM `sceneSimilarity[]` + 100-pt rubric. |
| 6 RENDER | `ultra render` | Gated final MP4 (exact CFR, LUT grade, ducked audio, −14 LUFS). |

## 4. Scene contract (`workspace/ultra.json`, strict Zod)

`meta`, `designTokens` (palette/fonts/grain/antiSlopRules ≥1), `colorGrade`,
`audio` (targetLufs, music/voice, duckingDb, sfxCues), `assets[]`, `scenes[]`.

Scene fields: `id, name, startSec, endSec, engine, overlayOfSceneId?, alpha?,
transitionIn{type,durationSec}, background, layers[], keyframes[], textElements[],
effects[], enginePayload, motionBlurSamples (1..4, default 1),
camera{perspectivePx, keyframes[rotateX/Y/Z, zoom, panX/Y]},
clipReveal{none|wipe|iris|diagonal, durationSec, delaySec},
customHtmlFile? | customCode{html,css,js}?`.

- Timeline scenes tile `[0, durationSec]` (±0.06s); alpha scenes must declare
  `overlayOfSceneId` and no transitions; custom HTML requires engine
  `hyperframes`; `customHtmlFile` must be a relative path inside `workspace/scenes/`.
- Text reveals: `textElements[].reveal{mode none|chars|words|lines, staggerSec,
  durationSec, delaySec, from up|down|left|right, distancePx, easing, mask}`.
- SVG layers may set `svgDraw` (stroke-dashoffset interpolation via
  `pathLength="1"`), `drawDelaySec`, `drawDurationSec`; shape layers may set
  `glass`; effects: grain, halftone, vignette, blur, glow, chromatic.

**Custom scene escape hatch**: `workspace/scenes/*.html` (full document or
fragment) or inline `customCode`. Ultra injects a deterministic virtual clock
(`window.__ULTRA_SEEK(frame, fps)`), `window.__ULTRA_AUDIO` (the envelope),
`window.UltraEase` (offline easing/spring curves) and calls
`window.ultraRender(frame, fps, timeSec, progress, audio)` when present. The
same DOM/contrast/clipping/blank linter runs; add `data-audit="text"` markers to
opt text into palette/contrast checks.

## 5. Engines

| Engine | Worker | Notes |
|--------|--------|-------|
| hyperframes | Chromium (CDP) | Deterministic HTML/CSS runtime + SVG/Canvas/custom scenes; 2.5D camera rig, split-text reveals, clip reveals, glass/halftone; optional subframe motion blur (`motionBlurSamples` → N sub-seeks, PNG sequences blended via FFmpeg `blend=average`). Lossless PNGs → exact CFR. |
| revideo (cloud-native) | Chromium choreography | Built-in deterministic vector choreography for `enginePayload.sceneType` ∈ vectors/diagram/sequence/chart/counter/code (polylines, arrows/nodes, bars, counters, code highlights). Native `@revideo/*` rendering stays opt-in (`ULTRA_REVIDEO_NATIVE=1`) because upstream packaging pulls undeclared peers; telemetry disabled; time-bounded. |
| remotion | Isolated workspace (optional) | Spring type/UI/chart/grade compositions when installed (`npm run setup:engines`); otherwise HyperFrames fallback. |
| blender | `blender --background` + `render_scene.py` | Blender 3.6–4.5 hardened: Principled BSDF input renames (Specular IOR Level, Subsurface Weight, Emission Color, Coat Weight, Transmission Weight), dynamic EEVEE enum (BLENDER_EEVEE_NEXT / BLENDER_EEVEE), AgX→Filmic→Standard color management, GPU→CPU→EEVEE fallback, bpy.data/bmesh only, RGBA transparent output. Without Blender, the same `scene_graph.json` renders via Three.js WebGL (offline vendor copy) with alpha. |

Unavailable engines fall back to HyperFrames unless `--strict-engine`.

## 6. Stitcher

Per-run concatenation + `xfade` joins, alpha `overlay` compositing, grade chain
(`lut3d` → `eq` → `colorbalance` → `vignette` → `scale=out_range=tv` →
`format=yuv420p`), audio (`adelay` SFX, `sidechaincompress` ducking, `alimiter`,
`loudnorm −14 LUFS / −1.5 dBTP`), exact-CFR `yuv420p` H.264 + AAC 192k.

## 7. Verification report (`build/verify-report.json`)

- `quantitative`: duration Δ/ok, fps/CFR, `duplicateRatio`, **`staticHoldFrames`
  / `staticHoldRatio`** (informational), **`stutterEvents` / `stutterFrames` /
  `jitterRatio`** (strict gate: `stutterEvents` must be 0), black detections,
  loudness, pass.
- Jitter measurement: `format=gray,tblend=all_mode=difference,signalstats,
  metadata=print` YAVG per frame pair; duplicates = YAVG ≤ 0.12 (above H.264 QP
  noise); runs ≥ fps·0.25 = static holds; isolated 2–3 duplicate frames amid
  motion = stutter; single-frame micro-holds (easing apexes) are not defects;
  single-frame noise gaps (< 0.25) are bridged.
- `lint`: per-scene defects (clip/overlap/contrast/brokenMedia/blankFrame/palette/layout).
- `visualPairs`: labeled `build/audit-frames/pair_XX.png` + per-pair SSIM.
- `sceneSimilarity[]`: `{index, timestampSec, sceneId, ssim, mae}` per matched pair.
- `rubric`: 5 categories × 4 items × 5 pts; agent fills checks/scores (≥90).

## 8. Cache

`.ultra-cache/renders/<sha1>.{mp4,mov}` keyed over scene JSON + tokens + grade +
fps/size + render duration + referenced asset bytes + resolved engine; patches
invalidate only targeted scenes. Render-time fallbacks are stored under the
HyperFrames key so a later working native engine is never masked.

## 9. Packaging & proof

`npm run pack:cloud` → tsc + esbuild bundle + vendored three + launchers →
`dist/ultra-workflow-cloud.zip` (hard fail > 3 MB, warn > 2.5 MB).
`tests/phase7.cloud-bundle.test.ts` packs, extracts with CRC verification into a
fresh `os.tmpdir()` folder with **zero node_modules**, runs `doctor.json`, a
real multi-scene build (bespoke custom HTML + vector choreography + Three.js
alpha overlay + HyperFrames outro), `verify` (asserting `stutterEvents === 0`),
and `render` to a playable `yuv420p` CFR MP4. `tests/test_blender_script.py`
(mock-bpy) runs under `npm test` together with the 7 TypeScript suites.

## 10. v3 — Dual-process style system

**Process 1 · EXTRACT STYLE** (`ultra style-probe <refs...> [--out]`):
1–10 references are probed (ffprobe, cuts, onsets, per-scene palettes, audio
envelope, contact sheets, jitter-derived longest static hold, silencedetect,
signalstats saturation) into `workspace/style-probe/aggregate.json` with
Hook/Body/Outro ASL min/median/max, longest static hold, silence distribution,
beat-snap ratio (±100ms), aggregated palette clusters, luminance/contrast/
saturation; 5 candidate stills per reference (`candidates/`) and a combined
`batch-overview.png`. The agent Map-Reduces all 8 groups and authors a pack:
`style.json` (strict `StylePackSchema` in `core/style-schema.ts`: meta, pacing,
motion, typography, visualLayering, colorAndTexture, transitions, soundDesign,
narrative), `STYLE.md` (≥300 chars), `exemplars/` (2–8 PNG/JPEG/WebP with magic
validation), deterministic `motifs/*.html` (`__ULTRA_SEEK`, no CDN scripts),
optional `grade.cube` (`LUT_3D_SIZE`) and `assets/`. `ultra style-validate`
rejects schema errors, short docs, bad exemplars, missing motif hooks, external
CDN scripts, invalid LUTs, absolute machine paths and secrets.

Lifecycle: `style-list` (registry view), `style-export` (validates, packages
`<slug>-style-pack.zip` + `ADD_TO_REPO_IN_QODER.txt`), `style-import <zipOrDir>
[--repack]` (pure-Node CRC-verified unzip, strict validation, installs into
`styles/<slug>/`, rebuilds `styles/registry.json`, optionally runs
`npm run pack:cloud` in dev repos so the pack ships inside the cloud zip).
`prompts/` carries ready-to-paste PROCESS1 / PROCESS2A / PROCESS2B /
QODER_IMPORT_STYLE_TO_REPO prompts.

**Process 2B · EDIT MY VIDEO IN STYLE**: `ultra raw-probe <my_video.mp4>
--style <slug>` re-probes the user's footage, detects silences with the style's
`silenceTrimMs`, and writes `workspace/raw-probe/raw-edit-plan.json` (silences,
removed intervals, keepSegments, hookEnd, chapter resets, target body ASL,
maxStaticHoldSec, punch-in points, B-roll cutaways, caption windows, beats).
Scenes accept `sourceClip: {path, inSec, outSec, muteSourceAudio, jCutLeadSec,
lCutTrailSec, scale, panX, panY, cropMode}`; HyperFrames renders the trimmed
footage deterministically (video seek = inSec + t, exact CFR, punch-in via
`camera`/scale) and the stitcher mixes the source audio with J/L offsets,
`adelay`, `sidechaincompress` and `loudnorm` alongside the style grade.

**Style-aware Rule 5**: `ultra verify --style <slug>` keeps all quantitative
gates (CFR, `stutterEvents === 0`, black frames, LUFS within ±1.5 dB of
`style.soundDesign.targetLufs`) and adds a Style Compliance Audit: scene
durations vs hook/body/outro ASL ranges (scene midpoints classified against
`hookWindowSec` and the last 20% outro window), longest static hold vs
`maxStaticHoldSec`, zero use of `transitions.bannedTypes`, and draft dominant
palette distance (24-bucket RGB sampling; average nearest distance ≤ 110).
`build/audit-frames/style-match.png` pairs 6 draft frames against
`exemplars/*` labeled STYLE EXEMPLAR vs YOUR EDIT for the agent's 0–100 visual
grading. `verify <ref.mp4>` (2A) remains unchanged.

`tests/phase8.style-system.test.ts` covers the full lifecycle: synthetic
ref1/ref2 → style-probe aggregates → authored demo-punchy pack → validate →
export zip (CRC-checked) → import into an isolated temp repo + registry →
raw-probe detects the deliberate 1.5s silence gap and emits keepSegments →
sourceClip build with punch-in + styled captions + style grade → `verify --style`
(compliance pass, stutterEvents 0, style-match.png) → renderable `yuv420p` CFR MP4.

## 11. v4 — Tri-platform edition (Gemini · Meta Muse · ChatGPT)

`ultra doctor --json [--host auto|gemini|muse|chatgpt]` reports a `renderTier`:
- **full-cdp** — Chromium/Chrome/Edge present: the CDP HyperFrames/Three.js
  pipeline (plus optional Remotion/Revideo) runs unchanged (phases 1–8).
- **browserless-py** — no browser (or `ULTRA_NO_BROWSER=1`) with Python 3 +
  Pillow + FFmpeg (ChatGPT Linux containers): `engines/py-canvas` takes over
  hyperframes/revideo/blender/remotion scenes, renders deterministic frames with
  Pillow (UltraEase-compatible easings incl. expo/back/power3 aliases, char/word/
  line reveals with active-word pills, sourceClip trims with camera punch-ins,
  chart/counter/code vector choreography with rounded cards and arrowheads,
  image layers with camera Ken Burns, seeded per-frame film grain, motion-blur
  averaging, blender wireframe/shaded polyhedron alpha fallback) and pipes raw
  RGB(A) straight into FFmpeg (yuv420p TV levels; ProRes 4444 alpha overlays).
  Rule 5 lint runs through the Python layout linter (clip/contrast/brokenMedia/
  blank) and side-by-side audit pairs compose via FFmpeg hstack (no Chromium).
  Builds record `fallbackReason: "browserless-py"` and use separate cache keys.
- **ffmpeg-only** — neither browser nor Pillow, or `ULTRA_FORCE_TIER=ffmpeg-only`:
  `engines/ffmpeg-only` renders pure-FFmpeg drawtext/drawbox with the bundled
  TTFs, zoompan punch-ins, sourceClip trims, temporal noise grain and color
  grade → CFR yuv420p or ProRes 4444 alpha (live-tested in phase10).
Doctor also reports `pythonModules` (PIL/numpy/cairosvg), `fonts.bundledFonts[]`
and discovered regular/bold/mono TrueType fonts (Linux `/usr/share/fonts`,
Windows `C:\Windows\Fonts`, macOS, plus `workspace/assets/fonts`).

`ultra asset-plan --host chatgpt` adapts instructions to native ChatGPT
capabilities: image/illustration/png_alpha → Image Generation; video B-roll →
`chatgptStrategy: "native-image-plus-2.5d-rig"` (one keyframe + deterministic
zoom/pan); sfx/music → `chatgptStrategy: "ultra-synth-audio"` with ready
`synthPreset` specs ({preset,bpm,mood,durationSec}).

`ultra synth-audio --preset <name> --out <wav> [--duration --bpm --mood --spec]`
and `--from-assets [assets-todo.json]` implement a zero-dependency 48 kHz
16-bit stereo WAV synthesizer (seeded noise, pink filter, sweeps, FM/sub punch,
stereo widening, soft-clip limiter, dither). SFX presets: whoosh, whoosh-fast,
sub-hit, riser, pop, ui-click, glitch-zap, shutter, swoosh-reverse, chime;
music: beat-pulse (bpm-locked kick/hat/sub loop), ambient-tech, minimal-tension.

Cloud zip keeps `engines/py-canvas/render_scene.py` alongside `ultra.mjs`,
vendor/assets, `styles/`, `prompts/` and the Blender script; docs cover both
ChatGPT load paths (raw.githubusercontent.com download or zip upload) and three
`prompts/CHATGPT_*.txt` files. `tests/phase9.chatgpt-browserless.test.ts`
simulates the container: zero node_modules, `ULTRA_NO_BROWSER=1`,
`renderTier=browserless-py`, synth WAVs probed at 48 kHz/2ch, py-canvas
multi-scene build (sourceClip + kinetic title + chart + alpha wireframe),
`verify` (stutterEvents 0, FFmpeg audit pairs), and a playable yuv420p MP4.

## 12 · v5 — Linux-hardened studio edition

**Line endings.** `.gitattributes` enforces `* text=auto eol=lf` for source,
docs, scripts and `dist/ultra` (binaries stay binary). `scripts/pack-cloud.ts`
normalizes every text/script entry in the cloud zip to LF, preserves `0o755` on
`ultra` and `run.sh`, and fails the pack above 2.2 MiB.

**Bundled offline typography.** `assets/fonts/` ships four SIL OFL static TTFs
(`UltraDisplay-Bold`, `UltraSans-Regular`, `UltraSans-Bold`, `UltraMono-Regular`
— 159 KiB total) generated by `scripts/make-bundled-fonts.py` from Space Grotesk,
Inter and JetBrains Mono variable sources (instancer + Latin subset + rename).
`discoverFonts()` prioritizes workspace overrides, then bundled files, then
system fonts; HyperFrames injects local `@font-face` aliases for the Ultra
families and every design-token font name, py-canvas uses the same files, and
the FFmpeg-only engine passes them as `drawtext=fontfile=`. `doctor --json`
exposes `fonts.bundledFonts[]`.

**Captions & safe zones.** `ultra captions-align` parses SRT/VTT/word-JSON or
force-aligns a plain script over RMS speech windows (syllable/character-weighted,
zero overlapping timestamps). Chunks honor `typography.captionChunkWords`, flag
numeric/emphasis keywords, and carry `safeBox` (normalized + nominal pixels).
`core/safe-zones.ts` defines the 9:16 (12% top / 22% bottom / 15% right / 5%
left), 16:9 (6% perimeter) and 1:1 (8% perimeter) profiles. `--aspect` is
accepted by `raw-probe` and `captions-align`; `meta.aspectProfile` enables
strict text safe-zone linting. HyperFrames’ DOM audit and py-canvas’ lint emit
non-critical `layout` defects when captions/text enter a danger zone. Both
engines ingest `workspace/captions.json` on `sourceClip` scenes and animate the
active word (pill/underline/color/scale) from absolute caption timestamps.

**Agent state.** `ultra status [--json]` inspects `workspace/` and `build/`,
detects `extract-style|clone-reference|edit-in-style|uninitialized`, lists each
stage (probe, DESIGN, ultra.json, assets, captions, draft, verify) with resolved
paths/notes, counts pending assets, surfaces verify pass + rubric score, and
returns the exact `nextCommand`.

**Render tiers.** `ULTRA_FORCE_TIER=full-cdp|browserless-py|ffmpeg-only` overrides
auto-detection for `doctor` and the orchestrator. The dedicated ffmpeg-only
engine is selected whenever the tier is `ffmpeg-only`; builds record
`fallbackReason: "ffmpeg-only"` and cache separately. `doctor.ok` now reflects
FFmpeg/ffprobe availability for every tier.

**Built-in Style Packs.** `styles/punchy-shortform` (9:16),
`styles/kinetic-editorial` (16:9) and `styles/dark-tech-launch` (16:9) each ship
a schema-valid `style.json`, a ≥300-char `STYLE.md`, two deterministic offline
motifs and three 640px-wide exemplar PNGs rendered through the HyperFrames
compiler/runtime. `styles/registry.json` lists all three; they travel in the
cloud zip and are valid `--style` targets immediately.

**CI.** `.github/workflows/ci.yml` runs on `ubuntu-latest` (Node 20, Python 3.11,
FFmpeg, Chromium/Pillow/numpy): LF guard → typecheck → `pack:cloud` with zip
size/integrity/font/style assertions → validate every `styles/*/` → all 10 TS
suites + Python → zero-AI-SDK/zero-secret scan → upload the cloud zip artifact
(30-day retention). Badge:
`https://github.com/akspro9866-art/ultra-workflow/actions/workflows/ci.yml/badge.svg`.

`tests/phase10.production-hardening.test.ts` proves the bundled fonts + LF-safe
zip, all three packs, SRT and forced-alignment captions with 9:16 danger-zone
lint, the live `ULTRA_FORCE_TIER=ffmpeg-only` build/verify/render path
(stutterEvents 0, CFR yuv420p), and `status --json` stage tracking.
