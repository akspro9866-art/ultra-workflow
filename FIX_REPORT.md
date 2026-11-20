# FIX_REPORT — Muse 30-problem pass (branch `fix/muse-30-problems`)

Base: `main @ 1fcf358`. Everything below was edited in place; the architecture,
all existing commands, the three Style Packs, the Process 1 export format and the
Process 2B-only approval gate are unchanged. New schema fields are optional with
safe defaults. No new runtime dependency was added (the similarity/font/audio
analysis uses FFmpeg + the bundled fonts only).

**Top-of-report scope flags (required by the brief):**
- No change was required to the approval-gate scope (2B only), the three built-in
  Style Packs' visual output, or the Process 1 style-pack zip format. phase8 and
  phase11 (unchanged tests) still pass.
- `dist/ultra.mjs.map` is shipped next to the bundle (868 KiB JS + 3.5 MiB map);
  the cloud zip stays **964 KB** (≤ 2.5 MiB). The zip intentionally excludes the
  map (size) — documented in the CI dist-check job.

Priority commits: see "Git sequence" at the bottom.

---

## P0 — silently corrupting everything else

### [19] CACHE BUG — editing a custom scene HTML returned old frames — **FIXED**
- **Files:** `core/orchestrator.ts` (`CACHE_VERSION = 5`, `cacheKeyForScene`).
- **Fix:** when `scene.customHtmlFile` is set, `workspace/scenes/<file>` is read
  and `customHtmlFileSha1` joins the SHA-1 payload (`"missing"` when absent).
  Inline `customCode` was already hashed through the scene JSON — a regression
  test asserts that and does not double-implement it.
- **Test:** `tests/phase12.iteration-loop.test.ts` — "[19] customHtmlFile
  contents are hashed into the cache key" (edit-only-HTML invalidates that scene,
  another scene's edit does not) + inline-customCode test.
- **Muse sees:** old `.ultra-cache` entries are invalidated once (`version 5`);
  after that the "patch name-bump on every edit" workaround is unnecessary.

### [24] DURATION TRAP — `meta.durationSec` trusted, not measured — **FIXED (2A)**
- **Files:** `core/probe.ts` (`measureStreamDurations`), `core/project.ts`
  (`resolveSourceVideoPath`), `bin/ultra.ts` (`validate-spec`),
  `verifier/visual-diff.ts` (sample clamping).
- **Fix:** `validate-spec` ffprobes the reference and **errors** when
  `meta.durationSec` differs from the **video stream** by > 1 frame; the message
  shows both numbers and names video vs audio/container lengths. `visual-diff`
  clamps every sample to the measured draft duration (2 frames of margin for
  `-ss` rounding). Process 2B (`sourceClip` / `edit-in-style`) is exempt: there
  the timeline is the edit, not the source duration.
- **Test:** phase12 "[24] meta.durationSec must match the reference VIDEO
  stream" (audio-length fixture fails immediately; correct spec passes) and
  "visual-diff clamps every sample…" (short draft still produces in-range pairs).
- **Muse sees:** a wrong duration fails at `validate-spec`, not as a mysterious
  end-of-film verify failure.

---

## P1 — iteration loop, sandbox pre-flight, honesty

### [20] NO PREVIEW — **FIXED**
- **Files:** `core/preview.ts`, `verifier/visual-diff.ts` (exports `pairHtml`),
  `bin/ultra.ts`.
- **Fix:** `ultra preview --frame <N> [--ref <file>]` renders ONE frame and
  writes `build/preview/frame-<N>.png` (side-by-side, ORIGINAL|DRAFT) +
  `frame-<N>-diff.png`; `--from F --to T` writes only that range to
  `build/preview/range.mp4`. full-cdp + hyperframes only; browserless-py /
  ffmpeg-only raise an explicit tier error (never a silent full build).
- **Test:** phase12 "[20] ultra preview…": one frame on a 508-frame fixture
  takes < 25% of the full build and never writes a draft; the range test checks
  10 frames, contact sheet refresh, and the explicit tier error.
- **Muse sees:** a fast visual check before committing to a full render.

