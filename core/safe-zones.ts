import type { AspectProfileT } from "./schema.js";

/* ============================================================================
 * Platform aspect profiles & social UI safe zones
 * Normalized 0–1 rectangles so every renderer/linter shares one truth.
 * ========================================================================== */

export interface SafeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DangerZone {
  id: string;
  label: string;
  rect: SafeRect;
}

export interface AspectSafeZones {
  aspect: AspectProfileT;
  frameWidth: number;
  frameHeight: number;
  margins: { top: number; bottom: number; left: number; right: number };
  safeRect: SafeRect;
  /** Where burned-in captions should sit by default (fully inside safeRect). */
  captionBand: SafeRect;
  dangerZones: DangerZone[];
}

const PROFILES: Record<AspectProfileT, AspectSafeZones> = {
  "9:16": {
    aspect: "9:16",
    frameWidth: 1080,
    frameHeight: 1920,
    margins: { top: 0.12, bottom: 0.22, left: 0.05, right: 0.15 },
    safeRect: { x: 0.05, y: 0.12, width: 0.8, height: 0.66 },
    captionBand: { x: 0.05, y: 0.62, width: 0.8, height: 0.14 },
    dangerZones: [
      { id: "top-ui", label: "Reels/Shorts/TikTok top platform header", rect: { x: 0, y: 0, width: 1, height: 0.12 } },
      { id: "bottom-ui", label: "Reels/Shorts/TikTok bottom caption/audio UI", rect: { x: 0, y: 0.78, width: 1, height: 0.22 } },
      { id: "right-rail", label: "TikTok right like/comment/share rail", rect: { x: 0.85, y: 0, width: 0.15, height: 1 } },
      { id: "left-margin", label: "9:16 left safety margin", rect: { x: 0, y: 0, width: 0.05, height: 1 } },
    ],
  },
  "16:9": {
    aspect: "16:9",
    frameWidth: 1920,
    frameHeight: 1080,
    margins: { top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 },
    safeRect: { x: 0.06, y: 0.06, width: 0.88, height: 0.88 },
    captionBand: { x: 0.06, y: 0.72, width: 0.88, height: 0.14 },
    dangerZones: [
      { id: "title-top", label: "YouTube title-safe top perimeter", rect: { x: 0, y: 0, width: 1, height: 0.06 } },
      { id: "title-bottom", label: "YouTube title-safe bottom perimeter", rect: { x: 0, y: 0.94, width: 1, height: 0.06 } },
      { id: "title-left", label: "YouTube title-safe left perimeter", rect: { x: 0, y: 0, width: 0.06, height: 1 } },
      { id: "title-right", label: "YouTube title-safe right perimeter", rect: { x: 0.94, y: 0, width: 0.06, height: 1 } },
    ],
  },
  "1:1": {
    aspect: "1:1",
    frameWidth: 1080,
    frameHeight: 1080,
    margins: { top: 0.08, bottom: 0.08, left: 0.08, right: 0.08 },
    safeRect: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 },
    captionBand: { x: 0.08, y: 0.68, width: 0.84, height: 0.15 },
    dangerZones: [
      { id: "square-top", label: "square platform top perimeter", rect: { x: 0, y: 0, width: 1, height: 0.08 } },
      { id: "square-bottom", label: "square platform bottom perimeter", rect: { x: 0, y: 0.92, width: 1, height: 0.08 } },
      { id: "square-left", label: "square platform left perimeter", rect: { x: 0, y: 0, width: 0.08, height: 1 } },
      { id: "square-right", label: "square platform right perimeter", rect: { x: 0.92, y: 0, width: 0.08, height: 1 } },
    ],
  },
};

export function safeZonesFor(aspect: AspectProfileT): AspectSafeZones {
  return PROFILES[aspect];
}

export function inferAspectProfile(width: number, height: number): AspectProfileT {
  const ratio = width / Math.max(1, height);
  if (Math.abs(ratio - 9 / 16) < 0.06) return "9:16";
  if (Math.abs(ratio - 1) < 0.08) return "1:1";
  return "16:9";
}

/** Explicit `meta.aspectProfile` wins; otherwise infer from the canvas. */
export function resolveAspectProfile(meta: {
  width: number;
  height: number;
  aspectProfile?: AspectProfileT | undefined;
}): { aspect: AspectProfileT; explicit: boolean; zones: AspectSafeZones } {
  const aspect = meta.aspectProfile ?? inferAspectProfile(meta.width, meta.height);
  return { aspect, explicit: Boolean(meta.aspectProfile), zones: safeZonesFor(aspect) };
}

export interface CaptionSafeBox {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  nominalPixels: { x: number; y: number; width: number; height: number; frameWidth: number; frameHeight: number };
}

/** Safe caption band for a project frame, expressed in normalized + nominal pixels. */
export function captionSafeBox(aspect: AspectProfileT, width?: number, height?: number): CaptionSafeBox {
  const zones = safeZonesFor(aspect);
  const band = zones.captionBand;
  const frameWidth = width ?? zones.frameWidth;
  const frameHeight = height ?? zones.frameHeight;
  return {
    xPercent: round3(band.x * 100),
    yPercent: round3(band.y * 100),
    widthPercent: round3(band.width * 100),
    heightPercent: round3(band.height * 100),
    nominalPixels: {
      x: Math.round(band.x * frameWidth),
      y: Math.round(band.y * frameHeight),
      width: Math.round(band.width * frameWidth),
      height: Math.round(band.height * frameHeight),
      frameWidth,
      frameHeight,
    },
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function intersectArea(a: SafeRect, b: SafeRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/** First platform danger zone the rect enters (ignores hairline touches). */
export function dangerZoneForRect(rect: SafeRect, aspect: AspectProfileT): DangerZone | null {
  for (const zone of safeZonesFor(aspect).dangerZones) {
    if (intersectArea(rect, zone.rect) > 0.0004) return zone;
  }
  return null;
}

/** Check a pixel-space box against the normalized danger zones. */
export function dangerZoneForPixelBox(
  box: { x: number; y: number; width: number; height: number },
  aspect: AspectProfileT,
  frameWidth: number,
  frameHeight: number,
): DangerZone | null {
  const rect: SafeRect = {
    x: box.x / Math.max(1, frameWidth),
    y: box.y / Math.max(1, frameHeight),
    width: box.width / Math.max(1, frameWidth),
    height: box.height / Math.max(1, frameHeight),
  };
  return dangerZoneForRect(rect, aspect);
}

export function isAspectProfile(value: string): value is AspectProfileT {
  return value === "9:16" || value === "16:9" || value === "1:1";
}
