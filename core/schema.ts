import { z } from "zod";

/* ============================================================================
 * Shared primitives
 * ========================================================================== */

export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "must be a hex color (#rgb, #rrggbb or #rrggbbaa)");

export const EasingName = z.enum([
  "linear",
  "easeInQuad",
  "easeOutQuad",
  "easeInOutQuad",
  "easeInCubic",
  "easeOutCubic",
  "easeInOutCubic",
  "easeOutBack",
  "easeOutExpo",
  "easeInOutSine",
]);

export const EngineName = z.enum(["hyperframes", "remotion", "revideo", "blender"]);

/* ============================================================================
 * Motion primitives
 * ========================================================================== */

export const RevealSpec = z.object({
  mode: z.enum(["none", "chars", "words", "lines"]).default("none"),
  staggerSec: z.number().min(0).max(2).default(0.03),
  durationSec: z.number().positive().max(5).default(0.5),
  delaySec: z.number().min(0).max(30).default(0),
  from: z.enum(["up", "down", "left", "right"]).default("up"),
  distancePx: z.number().min(0).max(400).default(40),
  easing: EasingName.default("easeOutCubic"),
  mask: z.boolean().default(true),
});

export const CameraKeyframe = z.object({
  atSec: z.number().min(0),
  rotateX: z.number().min(-120).max(120).optional(),
  rotateY: z.number().min(-120).max(120).optional(),
  rotateZ: z.number().min(-180).max(180).optional(),
  zoom: z.number().min(0.1).max(6).optional(),
  panX: z.number().min(-4000).max(4000).optional(),
  panY: z.number().min(-4000).max(4000).optional(),
  ease: EasingName.default("easeInOutCubic"),
});

export const CameraRig = z.object({
  perspectivePx: z.number().min(200).max(6000).default(1200),
  keyframes: z.array(CameraKeyframe).default([]),
});

export const MaskSpec = z.object({
  type: z.enum(["rect", "circle", "polygon", "svg-path"]),
  /** rect: "x,y,w,h"; circle: radius px; polygon: "x1,y1 x2,y2 ..."; svg-path: SVG `d`. */
  pointsOrPath: z.string().default(""),
  featherPx: z.number().min(0).max(200).default(0),
  invert: z.boolean().default(false),
  centerXPercent: z.number().min(0).max(100).default(50),
  centerYPercent: z.number().min(0).max(100).default(50),
});

export const AnchorSpec = z.object({
  to: z.string().min(1), // "guide:<id>" | "layer:<id>"
  dx: z.number().default(0),
  dy: z.number().default(0),
});

export const GuideSpec = z.object({
  id: z.string().min(1),
  orientation: z.enum(["v", "h"]),
  keyframes: z
    .array(
      z.object({
        atSec: z.number().min(0),
        positionPx: z.number(),
        easing: EasingName.default("easeInOutCubic"),
      }),
    )
    .min(1),
});

export const ClipRevealSpec = z.object({
  type: z.enum(["none", "wipe", "iris", "diagonal"]).default("none"),
  durationSec: z.number().positive().max(5).default(0.7),
  delaySec: z.number().min(0).max(30).default(0),
  /** [12] Optional feathered mask shaping the reveal. */
  mask: MaskSpec.optional(),
});

export const CustomCode = z.object({
  html: z.string().default(""),
  css: z.string().default(""),
  js: z.string().default(""),
});

/** Trimmed segment of the user's own footage (Process 2B — Edit My Video in Style). */
export const SourceClipSpec = z
  .object({
    path: z.string().min(1),
    inSec: z.number().min(0),
    outSec: z.number().positive(),
    muteSourceAudio: z.boolean().default(false),
    jCutLeadSec: z.number().min(0).max(5).default(0),
    lCutTrailSec: z.number().min(0).max(5).default(0),
    scale: z.number().min(0.2).max(4).default(1),
    panX: z.number().min(-4000).max(4000).default(0),
    panY: z.number().min(-4000).max(4000).default(0),
    cropMode: z.enum(["cover", "contain"]).default("cover"),
  })
  .superRefine((clip, ctx) => {
    if (clip.outSec <= clip.inSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `sourceClip outSec (${clip.outSec}) must be greater than inSec (${clip.inSec})`,
        path: ["outSec"],
      });
    }
  });

export type SourceClipSpecT = z.infer<typeof SourceClipSpec>;