### [21] NO SINGLE-SCENE BUILD / VERIFY — **FIXED**
- **Files:** `core/orchestrator.ts` (`renderSceneClip`, `buildScenePreview`,
  `lintProject({onlySceneIds})`), `verifier/visual-diff.ts` (`buildScenePairs`),
  `verifier/scene-verify.ts`, `bin/ultra.ts`, `SKILL.md`.
- **Fix:** `build --scene <id>` renders only that scene (cache-aware) and
  stitches `build/scene-<id>-preview.mp4` with 1 s handles taken from the
  existing full draft (no draft → scene alone) plus a per-scene manifest;
  `verify --scene <id> <ref>` runs metrics + scene-local visual pairs + lint and
  writes `build/verify-report-<id>.json`. `verifier/patcher.ts` is untouched.
  SKILL.md documents `patch → build --scene → verify --scene → build → verify`.
- **Test:** phase12 "[21] build --scene…" — cold cache renders only the target
  (`renderedScenes: [id]`, 1 miss / 0 hits, other scenes not rendered), then a
  cache hit + both 1 s handles after a full build; contact-sheet mtime check
  covers [22].
- **Muse sees:** a scene iteration that does not re-render the film.

### [1] BROWSER DISCOVERY FAILS ON CLAUDE / GEMINI VMs — **FIXED**
- **Files:** `core/cdp-browser.ts`, `bin/ultra.ts`, `core/state.ts`.
- **Fix:** discovery scans Playwright caches including
  `*/chrome-linux/headless_shell` (and `.cmd/.bat` wrappers),
  `HYPERFRAMES_BROWSER_PATH`, system and Puppeteer paths; `doctor` test-launches
  candidates in priority order, writes the working path to
  `workspace/state.json` as `browserPath` (future invocations need no env var).
  Failures list every tried path. `ULTRA_BROWSER_CACHE_ONLY=1` is a documented
  diagnostic/test switch that restricts discovery to the caches.
- **Test:** phase12 "[1] browser discovery…": fake Playwright cache with a
  launcher stub → doctor `--json` reports `renderTier: full-cdp` and that
  `browserPath`, persisted to state.json. (A real Chromium copy is not portable
  across OSes; phase3/6/7 still exercise the real browser.)
- **Muse sees:** `doctor` fixes missing-browser failures; probe/build reuse it.

### [2] TEMP FILES IN A 512 MB `/tmp` — **FIXED**
- **Files:** `core/env.ts` (`ultraTmpDir`, `freeSpaceMb`, `tmpSpaceWarning`),
  `core/cdp-browser.ts`, `core/guard.ts`, `core/project-export.ts`,
  `core/style-pack.ts`, `core/similarity.ts`, `core/font-match.ts`,
  `verifier/colour.ts`.
- **Fix:** precedence `ULTRA_TMPDIR > <cwd>/workspace/.ultra-tmp > os.tmpdir()`;
  every direct `os.tmpdir()` call was replaced. `grep -rn "os.tmpdir"
  core/ engines/` returns only `core/env.ts` (definition). `doctor` warns when
  the chosen tmp volume has < 2 GB free. The render cache stays in
  `.ultra-cache/renders` as required.
- **Test:** phase12 "[2] ultraTmpDir precedence…" (override → workspace tmp) and
  the low-space warning formatter (512 MB warns, ≥ 2 GB silent).
- **Muse sees:** renders no longer die mid-run on small `/tmp` tmpfs.

### [4] DOCTOR DOES NOT PRE-FLIGHT THE SANDBOX — **FIXED**
- **Files:** `core/env.ts` (`estimatePeakMb`, `assertBuildMemoryFits`),
  `core/schema.ts`, `bin/ultra.ts`.
- **Fix:** `doctor --json` adds `disk {tmpFreeMb, workspaceFreeMb, tmpPath}`,
  `fs {homeWritable, cacheWritable}`, `memory {totalMb,
  estimatedPeakMbForProject}`. `ultra build` refuses before frame 0 when the
  estimate exceeds 80% of RAM (`MemoryPreflightError`; `ULTRA_SKIP_MEMORY_CHECK=1`
  is the explicit local override). The estimate is conservative:
  `350 MB + frameRGBA × (3 + 2×motionBlurSamples) + 40 MB × samples`.
