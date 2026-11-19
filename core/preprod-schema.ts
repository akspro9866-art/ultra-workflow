import { z } from "zod";
import { AspectProfile, EngineName, HexColor } from "./schema.js";

/* ============================================================================
 * Pre-production plan contract — workspace/plan.json
 * Hard approval gate: build/render refuse to run until this plan + ultra.json
 * hash is approved by the user (or CI).
 * ========================================================================== */

export const PlanShot = z
  .object({
    id: z.string().min(1),
    startSec: z.number().min(0),
    endSec: z.number().positive(),
    visual: z.string().min(1),
    camera: z.string().min(1),
    caption: z.string().default(""),
    engine: EngineName.default("hyperframes"),
    sfx: z.array(z.string()).default([]),
  })
  .superRefine((shot, ctx) => {
    if (shot.endSec <= shot.startSec) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `shot "${shot.id}" endSec must exceed startSec`, path: ["endSec"] });
    }
  });

export const PlanSchema = z
  .object({
    meta: z.object({
      title: z.string().min(1),
      concept: z.string().min(1),
      mode: z.enum(["clone", "edit-in-style"]).default("clone"),
      styleSlug: z.string().nullable().default(null),
      aspect: AspectProfile,
      resolution: z.enum(["4k", "1080p"]).default("1080p"),
      fps: z.number().positive().max(120).default(30),
      durationSec: z.number().positive(),
    }),
    palette: z
      .array(z.object({ name: z.string().min(1), hex: HexColor }))
      .min(2)
      .max(8),
    typography: z.object({
      display: z.string().min(1),
      body: z.string().min(1),
      mono: z.string().min(1),
      hierarchy: z.array(z.number().positive()).min(2).default([96, 52, 28]),
    }),
    styleInvariants: z.array(z.string()).default([]),
    audio: z.object({
      direction: z.string().default(""),
      targetLufs: z.number().min(-70).max(0).default(-14),
      bpm: z.number().min(20).max(400).optional(),
      sfx: z.array(z.string()).default([]),
    }),
    grade: z.object({
      notes: z.string().default(""),
      contrast: z.number().default(0),
      saturation: z.number().default(1),
      grainOpacity: z.number().min(0).max(1).default(0.05),
    }),
    shots: z.array(PlanShot).min(1),
  })
  .superRefine((plan, ctx) => {
    const shots = [...plan.shots].sort((a, b) => a.startSec - b.startSec);
    let previousEnd = 0;
    for (const shot of shots) {
      if (Math.abs(shot.startSec - previousEnd) > 0.06) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `shot "${shot.id}" starts at ${shot.startSec}s but previous shot ends at ${previousEnd}s (no gaps)`,
          path: ["shots"],
        });
      }
      previousEnd = shot.endSec;
    }
    if (Math.abs(previousEnd - plan.meta.durationSec) > 0.06) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `last shot ends at ${previousEnd}s but meta.durationSec is ${plan.meta.durationSec}s`,
        path: ["meta", "durationSec"],
      });
    }
  });

export type PlanT = z.infer<typeof PlanSchema>;
export type PlanShotT = z.infer<typeof PlanShot>;

export const ApprovalSchema = z.object({
  approved: z.boolean(),
  planHash: z.string().length(64).nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  notes: z.string().default(""),
});

export type ApprovalT = z.infer<typeof ApprovalSchema>;