/* ============================================================================
 * Project contract — workspace/ultra.json
 * ========================================================================== */

export const KeyframeTrack = z.object({
  target: z.string().min(1),
  property: z.enum(["x", "y", "opacity", "scale", "rotation", "blur"]),
  keyframes: z
    .array(
      z.object({
        atSec: z.number().min(0),
        value: z.number(),
        ease: EasingName.default("easeInOutCubic"),
      }),
    )
    .min(2),
});

export const LayerSpec = z
  .object({
    id: z.string().min(1),
    type: z.enum(["image", "video", "svg", "png_alpha", "shape", "grain", "vignette"]),
    assetId: z.string().optional(),
    color: HexColor.optional(),
    x: z.number().default(0),
    y: z.number().default(0),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    opacity: z.number().min(0).max(1).default(1),
    rotation: z.number().default(0),
    radius: z.number().min(0).default(0),
    blend: z.enum(["normal", "screen", "overlay", "multiply", "add", "soft-light", "hard-light", "difference"]).default("normal"),
    glass: z.boolean().default(false),
    svgDraw: z.boolean().default(false),
    drawDelaySec: z.number().min(0).max(30).default(0),
    drawDurationSec: z.number().positive().max(30).default(1.2),
    /** [10] Video layer parity with sourceClip (video layers only). */
    inSec: z.number().min(0).default(0),
    rate: z.number().min(0.25).max(4).default(1),
    loop: z.boolean().default(false),
    objectFit: z.enum(["cover", "contain"]).default("cover"),
    /** [12] Optional per-layer mask. */
    mask: MaskSpec.optional(),
    /** [13] 2.5D parallax separation (0 = glued to the camera, 1 = half pan). */
    parallaxDepth: z.number().min(0).max(1).default(0),
    /** [17] Anchor this layer to a guide or another layer. */
    anchor: AnchorSpec.optional(),
  })
  .superRefine((layer, ctx) => {
    if (["image", "video", "svg", "png_alpha"].includes(layer.type) && !layer.assetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `layer "${layer.id}" of type "${layer.type}" requires assetId`,
        path: ["assetId"],
      });
    }
    if (layer.type === "shape" && !layer.color) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `layer "${layer.id}" of type "shape" requires a color`,
        path: ["color"],
      });
    }
  });

export const TextFont = z.union([
  z.enum(["heading", "body", "mono"]),
  z.object({ family: z.string().min(1) }),
]);

export const TextElementSpec = z.object({
  id: z.string().min(1),
  text: z.string(),
  font: TextFont.default("body"),
  sizePx: z.number().positive(),
  color: HexColor,
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  align: z.enum(["left", "center", "right"]).default("left"),
  weight: z.number().int().min(100).max(900).optional(),
  letterSpacingPx: z.number().default(0),
  lineHeight: z.number().positive().default(1.2),
  uppercase: z.boolean().default(false),
  reveal: RevealSpec.default({}),
  /** [15] Honest condensing: never by transform: scaleX. */
  fontStretchPercent: z.number().min(50).max(200).optional(),
  fontVariationSettings: z.string().optional(),
  /** [12] Optional text mask. */
  mask: MaskSpec.optional(),
  /** [17] Anchor this text element to a guide or layer. */
  anchor: AnchorSpec.optional(),
});

export const EffectSpec = z.object({
  type: z.enum(["grain", "vignette", "blur", "glow", "chromatic", "halftone"]),
  intensity: z.number().min(0).max(1).default(0.25),
});

export const TransitionSpec = z.object({
  type: z.enum(["none", "fade", "wipeleft", "wiperight", "slideup", "circleopen"]).default("none"),
  durationSec: z.number().min(0).max(2).default(0),
});