- **Test:** phase12 "[4] doctor pre-flights…" (all blocks present with a project
  estimate) and "refuses an oversized fixture before rendering".
- **Muse sees:** OOM becomes a fast, explained refusal.

### [18] ASSET SIMILARITY IS NEVER MEASURED — **FIXED**
- **Files:** `core/similarity.ts` (new), `core/assets.ts`, `core/schema.ts`,
  `bin/ultra.ts`.
- **Fix:** every image-like asset with a target scene (or explicit
  `asset.refSegment`) is compared to the reference segment midpoint:
  size-matched framed-crop SSIM, 24-bucket colour-histogram L1 distance, Sobel
  edge-density ratio. Results are written per asset in `assets.manifest.json`
  (`similarity`), thresholds live in optional `ultra.json.assetSimilarity`
  (default 0.55 SSIM / 0.35 histogram / ±0.5 edge tolerance) and produce
  **warnings, never failures** before build. `asset-plan` items carry a
  `similarityTarget {sceneId,startSec,endSec}`. Existing
  existence/dimension/alpha/SHA-1 validation is untouched.
- **Test:** phase12 "[18] asset content similarity…": a wrong-colour asset is
  flagged (histogram), a matching one is clean, the manifest carries scores, and
  the missing asset's todo entry has the similarity target. Flat plates keep
  structural SSIM high — the histogram term is what catches a wrong photo there;
  real photographs trip both.
- **Muse sees:** it can re-generate a wrong asset **before** a full build.

### [8] NO CLONE-FEASIBILITY WARNING — **FIXED**
- **Files:** `core/probe.ts`, `core/schema.ts`, `bin/ultra.ts`.
- **Fix:** probe writes `cloneFeasibility {score, bitratePerPixel,
  textLegibility (ok|poor|destroyed), sharpnessEstimate, warnings}` using the
  video stream bitrate / resolution / fps and a mid-film edge score. Below the
  threshold it prints, before building: "This reference cannot support exact
  cloning of fine detail — expect a native approximation, not a copy."
- **Test:** phase12 "[8] clone-feasibility…": 736×414 @ 0.38 Mbps triggers it
  (score < 55, text destroyed/poor) and a clean 1080p does not.
- **Muse sees:** it can warn the user before spending the render budget.

---

## P2 — probe, verify, audio: make numbers mean something

### [5] CUT DETECTION MISSES SOFT / GRAPHIC CUTS — **FIXED**
- **Files:** `core/probe.ts`, `core/schema.ts`, `bin/ultra.ts`.
- **Fix:** second pass reuses the `tblend=all_mode=difference` YAVG pipeline with
  an adaptive (median + 4·MAD) local-maximum threshold; writes `softCutsSec` and
  `softCutFrames`. The silent 24-segment cap is gone; `--max-segments <n>` warns
  when it truncates. Per-scene `motionScore` is derived from the same diffs.
- **Test:** phase13 "[5] two-pass probe…": a graphic reconfiguration appears in
  `softCutsSec` with a frame number and NOT in `cutsSec`; the flag prints the
  truncation warning.
- **Muse sees:** fades/reconfigurations become patchable times instead of being
  invisible.

### [6] PROBE HAS NO GEOMETRY — **FIXED**
- **Files:** `core/geometry.ts` (new), `core/probe.ts`, `bin/ultra.ts`.
- **Fix:** `probe --geometry` writes `workspace/geometry.json`
  (`[{segmentIndex, lines:[{orientation,x|y,confidence}], rects, textRegions}]`)
  from edge-projection profiles on a downscaled frame (no OpenCV).
- **Test:** phase13 "[6] probe --geometry…": all six grid lines found within
  ±4 px at 1280×720.
- **Muse sees:** grid/window/text-box measurements without external tooling.

### [7] MEASURED vs GUESSED NOT RECORDED — **FIXED**
- **Files:** `core/schema.ts`, `core/guard.ts`.
- **Fix:** optional scene `source: measured|inferred|guessed` + `evidence?`
  (absence = `guessed`, the honest default). `guard --stage plan` lists every
  guessed scene (timings/layout) as warnings — blocking is unchanged. Optional
  `workspace/measurements.json` is recognized and summarized (never blocks).
