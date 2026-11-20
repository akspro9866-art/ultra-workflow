import type { RubricCategoryT } from "../core/schema.js";

export type SimilarityMethod = "native" | "plate-replay" | "mixed";

interface RubricItemSpec {
  id: string;
  label: string;
}

interface RubricCategorySpec {
  id: string;
  name: string;
  items: RubricItemSpec[];
}

const CATEGORY_SPECS: RubricCategorySpec[] = [
  {
    id: "timing",
    name: "Timing",
    items: [
      { id: "timing.duration", label: "Duration delta vs reference <= 0.05s" },
      { id: "timing.fps", label: "Exact frame rate and CFR cadence preserved" },
      { id: "timing.cuts", label: "Cuts land on the reference cut timestamps" },
      { id: "timing.cues", label: "Audio SFX cues land on the reference beat onsets" },
    ],
  },
  {
    id: "typography-layout",
    name: "Typography / Layout",
    items: [
      { id: "type.scale", label: "Type scale matches DESIGN.md tokens" },
      { id: "type.palette", label: "Every visible color comes from the DESIGN palette" },
      { id: "type.safe", label: "No clipped or overlapping text at any audited frame" },
      { id: "type.hierarchy", label: "Hierarchy reads like the original composition" },
    ],
  },
  {
    id: "color-texture",
    name: "Color / Texture",
    items: [
      { id: "color.grade", label: "LUT/curve grade matches reference temperature and contrast" },
      { id: "color.grain", label: "Surface grain/texture density matches the reference" },
      { id: "color.contrast", label: "WCAG contrast thresholds met for all text" },
      { id: "color.vignette", label: "Vignette and falloff behave like the reference" },
    ],
  },
  {
    id: "motion-transitions",
    name: "Motion / Transitions",
    items: [
      { id: "motion.easing", label: "Easing curves match the reference feel (no linear robot motion)" },
      { id: "motion.transitions", label: "Transitions types/durations match at every boundary" },
      { id: "motion.keyframes", label: "Shape/text keyframes land on the reference beats" },
      { id: "motion.jitter", label: "Zero jitter: no NEW duplicate/frozen stride beyond the reference's own holds" },
    ],
  },
  {
    id: "zero-slop",
    name: "Zero Slop / Zero Jitter",
    items: [
      { id: "slop.look", label: "No template/stock look; custom to the reference's visual system" },
      { id: "slop.corners", label: "No generic gradients, badge blobs, or filler iconography" },
      { id: "slop.blank", label: "Zero unexpected blank frames" },
      { id: "slop.lint", label: "Structural DOM lint clean (media, fonts, layout)" },
    ],
  },
];

/**
 * [26] Expectations differ by declared method — never collapse plate replay
 * and native generation into one comparable number.
 */
const EXPECTATIONS: Record<SimilarityMethod, Record<string, string>> = {
  native: {
    timing: "Native: timings must be re-authored from measurements, not copied frames",
    "typography-layout": "Native: text/layout re-created; plate reuse of reference frames is a guard failure",
    "color-texture": "Native: grade + texture re-created; expect SSIM ≈0.67–0.85, judge composition, not pixel identity",
    "motion-transitions": "Native: easing measured via motion curves; keyframes re-authored from cuts/beats",
    "zero-slop": "Native: the 4/10 failure mode is a wrong photograph with exact layout — grade content, not geometry",
  },
  "plate-replay": {
    timing: "Plate replay: frame identity is expected; judge only timing/overlay integration",
    "typography-layout": "Plate replay: overlays must not disturb replayed frames",
    "color-texture": "Plate replay: near-1.0 SSIM is bypassing the native rule; score integration only",
    "motion-transitions": "Plate replay: motion comes from the reference itself",
    "zero-slop": "Plate replay: allowed only when the user asked for it; never call it native",
  },
  mixed: {
    timing: "Mixed: distinguish replayed segments from generated ones per scene",
    "typography-layout": "Mixed: replayed scenes inherit reference layout; generated scenes must be re-authored",
    "color-texture": "Mixed: report per-scene method — do not mix plate scores into native scores",
    "motion-transitions": "Mixed: easing only measurable on generated scenes",
    "zero-slop": "Mixed: state which scenes are plates in the delivery notes",
  },
};

/** 100-point rubric template: 5 categories x 4 items x 5 points. The chat agent fills `checked` + `score` by inspecting the pair PNGs. */
export function createRubric(method: SimilarityMethod = "native"): {
  passThreshold: number;
  categories: RubricCategoryT[];
  totalScore: number | null;
  method: string;
} {
  return {
    passThreshold: 90,
    totalScore: null,
    method,
    categories: CATEGORY_SPECS.map((cat) => ({
      id: cat.id,
      name: cat.name,
      maxPoints: 20,
      score: null,
      expectation: EXPECTATIONS[method][cat.id],
      items: cat.items.map((item) => ({ id: item.id, label: item.label, checked: null })),
    })),
  };
}
