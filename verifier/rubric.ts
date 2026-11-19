import type { RubricCategoryT } from "../core/schema.js";

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
      { id: "motion.jitter", label: "Zero jitter: no duplicate/frozen stride beyond intentional holds" },
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

/** 100-point rubric template: 5 categories x 4 items x 5 points. The chat agent fills `checked` + `score` by inspecting the pair PNGs. */
export function createRubric(): {
  passThreshold: number;
  categories: RubricCategoryT[];
  totalScore: number | null;
} {
  return {
    passThreshold: 90,
    totalScore: null,
    categories: CATEGORY_SPECS.map((cat) => ({
      id: cat.id,
      name: cat.name,
      maxPoints: 20,
      score: null,
      items: cat.items.map((item) => ({ id: item.id, label: item.label, checked: null })),
    })),
  };
}