- **Test:** phase13 "[7] source annotations…": exactly the one guessed scene is
  listed; measured scenes are not; measurements.json is surfaced.
- **Muse sees:** an explicit list of what it did not measure.

### [23] STUTTER VERIFIER IGNORES REFERENCE HOLDS — **FIXED**
- **Files:** `core/jitter.ts` (`stutterRuns`), `verifier/metrics.ts`
  (`reconcileJitter`), `bin/ultra.ts`, `verifier/scene-verify.ts`,
  `core/schema.ts`.
- **Fix:** verify measures jitter on BOTH draft and reference. A draft stutter
  run overlapping a reference hold/stutter-like run (±3 frames) is not a defect;
  `stutterEvents` now counts only unmatched runs. The report carries
  `jitterDraft`, `jitterReference`, `jitterUnmatchedEvents`; the CLI prints each
  NEW stutter with its timestamp.
- **Test:** phase13 "[23]…": identical freezes pass; an extra 0.1 s freeze fails
  with `atSec ≈ 2.0`. Unit test covers the ±3-frame reconciliation.
- **Muse sees:** designed reference holds stop false-failing; real new freezes
  still fail with a time to patch.

### [25] AUDIT SAMPLES ~9 FRAMES — **FIXED**
- **Files:** `verifier/full-audit.ts` (new), `bin/ultra.ts`, `SPEC.md`,
  `SKILL.md`.
- **Fix:** `verify --full` streams SSIM for every frame (`ssim=stats_file=-`,
  never loads frames into RAM) and reports `{frameCount, mean, p10, worst20}`
  plus `build/audit-frames/worst_*.png` for the five worst pairs. SPEC/SKILL
  state: a claim of "matches reference" requires `--full`; the sampled audit
  remains the fast gate. The report ends with `notChecked[]`.
- **Test:** phase13 "[25]…" frame count equals the draft's `nb_frames`, mean
  > 0.97 with thumbnails; the [27] CLI test asserts `fullAudit.frameCount` on a
  10-frame fixture.
- **Muse sees:** "PASS" no longer implies a full-film match; cite mean/p10/notChecked.

### [26] SSIM REWARDS PLATE REPLAY — **FIXED**
- **Files:** `core/schema.ts` (`meta.method`), `core/guard.ts`,
  `verifier/rubric.ts`, `bin/ultra.ts`, `verifier/scene-verify.ts`, `AGENTS.md`.
- **Fix:** `meta.method: native|plate-replay|mixed` (default native; starter
  template declares native; guard warns when absent on legacy projects). Every
  verify report/rubric prints the method; rubric categories carry per-method
  `expectation` strings. Guard FAILS a `native` project if an asset is the
  reference file (same SHA-1) or matches a reference frame (8×8 aHash distance
  ≤ 6).
- **Test:** phase13 "[26]…": a reference frame used as a native asset fails guard
  with check `method`; native vs plate rubrics differ per category.
- **Documented limit:** arbitrary small crops are not reliably caught by a global
  aHash — stated in guard warnings and SPEC.

### [27] VERIFY PASSES FILMS VIEWERS RATE 4/10 — **FIXED**
- **Files:** `verifier/honesty.ts` (new), `verifier/visual-diff.ts` (easing),
  `bin/ultra.ts`, `verifier/scene-verify.ts`, `core/schema.ts`, `SKILL.md`.
- **Fix:**
  - (a) `verify-report.json` gains scored `assetSimilarity[]` (0-100 composite)
    and `fontCheck {fontsUsed, unavailableFonts, score}`.
  - (b) per-scene easing: dominant-motion centroid curves from draft vs reference
    (96×54 decode) → `curveError` px, `samples`, or `null` + reason when fewer
    than 3 comparable moving frames exist.
  - (c) every report and CLI output ends with `notChecked: [...]` (per-frame SSIM,
    audio sync, font identity, SFX timbre, taste, plate-crop limits, …).
- **Test:** phase13 "[27]…": notChecked/asset/font sections; linear-vs-eased
  curves show a larger error; CLI's last line starts with `notChecked:`.
- **Muse sees:** the report no longer implies coverage it does not have.

### [28] SFX CUES BREAK ON TIMING PATCHES — **FIXED**
- **Files:** `core/schema.ts` (`SfxCue` union), `core/stitcher.ts`
  (`resolveSfxCueTimes`), `core/project.ts`.