export const SceneSpec = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    startSec: z.number().min(0),
    endSec: z.number().positive(),
    engine: EngineName,
    overlayOfSceneId: z.string().optional(),
    alpha: z.boolean().default(false),
    transitionIn: TransitionSpec.default({}),
    background: z.union([HexColor, z.literal("transparent")]).default("#000000"),
    layers: z.array(LayerSpec).default([]),
    keyframes: z.array(KeyframeTrack).default([]),
    textElements: z.array(TextElementSpec).default([]),
    effects: z.array(EffectSpec).default([]),
    enginePayload: z.record(z.unknown()).default({}),
    customHtmlFile: z.string().optional(),
    customCode: CustomCode.optional(),
    motionBlurSamples: z.number().int().min(1).max(8).default(1),
    camera: CameraRig.default({}),
    clipReveal: ClipRevealSpec.default({}),
    sourceClip: SourceClipSpec.optional(),
    /** [10] "seek" (default, compatible) or "frames" (FFmpeg PNG sequence). */
    videoMode: z.enum(["seek", "frames"]).default("seek"),
    /** [17] Scene-level guides that layers/text can anchor to. */
    guides: z.array(GuideSpec).default([]),
    /** Optional workspace-relative captions JSON (default: workspace/captions.json on sourceClip scenes). */
    captionsFile: z.string().optional(),
    /**
     * [7] Honesty annotation: was this scene measured from the reference,
     * inferred from a pattern, or guessed? Absent defaults to "guessed".
     */
    source: z.enum(["measured", "inferred", "guessed"]).optional(),
    evidence: z.string().optional(),
  })
  .superRefine((scene, ctx) => {
    if (scene.endSec <= scene.startSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scene "${scene.id}" endSec (${scene.endSec}) must be greater than startSec (${scene.startSec})`,
        path: ["endSec"],
      });
    }
    if (scene.alpha && scene.overlayOfSceneId === undefined) {
      // alpha scenes are overlays; they must be declared as such so the stitcher composites them.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scene "${scene.id}" is alpha but has no overlayOfSceneId`,
        path: ["overlayOfSceneId"],
      });
    }
    if (scene.customHtmlFile !== undefined && scene.customCode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scene "${scene.id}" cannot set both customHtmlFile and customCode`,
        path: ["customCode"],
      });
    }
    if (scene.customHtmlFile !== undefined) {
      const file = scene.customHtmlFile;
      if (file.trim().length === 0 || file.includes("..") || file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(file)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene "${scene.id}" customHtmlFile must be a relative path inside workspace/scenes/`,
          path: ["customHtmlFile"],
        });
      }
    }
    if (scene.captionsFile !== undefined) {
      const file = scene.captionsFile;
      if (file.trim().length === 0 || file.includes("..") || file.startsWith("/") || file.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(file)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `scene "${scene.id}" captionsFile must be a relative path inside the workspace`,
          path: ["captionsFile"],
        });
      }
    }
    if ((scene.customHtmlFile !== undefined || scene.customCode !== undefined) && scene.engine !== "hyperframes") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scene "${scene.id}" uses custom HTML but engine is "${scene.engine}" — custom scenes render through the hyperframes engine`,
        path: ["engine"],
      });
    }
  });

export const AssetType = z.enum([
  "image",
  "video",
  "svg",
  "png_alpha",
  "illustration",
  "sfx",
  "music",
  "voice",
  "3d_graph",
]);

export const AssetSpec = z
  .object({
    id: z.string().min(1),
    type: AssetType,
    description: z.string().min(1),
    prompt: z.string().min(1),
    negativePrompt: z.string().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationSec: z.number().positive().optional(),
    requireAlpha: z.boolean().optional(),
    targetPath: z.string().min(1),
    /** Optional explicit reference window this asset replaces (defaults to its target scene). */
    refSegment: z
      .object({ startSec: z.number().min(0), endSec: z.number().positive() })
      .optional(),
    /** Provenance label for audio assets (synth-audio writes are auto-labelled "synthesised"). */
    origin: z.enum(["synthesised", "recorded", "licensed", "user-supplied"]).optional(),
  })
  .superRefine((asset, ctx) => {
    if (asset.type === "png_alpha" && asset.requireAlpha === false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `asset "${asset.id}" is png_alpha and cannot set requireAlpha=false`,
        path: ["requireAlpha"],
      });
    }
  });

export const DesignTokens = z.object({
  palette: z.record(HexColor),
  fonts: z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
    mono: z.string().min(1),
  }),
  grainOpacity: z.number().min(0).max(1).default(0.06),
  antiSlopRules: z.array(z.string()).default([]),
});

export const ColorGrade = z.object({
  lutPath: z.string().optional(),
  exposure: z.number().min(-2).max(2).default(0),
  contrast: z.number().min(-2).max(2).default(0),
  saturation: z.number().min(0).max(3).default(1),
  temperature: z.number().min(-1).max(1).default(0),
  vignette: z.number().min(0).max(1).default(0),
});

/**
 * [28] SFX cue: absolute `atSec` OR scene-anchored `sceneId + offsetSec`.
 * Scene-anchored cues follow the scene when it is retimed.
 */
export const SfxCue = z
  .object({
    assetId: z.string().min(1),
    atSec: z.number().min(0).optional(),
    sceneId: z.string().min(1).optional(),
    offsetSec: z.number().optional(),
    gainDb: z.number().default(0),
  })
  .superRefine((cue, ctx) => {
    const hasAbsolute = cue.atSec !== undefined;
    const hasScene = cue.sceneId !== undefined && cue.offsetSec !== undefined;
    if (hasAbsolute === hasScene) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `sfx cue for "${cue.assetId}" must set EXACTLY ONE of atSec OR (sceneId + offsetSec)`,
        path: ["atSec"],
      });
    }
  });

export const AudioSpec = z.object({
  targetLufs: z.number().min(-70).max(0).default(-14),
  musicAssetId: z.string().optional(),
  voiceAssetId: z.string().optional(),
  duckingDb: z.number().min(-60).max(0).default(-12),
  sfxCues: z.array(SfxCue).default([]),
});

export type SfxCueT = z.infer<typeof SfxCue>;

export const AspectProfile = z.enum(["9:16", "16:9", "1:1"]);
export type AspectProfileT = z.infer<typeof AspectProfile>;

export const MetaSpec = z.object({
  title: z.string().min(1),
  sourceVideoPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  durationSec: z.number().positive(),
  /** Optional platform aspect lock: enables social UI safe-zone linting. */
  aspectProfile: AspectProfile.optional(),
  /** Delivery master target; proxy builds still iterate at lower resolution. */
  deliveryResolution: z.enum(["4k", "1080p"]).optional(),
  /** Active workflow: pre-prod approval is required ONLY for edit-in-style. */
  processMode: z.enum(["extract-style", "clone-reference", "edit-in-style"]).optional(),
  /**
   * [26] How similarity is achieved. "native" (default for new projects) bans
   * reference frames as assets; "plate-replay" reuses reference frames.
   */
  method: z.enum(["native", "plate-replay", "mixed"]).optional(),
});

export const UltraProject = z.object({
  meta: MetaSpec,
  designTokens: DesignTokens,
  colorGrade: ColorGrade.default({}),
  audio: AudioSpec.default({}),
  assets: z.array(AssetSpec).default([]),
  scenes: z.array(SceneSpec).min(1),
  /**
   * [18] Asset ↔ reference similarity thresholds. Defaults WARN (never fail)
   * so a wrong-looking asset is surfaced before build, not after a 4/10 review.
   */
  assetSimilarity: z
    .object({
      minSsim: z.number().min(0).max(1).default(0.55),
      maxHistogramDistance: z.number().min(0).max(1).default(0.35),
      edgeRatioTolerance: z.number().min(0).max(1).default(0.5),
    })
    .default({}),
});

export type UltraProjectT = z.infer<typeof UltraProject>;
export type SceneSpecT = z.infer<typeof SceneSpec>;
export type AssetSpecT = z.infer<typeof AssetSpec>;
export type KeyframeTrackT = z.infer<typeof KeyframeTrack>;
export type ColorGradeT = z.infer<typeof ColorGrade>;

/* ============================================================================
 * Patch contract — workspace/patch.json
 * ========================================================================== */

export const PatchSpec = z.object({
  patches: z
    .array(
      z.object({
        sceneId: z.string().min(1),
        reason: z.string().default(""),
        changes: z.record(z.unknown()),
      }),
    )
    .min(1),
});

export type PatchSpecT = z.infer<typeof PatchSpec>;

/* ============================================================================
 * Probe contract — workspace/probe.json
 * ========================================================================== */

export const ScenePalette = z.object({
  index: z.number().int().min(0),
  startSec: z.number(),
  endSec: z.number(),
  colors: z.array(z.object({ hex: HexColor, share: z.number().min(0).max(1) })),
  avgLuminance: z.number().min(0).max(1),
  contrast: z.number().min(0).max(1),
  /** Mean per-frame YAVG difference inside the segment (motion energy proxy). */
  motionScore: z.number().min(0).default(0),
});

export const ProbeFrame = z.object({
  path: z.string(),
  atSec: z.number(),
  label: z.string(),
  cutIndex: z.number().int().nullable().default(null),
  sceneIndex: z.number().int().min(0).default(0),
  swatches: z.array(HexColor).default([]),
});

export const ProbeResult = z.object({
  sourcePath: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.object({
    rational: z.string(),
    numeric: z.number().positive(),
  }),
  durationSec: z.number().positive(),
  pixelFormat: z.string(),
  audio: z
    .object({
      codec: z.string(),
      sampleRate: z.number().positive(),
      channels: z.number().positive(),
    })
    .nullable(),
  cutsSec: z.array(z.number()),
  /** Soft/graphic reconfigurations found by the second probe pass (no hard cut). */
  softCutsSec: z.array(z.number()).default([]),
  /** Soft cuts with their frame numbers, for exact patching. */
  softCutFrames: z
    .array(z.object({ atSec: z.number(), frame: z.number().int().min(0) }))
    .default([]),
  onsetsSec: z.array(z.number()),
  frames: z.array(ProbeFrame),
  contactSheets: z.array(z.string()),
  scenes: z.array(ScenePalette).default([]),
  audioEnvelopePath: z.string().nullable().default(null),
  /** [8] Honest quality floor: what this reference can/cannot support cloning. */
  cloneFeasibility: z
    .object({
      score: z.number().min(0).max(100),
      bitratePerPixel: z.number().min(0),
      textLegibility: z.enum(["ok", "poor", "destroyed"]),
      sharpnessEstimate: z.number().min(0),
      warnings: z.array(z.string()).default([]),
    })
    .optional(),
  /** [30] Simple documented heuristic — not a classifier. */
  containsRealRecording: z.boolean().optional(),
});

export const AudioEnvelope = z.object({
  fps: z.number().positive(),
  durationSec: z.number().positive(),
  frames: z.array(z.number().min(0).max(1)),
  beatsSec: z.array(z.number().min(0)),
});

export type ProbeResultT = z.infer<typeof ProbeResult>;

/* ============================================================================
 * Assets manifest
 * ========================================================================== */

export const AssetCheck = z.object({
  id: z.string(),
  targetPath: z.string(),
  exists: z.boolean(),
  bytes: z.number(),
  sha1: z.string().nullable(),
  valid: z.boolean(),
  status: z.string(),
  /** [18] content similarity to the reference segment this asset replaces. */
  similarity: z
    .object({
      sceneId: z.string(),
      startSec: z.number(),
      endSec: z.number(),
      ssimToRefSegment: z.number().nullable(),
      histogramDistance: z.number().nullable(),
      edgeDensityRatio: z.number().nullable(),
      warnings: z.array(z.string()).default([]),
    })
    .nullable()
    .optional(),
  /** [30] audio provenance carried into the delivery manifest. */
  origin: z.enum(["synthesised", "recorded", "licensed", "user-supplied"]).optional(),
});

export const AssetManifest = z.object({
  generatedAt: z.string(),
  assets: z.record(AssetCheck),
});

export const AssetTodo = z.object({
  generatedAt: z.string(),
  complete: z.boolean(),
  missing: z.array(
    z.object({
      id: z.string(),
      type: AssetType,
      description: z.string(),
      prompt: z.string(),
      negativePrompt: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      durationSec: z.number().optional(),
      requireAlpha: z.boolean().optional(),
      targetPath: z.string(),
      instruction: z.string(),
      origin: z.enum(["synthesised", "recorded", "licensed", "user-supplied"]).optional(),
      similarityTarget: z
        .object({ sceneId: z.string(), startSec: z.number(), endSec: z.number() })
        .optional(),
      chatgptStrategy: z
        .enum(["native-image", "native-image-plus-2.5d-rig", "ultra-synth-audio", "python-authored"])
        .optional(),
      synthPreset: z
        .object({
          preset: z.string(),
          bpm: z.number().optional(),
          mood: z.enum(["dark", "upbeat", "tech", "minimal"]).optional(),
          durationSec: z.number().optional(),
        })
        .optional(),
    }),
  ),
});

export type AssetTodoT = z.infer<typeof AssetTodo>;

/* ============================================================================
 * Verify report — build/verify-report.json
 * ========================================================================== */

export const DefectCategory = z.enum([
  "clip",
  "overlap",
  "contrast",
  "brokenMedia",
  "blankFrame",
  "palette",
  "layout",
  "runtime",
]);

export const LintDefect = z.object({
  category: DefectCategory,
  sceneId: z.string(),
  frameIndex: z.number(),
  critical: z.boolean(),
  detail: z.string(),
});

export const RubricItem = z.object({
  id: z.string(),
  label: z.string(),
  checked: z.boolean().nullable().default(null),
});

export const RubricCategory = z.object({
  id: z.string(),
  name: z.string(),
  maxPoints: z.number(),
  items: z.array(RubricItem),
  score: z.number().nullable().default(null),
  /** [26] Per-method expectation — never one comparable number across methods. */
  expectation: z.string().optional(),
});

const JitterSummary = z.object({
  stutterEvents: z.number(),
  stutterFrames: z.number(),
  staticHoldFrames: z.number(),
  maxStaticHoldSec: z.number(),
});

export const VerifyReport = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  reference: z.string(),
  draft: z.string(),
  projectDurationSec: z.number(),
  quantitative: z.object({
    durationDeltaSec: z.number(),
    durationOk: z.boolean(),
    fpsExpected: z.number(),
    fpsActual: z.number().nullable(),
    fpsOk: z.boolean(),
    cfr: z.boolean(),
    cfrOk: z.boolean(),
    duplicateRatio: z.number().nullable(),
    staticHoldFrames: z.number().int().min(0),
    staticHoldRatio: z.number().min(0).max(1),
    stutterEvents: z.number().int().min(0),
    stutterFrames: z.number().int().min(0),
    jitterRatio: z.number().min(0).max(1),
    maxStaticHoldSec: z.number().min(0).default(0),
    jitterOk: z.boolean(),
    blackDetections: z.array(z.object({ startSec: z.number(), endSec: z.number() })),
    blackOk: z.boolean(),
    loudness: z
      .object({
        inputI: z.number().nullable(),
        inputTp: z.number().nullable(),
        targetLufs: z.number(),
        ok: z.boolean(),
      })
      .nullable(),
    pass: z.boolean(),
  }),
  lint: z.object({
    scenes: z.array(
      z.object({
        sceneId: z.string(),
        defects: z.array(LintDefect),
        pass: z.boolean(),
      }),
    ),
    defectCount: z.number(),
    criticalDefectCount: z.number(),
    pass: z.boolean(),
  }),
  visualPairs: z.array(
    z.object({
      index: z.number(),
      path: z.string(),
      timestampSec: z.number(),
      sceneId: z.string(),
      ssim: z.number().nullable().default(null),
    }),
  ),
  sceneSimilarity: z
    .array(
      z.object({
        index: z.number(),
        timestampSec: z.number(),
        sceneId: z.string(),
        ssim: z.number().nullable(),
        mae: z.number().nullable(),
      }),
    )
    .default([]),
  rubric: z.object({
    passThreshold: z.number(),
    categories: z.array(RubricCategory),
    totalScore: z.number().nullable().default(null),
    method: z.string().optional(),
  }),
  /** [26] Declared similarity method (also printed in every report). */
  method: z.enum(["native", "plate-replay", "mixed"]).optional(),
  /** [23] Draft vs reference jitter reconciliation. */
  jitterDraft: JitterSummary.optional(),
  jitterReference: JitterSummary.optional(),
  jitterUnmatchedEvents: z
    .array(z.object({ startFrame: z.number().int().min(0), length: z.number().int().min(0), atSec: z.number() }))
    .default([]),
  /** [27a] Scored honesty sections. */
  assetSimilarity: z
    .array(
      z.object({
        assetId: z.string(),
        sceneId: z.string().nullable(),
        ssim: z.number().nullable(),
        histogramDistance: z.number().nullable(),
        edgeDensityRatio: z.number().nullable(),
        warnings: z.array(z.string()).default([]),
        /** 0..100 composite (SSIM 60 + histogram 25 + edge closeness 15). */
        score: z.number().min(0).max(100).nullable().optional(),
      }),
    )
    .optional(),
  fontCheck: z
    .object({
      fontsUsed: z.array(z.string()),
      unavailableFonts: z.array(z.string()),
      score: z.number().min(0).max(100),
    })
    .optional(),
  /** [27b] Per-scene easing curve error (px); null = not measurable. */
  easing: z
    .array(
      z.object({
        sceneId: z.string(),
        curveError: z.number().nullable(),
        samples: z.number().int().min(0),
        note: z.string().optional(),
      }),
    )
    .optional(),
  /** [16] sRGB → encode → decode colour round-trip per palette colour. */
  colour: z
    .array(
      z.object({
        name: z.string(),
        intendedHex: z.string(),
        measuredHex: z.string(),
        deltaE: z.number(),
        method: z.literal("CIE76"),
      }),
    )
    .optional(),
  /** [29] Cross-correlation of draft vs reference audio envelopes. */
  audioSyncOffsetMs: z.number().nullable().optional(),
  sfxWarnings: z
    .array(z.object({ assetId: z.string(), atSec: z.number(), nearestSec: z.number().nullable(), distanceMs: z.number() }))
    .optional(),
  /** [25] verify --full: every-frame SSIM. */
  fullAudit: z
    .object({
      frameCount: z.number().int().min(0),
      mean: z.number().nullable(),
      p10: z.number().nullable(),
      worst20: z.array(z.object({ frame: z.number().int().min(0), timestampSec: z.number(), ssim: z.number() })),
    })
    .optional(),
  /** [27c] Everything this gate did NOT verify. A PASS with a long list is honest. */
  notChecked: z.array(z.string()).default([]),
  style: z
    .object({
      slug: z.string(),
      compliance: z.object({
        aslOk: z.boolean(),
        staticHoldOk: z.boolean(),
        transitionsOk: z.boolean(),
        paletteOk: z.boolean(),
        loudnessOk: z.boolean(),
        paletteDistanceAvg: z.number(),
        details: z.array(z.string()),
        pass: z.boolean(),
      }),
      matchSheet: z.string().nullable(),
    })
    .optional(),
  pass: z.boolean(),
});

export type VerifyReportT = z.infer<typeof VerifyReport>;
export type LintDefectT = z.infer<typeof LintDefect>;
export type RubricCategoryT = z.infer<typeof RubricCategory>;

/* ============================================================================
 * Doctor report
 * ========================================================================== */

export const DoctorReport = z.object({
  ok: z.boolean(),
  renderTier: z.enum(["full-cdp", "browserless-py", "ffmpeg-only"]),
  host: z.enum(["auto", "gemini", "muse", "chatgpt"]).nullable().default(null),
  os: z.object({
    platform: z.string(),
    release: z.string(),
    arch: z.string(),
    cpus: z.number(),
  }),
  node: z.string(),
  python: z.string().nullable(),
  pythonModules: z.object({
    pil: z.boolean(),
    numpy: z.boolean(),
    cairosvg: z.boolean(),
  }),
  fonts: z.object({
    regular: z.string().nullable(),
    bold: z.string().nullable(),
    mono: z.string().nullable(),
    count: z.number().int().min(0),
    directories: z.array(z.string()),
    bundledFonts: z
      .array(
        z.object({
          file: z.string(),
          family: z.string(),
          role: z.enum(["display", "regular", "bold", "mono"]),
          path: z.string(),
          bytes: z.number().int().min(0),
        }),
      )
      .default([]),
  }),
  forcedTier: z.enum(["full-cdp", "browserless-py", "ffmpeg-only"]).nullable().default(null),
  ffmpeg: z.object({ available: z.boolean(), version: z.string().nullable() }),
  ffprobe: z.object({ available: z.boolean(), version: z.string().nullable() }),
  browser: z.object({
    available: z.boolean(),
    kind: z.string().nullable(),
    executablePath: z.string().nullable(),
  }),
  disk: z
    .object({
      tmpFreeMb: z.number().nullable(),
      workspaceFreeMb: z.number().nullable(),
      tmpPath: z.string(),
    })
    .default({ tmpFreeMb: null, workspaceFreeMb: null, tmpPath: "" }),
  fs: z
    .object({
      homeWritable: z.boolean(),
      cacheWritable: z.boolean(),
    })
    .default({ homeWritable: false, cacheWritable: false }),
  memory: z
    .object({
      totalMb: z.number(),
      estimatedPeakMbForProject: z.number(),
    })
    .default({ totalMb: 0, estimatedPeakMbForProject: 0 }),
  /** [3] Commit embedded by scripts/pack-cloud.ts and whether it matches HEAD. */
  bundleCommit: z.string().nullable().default(null),
  sourceMatchesBundle: z.boolean().default(false),
  remotion: z.object({ installed: z.boolean() }),
  revideo: z.object({ installed: z.boolean() }),
  blender: z.object({ available: z.boolean(), version: z.string().nullable() }),
  gpu: z.object({ available: z.boolean(), name: z.string().nullable() }),
  warnings: z.array(z.string()),
});

export type DoctorReportT = z.infer<typeof DoctorReport>;
