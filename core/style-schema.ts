import { z } from "zod";
import { EasingName, EngineName, HexColor } from "./schema.js";

/* ============================================================================
 * Style Pack schema — styles/<slug>/style.json
 * Eight quantitative parameter groups distilled from 1–10 reference videos.
 * ========================================================================== */

const Slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase letters, digits and dashes");

const Range = z.tuple([z.number(), z.number()]);
const PositiveRange = z.tuple([z.number().positive(), z.number().positive()]);
const RatioRange = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

export const StylePackMeta = z.object({
  slug: Slug,
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().min(1).default("1.0.0"),
  createdAt: z.string().min(1),
  referenceCount: z.number().int().min(1).max(10),
  sourceNotes: z.string().default(""),
});

export const PacingSpec = z.object({
  hookWindowSec: z.number().positive().max(30).default(5),
  hookAslSec: PositiveRange,
  bodyAslSec: PositiveRange,
  outroAslSec: PositiveRange,
  maxStaticHoldSec: z.number().positive().max(30),
  silenceTrimMs: z.number().int().min(0).max(2000).default(150),
  jCutMs: z.number().int().min(0).max(2000).default(0),
  lCutMs: z.number().int().min(0).max(2000).default(0),
  beatSnapRatioTarget: z.number().min(0).max(1).default(0.5),
});

export const MotionSpec = z.object({
  dominantEasing: EasingName.default("easeOutCubic"),
  secondaryEasings: z.array(EasingName).default([]),
  punchInScaleRange: z.tuple([z.number().min(1).max(3), z.number().min(1).max(3)]).default([1.02, 1.12]),
  kenBurnsDriftScale: z.number().min(0).max(4).default(0.4),
  motionBlurSamples: z.number().int().min(1).max(4).default(1),
  shutterAngle: z.number().min(0).max(360).default(180),
  cameraDriftAmplitude: z.number().min(0).max(100).default(0),
  posterizeFps: z.number().int().min(1).max(60).optional(),
});

export const TypographySpec = z.object({
  displayFont: z.string().min(1),
  captionFont: z.string().min(1),
  monoFont: z.string().min(1),
  casing: z.enum(["upper", "title", "sentence", "mixed"]).default("upper"),
  captionChunkWords: z.tuple([z.number().int().min(1), z.number().int().min(1)]).default([2, 4]),
  safeZoneYPercent: z.number().min(0).max(100).default(78),
  activeWordHighlight: z.enum(["color", "pill", "scale", "underline", "none"]).default("color"),
  strokePx: z.number().min(0).max(20).default(0),
  shadowSpec: z.string().default(""),
});

export const MotifTrigger = z.object({
  trigger: z.string().min(1),
  motifFile: z.string().min(1),
  description: z.string().default(""),
});

export const VisualLayeringSpec = z.object({
  aRollRatio: z.number().min(0).max(1).default(0.7),
  bRollRatio: z.number().min(0).max(1).default(0.2),
  motionGraphicRatio: z.number().min(0).max(1).default(0.1),
  preferredEngines: z.array(EngineName).default([]),
  motifTriggers: z.array(MotifTrigger).default([]),
});

export const StyleGrade = z.object({
  exposure: z.number().min(-2).max(2).default(0),
  contrast: z.number().min(-2).max(2).default(0),
  saturation: z.number().min(0).max(3).default(1),
  temperature: z.number().min(-1).max(1).default(0),
  vignette: z.number().min(0).max(1).default(0),
});

export const StylePalette = z.object({
  bg: HexColor,
  surface: HexColor,
  textPrimary: HexColor,
  textMuted: HexColor,
  accent1: HexColor,
  accent2: HexColor,
});

export const ColorTextureSpec = z.object({
  palette: StylePalette,
  lutFile: z.string().optional(),
  grade: StyleGrade.default({}),
  grainOpacity: z.number().min(0).max(1).default(0.05),
  halationOpacity: z.number().min(0).max(1).default(0),
  halftoneOpacity: z.number().min(0).max(1).default(0),
});

export const TransitionsSpec = z.object({
  mix: z.record(z.number().min(0)).default({}),
  durationFrames: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([6, 18]),
  bannedTypes: z.array(z.string()).default([]),
});

export const SoundDesignSpec = z.object({
  targetLufs: z.number().min(-70).max(0).default(-14),
  musicDuckingDb: z.number().min(-60).max(0).default(-12),
  musicBpmRange: z.tuple([z.number().min(20).max(400), z.number().min(20).max(400)]).default([70, 140]),
  eventToSfxMap: z.record(z.string()).default({}),
});