- **Fix:** cues accept `atSec` XOR `(sceneId + offsetSec)` (zod superRefine;
  exactly one). The stitcher resolves scene-anchored cues from the scene's
  current `startSec` at stitch time. Old atSec-only projects are schema-valid and
  resolve to exactly the same delay.
- **Test:** phase13 "[28]…": retimed scene moves its cue 0.5→0.6 while the
  atSec-only cue stays at 0.5; invalid both/neither forms throw; two stitches of
  a legacy project produce byte-identical PCM hashes.
- **Muse sees:** no hand re-laying SFX after a patch.

### [29] NO AUDIO-TO-PICTURE SYNC CHECK — **FIXED**
- **Files:** `core/audio-sync.ts` (new), `bin/ultra.ts`, `core/schema.ts`.
- **Fix:** verify cross-correlates draft vs reference 10 ms RMS envelopes and
  reports `audioSyncOffsetMs` (+ correlation); SFX cues farther than 80 ms from
  the nearest probe onset/cut are warnings with the distance.
- **Test:** phase13 "[29]…": a 250 ms delayed draft reports 250 ± 40 ms; a cue
  200 ms off an anchor warns.
- **Muse sees:** lip/beat drift becomes a number, not a feeling.

### [30] SYNTH AUDIO IS UNLABELLED — **FIXED**
- **Files:** `core/schema.ts`, `core/assets.ts`, `core/synth-audio.ts`,
  `bin/ultra.ts`, `core/probe.ts`.
- **Fix:** audio assets carry `origin: synthesised|recorded|licensed|
  user-supplied`. `synthesizeToWav` records every output in
  `.ultra-cache/synth-origins.json`; `validateAssets` labels it `synthesised`
  without agent action (explicit `origin` wins; other files default to
  `user-supplied`). `assets-todo` and `delivery-manifest.audioOrigins` carry the
  labels. Probe adds `containsRealRecording` (mean `aspectralstats` flatness >
  0.18; documented heuristic, never a gate).
- **Test:** phase13 "[30]…": synth WAVs are labelled synthesised in the manifest;
  a missing audio asset's todo entry reports `user-supplied`.
- **Muse sees:** it can say "synth stand-in" instead of pretending timbral match.

---

## P3 — engine expressiveness

### [9] UltraEase PRELUDE ORDER — **FIXED**
- **Files:** `engines/hyperframes/compiler.ts`, `engines/hyperframes/lint.ts`,
  `core/schema.ts` (`runtime` defect category).
- **Fix:** the motion prelude + `__ULTRA_AUDIO` are injected at the TOP of
  `<head>` (before any user script) for both full documents and fragments; the
  runtime keeps the user JS at the tail. Lint adds a critical `runtime` defect
  when a script that reads `UltraEase`/`__ULTRA_AUDIO` appears before the head
  injection point, with the correct `ultraRender` pattern in the message.
- **Test:** phase14 "[9]…": a `<head>` script capturing UltraEase now renders
  animated (box moves > 120 px); the pathological pre-head script fails lint with
  that message.
- **Muse sees:** no more silently unanimated custom scenes.

### [10] VIDEO LAYERS SECOND-CLASS — **FIXED (HyperFrames)**
- **Files:** `core/schema.ts`, `engines/hyperframes/compiler.ts`,
  `engines/hyperframes/index.ts`.
- **Fix:** video layers gain `inSec`, `rate`, `loop`, `objectFit`; the runtime
  seeks `inSec + t·rate` (wraps when `loop`). Optional scene `videoMode:
  "frames"` pre-extracts the range with FFmpeg to `.ultra-cache/video-frames/`
  and frame-steps it for frame-exact playback. Disk cost: one RGBA PNG per
  source frame (documented here and in SPEC). py-canvas/ffmpeg-only do not
  implement video layers beyond `sourceClip` (documented).
- **Test:** phase14 "[10]…": `inSec=2` shows the 2 s (blue) frame, not 0 s (red);
  frames mode matches an FFmpeg extraction at the same instant with SSIM > 0.99.
- **Muse sees:** keyframe-accurate in/out points and deterministic frame stepping.

### [11] MOTION BLUR: CAP 4, TIER-UNEQUAL — **FIXED**
- **Files:** `core/schema.ts` (max 8), `engines/hyperframes/index.ts` (≤ 8),
  `engines/py-canvas/render_scene.py` (≤ 8; the existing subframe
  `Image.blend` blend is equal-weight and matches FFmpeg average), `core/env.ts`
  (doctor warning), `core/orchestrator.ts` (build warning).
- **Fix:** cap raised to 8 in schema + both engines. Doctor states ffmpeg-only
  has NO motion blur. Build warns (log + manifest notes) when the probe's
  measured `motionScore` > 2.5 while `motionBlurSamples === 1`.
- **Test:** phase14 "[11]…": schema accepts 8 / rejects 9; py-canvas samples=2
  differs from samples=1 and matches HyperFrames samples=2 at SSIM > 0.95; the
  build warning fires on a probe-motion fixture.
- **Muse sees:** faster motion is expressible; missing blur is called out.

### [12] MASKS: ONLY 3 CLIP-PATHS — **PARTIAL (HyperFrames + py-canvas complete; ffmpeg-only unsupported)**
- **Files:** `core/schema.ts` (`MaskSpec`), `engines/hyperframes/compiler.ts`
  (clip-path / feathered SVG mask-image, invert), `engines/py-canvas/render_scene.py`
  (Pillow mask + GaussianBlur, invert), `core/orchestrator.ts` (ffmpeg-only note).
- **Fix:** layers and `clipReveal` accept `mask {type rect|circle|polygon|
  svg-path, pointsOrPath, featherPx, invert, centerXPercent/YPercent}`; text
  elements accept a mask too. Feathered masks use an SVG `feGaussianBlur` mask;
  no-feather uses `clip-path`. py-canvas renders masks with Pillow and blurs the
  mask for feather. **ffmpeg-only does not implement masks (rect/circle
  included)** — this is logged in build notes and documented in SPEC; that tier
  never silently ignores it.
- **Test:** phase14 "[12]…": a feathered circle mask yields > 3 intermediate grey
  levels across the edge (no hard step).
- **Reason for PARTIAL:** implementing even rect/circle masks inside the pure
  drawtext/drawbox filtergraph would need per-layer alpha geq compositing that
  this tier does not have; doing it silently would violate the "document the
  limit" rule.

### [13] BLEND MODES + PARALLAX — **FIXED**
- **Files:** `core/schema.ts`, `engines/hyperframes/compiler.ts` (`add` →
  `plus-lighter`), HyperFrames runtime (per-layer parallax compensation),
  `engines/py-canvas/render_scene.py` (ImageChops add/screen/multiply/
  difference/overlay; soft-light/hard-light fall back to overlay where Pillow
  lacks them — documented), `SPEC.md` §15.
- **Fix:** `blend` adds `add|soft-light|hard-light|difference`; layers get
  `parallaxDepth (0..1)` and the camera rig scales that layer's pan by
  `(1 − depth·0.5)` in both engines. SPEC gains a "Cannot express" section
  (optical flow, true 3D, rotoscope) so agents stop promising them.
- **Test:** phase14 "[13]…": front (depth 0) and back (depth 1) layers move by
  clearly different pixel amounts under the same 200 px pan; compiled CSS maps
  `add` to `plus-lighter`.
- **Muse sees:** real depth separation and honest limits.

### [14] FONT MATCHING IS GUESSWORK — **FIXED**
- **Files:** `core/font-match.ts` (new), `bin/ultra.ts`, `core/schema.ts`
  (font enum ∪ `{family}`), `verifier/honesty.ts` (verify font availability).
- **Fix:** `ultra font-match <image> [--candidates <dir>] [--text <text>]`
  renders every bundled/workspace/extra candidate with FFmpeg drawtext at the
  image's measured ink height and ranks by width profile (SSIM when `--text` is
  given). Output JSON: `[{family, file, widthErrorPercent, ssim, inkWidthPx}]`.
  Runs offline.
- **Test:** phase14 "[14]…": a synthetic condensed image (source font scaled
  0.7× horizontally) ranks that (narrowest) candidate #1 and reports a numeric
  `widthErrorPercent`.