export const NarrativeSpec = z.object({
  hookPatterns: z.array(z.string()).default([]),
  chapterResetIntervalSec: z.number().positive().max(600).default(20),
  styleInvariants: z.array(z.string()).default([]),
  antiPatterns: z.array(z.string()).default([]),
});

export const StylePackSchema = z
  .object({
    meta: StylePackMeta,
    pacing: PacingSpec,
    motion: MotionSpec,
    typography: TypographySpec,
    visualLayering: VisualLayeringSpec,
    colorAndTexture: ColorTextureSpec,
    transitions: TransitionsSpec,
    soundDesign: SoundDesignSpec,
    narrative: NarrativeSpec,
  })
  .superRefine((style, ctx) => {
    const pairs: [string, [number, number]][] = [
      ["pacing.hookAslSec", style.pacing.hookAslSec],
      ["pacing.bodyAslSec", style.pacing.bodyAslSec],
      ["pacing.outroAslSec", style.pacing.outroAslSec],
      ["pacing.musicBpmRange" as string, style.soundDesign.musicBpmRange],
      ["motion.punchInScaleRange", style.motion.punchInScaleRange],
      ["typography.captionChunkWords", style.typography.captionChunkWords.map((v) => Number(v)) as [number, number]],
      ["transitions.durationFrames", style.transitions.durationFrames.map((v) => Number(v)) as [number, number]],
    ];
    for (const [label, [min, max]] of pairs) {
      if (min > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label}: min (${min}) must be <= max (${max})`,
          path: label.split("."),
        });
      }
    }
  });

export type StylePackT = z.infer<typeof StylePackSchema>;
export type StyleMetaT = z.infer<typeof StylePackMeta>;

/* ============================================================================
 * Registry — styles/registry.json
 * ========================================================================== */

export const StyleRegistryEntry = z.object({
  slug: Slug,
  name: z.string().min(1),
  version: z.string().min(1),
  referenceCount: z.number().int().min(1),
  installedAt: z.string().min(1),
});

export const StyleRegistry = z.object({
  updatedAt: z.string().min(1),
  styles: z.array(StyleRegistryEntry).default([]),
});

export type StyleRegistryT = z.infer<typeof StyleRegistry>;

/* ============================================================================
 * Batch style-probe aggregate — workspace/style-probe/aggregate.json
 * ========================================================================== */

export const StyleProbeAggregate = z.object({
  generatedAt: z.string(),
  videos: z.array(
    z.object({
      source: z.string(),
      probeDir: z.string(),
      durationSec: z.number().positive(),
      fps: z.number().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      cutCount: z.number().int().min(0),
      hookAslSec: z.number().nullable(),
      bodyAslSec: z.number().nullable(),
      outroAslSec: z.number().nullable(),
      longestStaticHoldSec: z.number().min(0),
      silence: z.object({
        thresholdDb: z.number(),
        count: z.number().int().min(0),
        avgSec: z.number().min(0),
        medianSec: z.number().min(0),
        maxSec: z.number().min(0),
      }),
      beatSnapRatio: z.number().min(0).max(1),
      palette: z.array(z.object({ hex: HexColor, share: z.number().min(0).max(1) })),
      avgLuminance: z.number().min(0).max(1),
      contrast: z.number().min(0).max(1),
      avgSaturation: z.number().min(0).max(100),
      contactSheets: z.array(z.string()),
    }),
  ),
  sections: z.object({
    hook: z.object({ min: z.number().nullable(), median: z.number().nullable(), max: z.number().nullable() }),
    body: z.object({ min: z.number().nullable(), median: z.number().nullable(), max: z.number().nullable() }),
    outro: z.object({ min: z.number().nullable(), median: z.number().nullable(), max: z.number().nullable() }),
  }),
  pacing: z.object({
    maxStaticHoldSec: z.number().min(0),
    silenceTrimMsSuggested: z.number().int().min(0),
    beatSnapRatio: z.number().min(0).max(1),
  }),
  palette: z.array(z.object({ hex: HexColor, share: z.number().min(0).max(1) })),
  avgLuminance: z.number().min(0).max(1),
  avgContrast: z.number().min(0).max(1),
  avgSaturation: z.number().min(0).max(100),
  candidates: z.array(z.string()),
  overviewPng: z.string(),
});

export type StyleProbeAggregateT = z.infer<typeof StyleProbeAggregate>;