- **Muse sees:** stop guessing typefaces.

### [15] NO FONT-STRETCH — **FIXED**
- **Files:** `core/schema.ts` (`fontStretchPercent 50..200`,
  `fontVariationSettings`), `engines/hyperframes/compiler.ts` (CSS), py-canvas
  (documented ignore + stderr log), `engines/hyperframes/lint.ts`.
- **Fix:** text elements honor `fontStretchPercent` / `fontVariationSettings` in
  HyperFrames. Lint adds a non-critical warning when custom-scene CSS uses
  `transform: scaleX(...)` on a text-ish selector: "condensing by transform
  distorts letterforms — use a condensed font, fontStretchPercent, or
  `ultra font-match`".
- **Test:** phase14 "[15]…": the warning fires on `.headline{scaleX}` and never
  on `.logo{scaleX}`; compiled HTML contains `font-stretch:80%`.
- **Muse sees:** honest condensing instead of distorted glyphs.

### [16] COLOUR ROUND-TRIP NEVER CHECKED — **FIXED**
- **Files:** `verifier/colour.ts` (new), `bin/ultra.ts`, `core/schema.ts`.
- **Fix:** verify renders each palette colour as a solid swatch through the
  normal engine → stitch grade → yuv420p bt709 encode, decodes the centre pixel,
  and reports CIE76 ΔE per colour (method stated). Warns at ΔE > 3; no
  auto-correction.
- **Test:** phase13 "[16]…": identity grade ΔE < 3 for both colours; a
  saturation/exposure/temperature shift produces ΔE > 3.
- **Muse sees:** encoded colours are proven, not assumed.

### [17] NO GUIDES / ANCHORS — **FIXED**
- **Files:** `core/schema.ts` (`GuideSpec`, `AnchorSpec`), HyperFrames compiler +
  runtime (resolve before other transforms), py-canvas `resolve_positions`,
  `engines/hyperframes/lint.ts` (overlap heuristic), `core/orchestrator.ts`
  (ffmpeg-only warning).
- **Fix:** scene `guides[{id, orientation, keyframes[atSec, positionPx,
  easing]}]`; layers/text `anchor {to: "guide:<id>"|"layer:<id>", dx, dy}`.
  Effective x/y = target's current position + dx/dy, resolved per frame before
  keyframe transforms. Lint warns (±12 px simple heuristic) when an unanchored
  element tracks a guide. ffmpeg-only ignores anchors with a logged warning.
- **Test:** phase14 "[17]…": moving the guide 100→300 moves the anchored shape
  and leaves the unanchored shape put; lint warns only about the unanchored one.
- **Muse sees:** stop hand-coding guide relationships.

### [3] BUNDLE PROVENANCE — **FIXED**
- **Files:** `scripts/pack-cloud.ts` (commit banner + external source map),
  `core/env.ts` (`bundleProvenance`), `core/schema.ts`, `bin/ultra.ts`,
  `.gitignore`, `.github/workflows/ci.yml`.
- **Fix:** `dist/ultra.mjs` starts with `/* ultra-bundle-commit: <sha> */` and
  `dist/ultra.mjs.map` is shipped. `doctor --json` reports `bundleCommit` and
  `sourceMatchesBundle` (false inside the cloud zip, where there is no git).
  CI job `dist-check` rebuilds and fails if the committed
  `dist/ultra.mjs|.map|rag-index.json` differ. **Zip excluded** from the diff
  because archive timestamps/compression bytes are not reproducible; the
  one-line **bundle-commit banner is excluded** because a rebuild necessarily
  embeds the commit being built (self-reference). A dist-only follow-up commit is
  expected: `sourceMatchesBundle` also accepts "same source tree excluding dist"
  (git diff between the bundled commit and HEAD ignoring `dist/`).
- **Test:** phase14 "[3]…": after `npm run pack:cloud`, the bundle contains the
  git HEAD and doctor reports it with `sourceMatchesBundle: true`.
- **Extra determinism fix (required for the CI diff):** `dist/rag-index.json`
  embedded `new Date().toISOString()`, so two packs were never byte-identical.
  `builtAt` is now `sha1:<content-hash>` and every directory walk is sorted; two
  consecutive packs produce identical `ultra.mjs`, `ultra.mjs.map` and
  `rag-index.json` (verified locally with sha1sum).
- **Muse sees:** a bundle can be traced to a commit.

### [22] ALWAYS-ON CONTACT SHEET — **FIXED**
- **Files:** `core/contact-sheet.ts` (new; shared HTML + browser/FFmpeg
  renderer), `core/probe.ts` (uses the shared HTML), `core/orchestrator.ts`,
  `core/preview.ts`.
- **Fix:** full builds, `build --scene`, and `preview --from/--to` all
  (re)generate `build/contact-sheet.png` from the current draft/preview. No GUI.
- **Test:** phase12 [21]/[22] test asserts `build/contact-sheet.png` exists with
  an mtime newer than the build start; phase12 [20] range test asserts the same.
- **Muse sees:** a visual index every build without a timeline editor.

---

## Muse MIGRATION NOTES

**STOP doing:**
- `ultra patch` + bumping scene names/ids to defeat the cache — `fix/muse-30` hashes `customHtmlFile` contents (`CACHE_VERSION 5`).
- Measuring whole-film SSIM externally — run `ultra verify <ref> --full` and quote `fullAudit` + `notChecked`.
- External cut detection — trust `probe.json` hard cuts + `softCutsSec`/`softCutFrames`.
- Hand re-laying SFX after a retime — anchor cues: `"sfxCue": {"assetId":"hit","sceneId":"s2","offsetSec":0.1}`.
- Guessing fonts from a screenshot — run `ultra font-match <image> --text "…"`.
- Rewriting a scene and rebuilding the film — use the scene loop.
- Claiming a clone "matches" from a PASS alone — the report's `notChecked[]` is part of the evidence.
- Calling synthesised audio "the reference sound" — quote `origin` / `containsRealRecording`.

**START doing (exact commands):**
- `ultra preview --frame 120 --ref reference.mp4`
- `ultra preview --from 90 --to 150 --ref reference.mp4`
- `ultra build --scene hero && ultra verify --scene hero reference.mp4`
- `ultra probe reference.mp4 --geometry`
- `ultra verify reference.mp4 --full`
- `ultra font-match ref-title.png --text "LILIUM" --candidates workspace/assets/fonts`
- `ultra validate-assets` before every build (asset similarity warnings)
- `ultra doctor --json` once per VM; then `ultra doctor` only when paths change (it persists `browserPath`).

---

## Git sequence used (local branch `fix/muse-30-problems`, NOT pushed)

```
1. fix(P0): hash customHtmlFile in cache key + video-stream duration validation
2. fix(P1): preview/build-scene/verify-scene loop, sandbox preflight, asset similarity, feasibility
3. fix(P2): two-pass probe, geometry, honest verify, jitter-vs-reference, audio sync, labels
4. fix(P3): prelude order, video frames, masks/blend/parallax, font tools, guides, provenance, contact sheet (+ FIX_REPORT/SPEC/README/SKILL/AGENTS, packed dist)
5. chore(dist): repack the cloud bundle at the P3 commit (dist/ultra.mjs + map only)
```

Hashes are in `git log --oneline` on the branch. Commit 5 exists because the
bundle must embed the commit *before* it can be committed; `doctor` accepts that
dist-only follow-up as `sourceMatchesBundle: true` (same source tree excluding
`dist/`).

## Validation evidence (local machine, Windows 11, Chrome/Edge, FFmpeg 9, Python 3.15)

- `npm run typecheck` → clean (tsc, no output).
- `npm test` → **14 test files passed, 71 tests passed (71)**; Python mock-bpy:
  `Ran 5 tests ... OK`; process exit 0. This includes every pre-existing phase
  1–11 suite and the 46 new regression tests in phases 12–14.
- `npm run pack:cloud` → tsc + esbuild bundle **866.1 KiB** + external
  **ultra.mjs.map** (3.5 MiB, not zipped) + `rag-index.json` (41 docs) +
  `dist/ultra-workflow-cloud.zip` **947.6 KiB (0.93 MiB)**, LF-normalized, under
  the 2.5 MiB cap. Two consecutive packs are byte-identical (banner aside).
- Repo: branch `fix/muse-30-problems`, no push, no PR.
