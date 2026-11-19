"""Ultra Workflow — py-canvas browserless deterministic renderer.

Zero-browser, zero-install engine used inside ChatGPT Linux containers (or any
sandbox without Chromium). Renders every frame deterministically with Pillow and
pipes raw RGB(A) frames straight to FFmpeg (the TS adapter owns the encoder).

If Pillow is missing the script falls back to a pure FFmpeg filtergraph renderer
(drawtext/color) so it NEVER crashes; `--mode lint` returns basic JSON checks in
that case.

Modes:
  --mode render  (default) raw frames on stdout
  --mode lint    JSON defects on stdout (clip/brokenMedia/contrast/blankFrame)

Bundle JSON is produced by engines/py-canvas/index.ts and contains the scene,
design tokens, resolved asset paths, sourceClip path, optional scene_graph and
discovered font files.
"""

import argparse
import json
import math
import os
import random
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
    HAVE_PIL = True
except Exception:  # pragma: no cover - ChatGPT containers have Pillow
    HAVE_PIL = False

TWO_PI = math.pi * 2


# ---------------------------------------------------------------------------
# Math / easing / sampling (mirrors engines/hyperframes runtime semantics)
# ---------------------------------------------------------------------------

def clamp(v, a, b):
    return a if v < a else (b if v > b else v)


EASE = {
    "linear": lambda t: clamp(t, 0, 1),
    "easeInQuad": lambda t: clamp(t, 0, 1) ** 2,
    "easeOutQuad": lambda t: (lambda p: p * (2 - p))(clamp(t, 0, 1)),
    "easeInOutQuad": lambda t: (lambda p: 2 * p * p if p < 0.5 else -1 + (4 - 2 * p) * p)(clamp(t, 0, 1)),
    "easeInCubic": lambda t: clamp(t, 0, 1) ** 3,
    "easeOutCubic": lambda t: (lambda p: p ** 3 + 1)(clamp(t, 0, 1) - 1),
    "easeInOutCubic": lambda t: (lambda p: 4 * p ** 3 if p < 0.5 else 1 + 4 * (p - 1) ** 3)(clamp(t, 0, 1)),
    "easeOutBack": lambda t: (lambda p: 1 + 2.70158 * p ** 3 + 1.70158 * p ** 2)(clamp(t, 0, 1) - 1),
    "easeOutExpo": lambda t: 1 if t >= 1 else 1 - 2 ** (-10 * clamp(t, 0, 1)),
    "easeInOutSine": lambda t: -(math.cos(math.pi * clamp(t, 0, 1)) - 1) / 2,
}


EASE_ALIASES = {
    "expo.out": "easeOutExpo",
    "expo.inOut": "easeInOutSine",
    "back.out": "easeOutBack",
    "power3.out": "easeOutCubic",
    "power3.inOut": "easeInOutCubic",
    "cubic-bezier": "easeInOutCubic",
    "ease": "easeInOutCubic",
}


def ease(name, t):
    key = EASE_ALIASES.get(str(name), name)
    return EASE.get(key or "easeInOutCubic", EASE["easeInOutCubic"])(t)


def sample_track(track, t):
    kfs = track.get("keyframes", [])
    if not kfs:
        return None
    if t <= kfs[0]["atSec"]:
        return kfs[0]["value"]
    last = kfs[-1]
    if t >= last["atSec"]:
        return last["value"]
    for i in range(1, len(kfs)):
        b = kfs[i]
        if t <= b["atSec"]:
            a = kfs[i - 1]
            span = b["atSec"] - a["atSec"]
            p = 1 if span <= 0 else (t - a["atSec"]) / span
            return a["value"] + (b["value"] - a["value"]) * ease(b.get("ease"), p)
    return last["value"]


def sample_prop(kfs, prop, t, fallback):
    pts = [k for k in kfs if k.get(prop) is not None]
    if not pts:
        return fallback
    if t <= pts[0]["atSec"]:
        return pts[0][prop]
    last = pts[-1]
    if t >= last["atSec"]:
        return last[prop]
    for i in range(1, len(pts)):
        b = pts[i]
        if t <= b["atSec"]:
            a = pts[i - 1]
            span = b["atSec"] - a["atSec"]
            p = 1 if span <= 0 else (t - a["atSec"]) / span
            e = ease(b.get("ease"), p)
            av, bv = a[prop], b[prop]
            if isinstance(av, (list, tuple)) and isinstance(bv, (list, tuple)):
                return [av[j] + (bv[j] - av[j]) * e for j in range(min(len(av), len(bv)))]
            return av + (bv - av) * e
    return last[prop]


def hex_rgba(value, alpha=255):
    if not value:
        return (0, 0, 0, alpha)
    h = value.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) >= 6:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        if len(h) == 8:
            alpha = int(h[6:8], 16)
        return (r, g, b, alpha)
    return (0, 0, 0, alpha)


def hex_rgb(value):
    r, g, b, _ = hex_rgba(value)
    return (r, g, b)


def luminance(rgb):
    def ch(v):
        c = v / 255.0
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2])


def contrast_ratio(fg, bg):
    l1, l2 = luminance(fg), luminance(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------

class FontBook:
    def __init__(self, bundle):
        files = bundle.get("fontFiles") or {}
        self.regular = files.get("regular")
        self.bold = files.get("bold") or self.regular
        self.mono = files.get("mono") or self.regular
        self._cache = {}

    def get(self, kind, bold, size):
        family = self.mono if kind == "mono" else (self.bold if bold else self.regular)
        key = (family, size)
        if key in self._cache:
            return self._cache[key]
        font = None
        if HAVE_PIL and family and os.path.exists(family):
            try:
                font = ImageFont.truetype(family, size)
            except Exception:
                font = None
        if font is None and HAVE_PIL:
            try:
                font = ImageFont.load_default(size=size)
            except Exception:
                font = ImageFont.load_default()
        self._cache[key] = font
        return font


# ---------------------------------------------------------------------------
# Text layout
# ---------------------------------------------------------------------------

def text_tokens(text, mode, uppercase):
    raw = text.upper() if uppercase else text
    if mode == "chars":
        return list(raw)
    if mode == "lines":
        return raw.split("\n")
    return raw.split(" ")


def wrap_lines(tokens, font, max_width, mode):
    if mode == "lines":
        return [t for t in tokens]
    lines, current, width = [], [], 0.0
    space = font.getlength(" ") if HAVE_PIL else 8
    for token in tokens:
        if token == "\n":
            lines.append("".join(current).strip())
            current, width = [], 0.0
            continue
        if mode == "chars" and token == " ":
            current.append(" ")
            width += space
            continue
        tw = font.getlength(token) if HAVE_PIL else len(token) * 8
        extra = space if current and mode != "chars" else 0
        if current and width + extra + tw > max_width:
            lines.append((" ".join(current) if mode != "chars" else "".join(current)).strip())
            current, width = [token], tw
        else:
            if extra and mode != "chars":
                current.append(" ")
            current.append(token)
            width += extra + tw
    if current:
        lines.append((" ".join(current) if mode != "chars" else "".join(current)).strip())
    return lines or [""]


def draw_shadow_text(draw, xy, text, font, fill, shadow=True):
    if shadow:
        sx, sy = xy[0] + 2, xy[1] + 3
        draw.text((sx, sy), text, font=font, fill=(0, 0, 0, 140))
    draw.text(xy, text, font=font, fill=fill)


def text_boxes_for_element(scene, tokens, el, t, W, H, fonts):
    """Compute laid-out text boxes (for rendering and linting)."""
    el_id = el["id"]
    base_x, base_y = el["x"], el["y"]
    x, y = base_x, base_y
    opacity = 1.0
    scale = 1.0
    for track in scene.get("keyframes", []):
        if track.get("target") != el_id:
            continue
        value = sample_track(track, t)
        prop = track.get("property")
        if prop == "x":
            x = value
        elif prop == "y":
            y = value
        elif prop == "opacity":
            opacity = value
        elif prop == "scale":
            scale = value
    reveal = el.get("reveal") or {}
    mode = reveal.get("mode", "none")
    size = el.get("sizePx", 48)
    bold = (el.get("weight") or 700) >= 600
    font = fonts.get(el.get("font", "body"), bold, max(6, int(size * scale)))
    width = el.get("width") or max(100, W - x - 60)
    raw = text_tokens(el.get("text", ""), mode, bool(el.get("uppercase")))
    lines = wrap_lines(raw, font, width, mode)
    line_h = size * scale * float(el.get("lineHeight", 1.2))
    boxes = []
    current_y = y
    for line in lines:
        tw = font.getlength(line) if HAVE_PIL else len(line) * size * 0.5
        align = el.get("align", "left")
        lx = x if align == "left" else (x + (width - tw) / 2 if align == "center" else x + width - tw)
        boxes.append({"x": lx, "y": current_y, "w": tw, "h": line_h, "text": line, "font": font, "opacity": opacity})
        current_y += line_h
    return boxes, opacity, mode, reveal, size, scale


def draw_text_element(base, draw, scene, tokens, el, t, W, H, fonts):
    boxes, opacity, mode, reveal, size, scale = text_boxes_for_element(scene, tokens, el, t, W, H, fonts)
    if opacity <= 0.01:
        return
    color = hex_rgba(el.get("color", "#ffffff"), int(255 * clamp(opacity, 0, 1)))
    highlight = None
    if mode in ("chars", "words"):
        progress = clamp((t - reveal.get("delaySec", 0)) / max(0.001, reveal.get("durationSec", 0.5)), 0, 1)
        count = max(1, len([b for b in boxes]))
        highlight = min(len(boxes) - 1, int(progress * len(boxes)))
    for idx, box in enumerate(boxes):
        draw_shadow_text(draw, (box["x"], box["y"]), box["text"], box["font"], color, shadow=True)
        if highlight is not None and idx == highlight:
            tw = box["font"].getlength(box["text"]) if HAVE_PIL else box["w"]
            pad = 10 * scale
            pill = [box["x"] - pad, box["y"] - pad * 0.2, box["x"] + box["w"] + pad, box["y"] + box["h"] + pad * 0.2]
            accent = hex_rgba((tokens.get("palette") or {}).get("accent") or list((tokens.get("palette") or {}).values() or ["#ffb703"])[0], 235)
            draw.rounded_rectangle(pill, radius=int(12 * scale), fill=accent)
            bg = hex_rgba(scene.get("background") if scene.get("background") != "transparent" else "#101820")
            draw_shadow_text(draw, (box["x"], box["y"]), box["text"], box["font"], bg, shadow=False)


# ---------------------------------------------------------------------------
# Word-level captions (workspace/captions.json on sourceClip scenes)
# ---------------------------------------------------------------------------

def caption_casing(text, casing):
    if casing == "upper":
        return text.upper()
    if casing == "title":
        return " ".join(w[:1].upper() + w[1:].lower() for w in text.split())
    if casing == "sentence":
        lowered = text.lower()
        return lowered[:1].upper() + lowered[1:]
    return text


def _caption_lines(words, font, max_width):
    space = font.getlength(" ") if HAVE_PIL else 8
    lines, current, width = [], [], 0.0
    for idx, word in enumerate(words):
        tw = font.getlength(word) if HAVE_PIL else len(word) * 8
        extra = space if current else 0
        if current and width + extra + tw > max_width:
            lines.append(current)
            current, width = [(idx, word, tw)], tw
        else:
            current.append((idx, word, tw))
            width += extra + tw
    if current:
        lines.append(current)
    return lines


def draw_captions(base, draw, captions, scene_start, t, W, H, fonts, tokens):
    if not captions:
        return
    abs_t = scene_start + t
    active = None
    for chunk in captions.get("chunks", []):
        if float(chunk.get("startSec", 0)) <= abs_t < float(chunk.get("endSec", 0)):
            active = chunk
            break
    if active is None:
        return
    typography = captions.get("typography") or {}
    casing = typography.get("casing", "upper")
    highlight = typography.get("activeWordHighlight", "pill")
    size = max(16, int(H * (0.045 if H > W else 0.05)))
    font = fonts.get("body", True, size)
    band = active.get("safeBox") or {}
    band_x = float(band.get("xPercent", 5)) / 100 * W
    band_y = float(band.get("yPercent", 62)) / 100 * H
    band_w = float(band.get("widthPercent", 80)) / 100 * W
    band_h = float(band.get("heightPercent", 14)) / 100 * H
    words = [caption_casing(str(w.get("text", "")), casing) for w in active.get("words", [])]
    if not words:
        return
    line_h = size * 1.2
    lines = _caption_lines(words, font, band_w)
    total_h = line_h * len(lines)
    top = band_y + max(0, (band_h - total_h) / 2)
    palette = tokens.get("palette") or {}
    values = list(palette.values())
    bg = tokens.get("background") or (values[0] if values else "#101820")
    if str(bg).lower() == "transparent":
        bg = "#101820"
    text_color = hex_rgba(palette.get("textPrimary") or palette.get("fg") or "#ffffff")
    accent_hex = palette.get("accent") or palette.get("accent1") or (values[2] if len(values) > 2 else "#ffb703")
    accent = hex_rgba(accent_hex)
    bg_rgb = hex_rgba(bg)
    # active word by absolute time (fall back to last started word)
    active_word = 0
    word_meta = active.get("words", [])
    for wi, word in enumerate(word_meta):
        if float(word.get("startSec", 0)) <= abs_t < float(word.get("endSec", 0)):
            active_word = wi
            break
        if abs_t >= float(word.get("startSec", 0)):
            active_word = wi
    for line_index, line in enumerate(lines):
        line_w = sum(item[2] for item in line) + (font.getlength(" ") if HAVE_PIL else 8) * (len(line) - 1)
        line_x = band_x + (band_w - line_w) / 2
        line_y = top + line_index * line_h
        pad = size * 0.14
        draw.rounded_rectangle(
            [line_x - pad, line_y - pad * 0.35, line_x + line_w + pad, line_y + line_h + pad * 0.1],
            radius=int(size * 0.18),
            fill=(0, 0, 0, 150),
        )
        cursor = line_x
        for idx, word, tw in line:
            if idx == active_word and highlight != "none":
                if highlight == "pill":
                    draw.rounded_rectangle(
                        [cursor - pad * 0.6, line_y - pad * 0.25, cursor + tw + pad * 0.6, line_y + line_h + pad * 0.05],
                        radius=int(size * 0.2),
                        fill=accent,
                    )
                    fill = bg_rgb
                elif highlight == "underline":
                    draw.rectangle([cursor, line_y + line_h - max(2, int(size * 0.08)), cursor + tw, line_y + line_h], fill=accent)
                    fill = accent
                else:
                    fill = accent
            else:
                fill = text_color
            draw.text((cursor, line_y), word, font=font, fill=fill)
            cursor += tw + (font.getlength(" ") if HAVE_PIL else 8)
    del bg_rgb


# ---------------------------------------------------------------------------
# Choreography (revideo engine payloads)
# ---------------------------------------------------------------------------

def draw_choreo(base, draw, scene, tokens, t, duration, W, H, fonts):
    payload = scene.get("enginePayload") or {}
    scene_type = payload.get("sceneType")
    if scene_type not in ("vectors", "diagram", "sequence", "chart", "counter", "code"):
        return
    palette = list((tokens.get("palette") or {}).values())
    bg = scene.get("background") if scene.get("background") != "transparent" else (palette[0] if palette else "#101820")
    rest = [c for c in palette if c.lower() != str(bg).lower()]
    accent = rest[0] if rest else "#ffb703"
    secondary = rest[1] if len(rest) > 1 else accent
    fg = rest[2] if len(rest) > 2 else "#f2f2f0"
    title = payload.get("title") or scene.get("name") or ""
    draw.text((110, 52), title, font=fonts.get("heading", True, 44), fill=hex_rgba(fg))
    progress = clamp(t / max(0.001, duration), 0, 1)

    if scene_type == "counter":
        target = float(payload.get("target", 100))
        e = ease("easeOutExpo", clamp((t - 0.1) / max(0.001, duration * 0.72), 0, 1))
        text = f"{payload.get('prefix', '')}{int(round(target * e))}{payload.get('suffix', '')}"
        font = fonts.get("heading", True, 168)
        tw = font.getlength(text) if HAVE_PIL else len(text) * 80
        draw.text(((W - tw) / 2, H / 2 - 90), text, font=font, fill=hex_rgba(accent))
        label = str(payload.get("label", "total")).upper()
        lf = fonts.get("mono", False, 24)
        lw = lf.getlength(label) if HAVE_PIL else len(label) * 12
        draw.text(((W - lw) / 2, H / 2 + 110), label, font=lf, fill=hex_rgba(secondary))
        return

    if scene_type == "code":
        lines = payload.get("lines") or ["const frames = seek(t);", "verify({ stutterEvents: 0 });", "render({ crf: 16 });"]
        font = fonts.get("mono", False, 24)
        lh = 46
        top = max(140, int(H * 0.32))
        left = 110
        card_w = int(W * 0.68)
        draw.rounded_rectangle([left, top, left + card_w, top + 36 + lh * len(lines)], radius=14,
                               fill=(255, 255, 255, 14), outline=(*hex_rgb(secondary), 90), width=1)
        reveal = clamp(t / (duration * 0.85), 0, 1) * (len(lines) + 0.001)
        for i, line in enumerate(lines):
            alpha = 255 if i < reveal else 30
            draw.text((left + 26, top + 18 + i * lh), line, font=font, fill=(*hex_rgb(fg), alpha))
        active = min(len(lines) - 1, int(reveal))
        draw.rounded_rectangle([left + 8, top + 18 + active * lh - 2, left + card_w - 8, top + 18 + (active + 1) * lh - 4],
                               radius=8, fill=(*hex_rgb(accent), 40))
        return

    values = payload.get("values") or [0.28, 0.52, 0.37, 0.78, 0.64]
    values = [float(v) for v in values]
    labels = payload.get("labels") or [str(i + 1) for i in range(len(values))]
    left, right = 130, W - 130
    base_y, top_y = H - 150, int(H * 0.34)
    if scene_type == "chart":
        slot = (right - left) / len(values)
        draw.rounded_rectangle([left - 40, top_y - 70, right + 40, base_y + 70], radius=18,
                               fill=(255, 255, 255, 10), outline=(*hex_rgb(secondary), 60), width=1)
        for i, v in enumerate(values):
            grow = ease("easeOutBack", clamp((t - 0.12 - i * 0.09) / 0.55, 0, 1))
            h = max(2, int(min(1, abs(v)) * (base_y - top_y) * grow))
            bw = min(120, slot * 0.55)
            x = left + slot * i + (slot - bw) / 2
            fill = accent if i == len(values) - 1 else secondary
            draw.rounded_rectangle([x, base_y - h, x + bw, base_y], radius=8, fill=hex_rgba(fill, 235))
            label = str(labels[i] if i < len(labels) else i + 1)
            lf = fonts.get("mono", False, 22)
            lw = lf.getlength(label) if HAVE_PIL else 20
            draw.text((x + bw / 2 - lw / 2, base_y + 16), label, font=lf, fill=(*hex_rgb(fg), 190))
        draw.line([left - 20, base_y + 1, right + 20, base_y + 1], fill=(*hex_rgb(secondary), 110), width=2)
        return

    # vectors / diagram / sequence
    draw.line([left - 30, base_y + 1, right + 30, base_y + 1], fill=(*hex_rgb(secondary), 90), width=2)
    pts = []
    for i, v in enumerate(values):
        px = left + (i / max(1, len(values) - 1)) * (right - left)
        py = base_y - max(0.0, min(1.0, v)) * (base_y - top_y)
        pts.append((px, py))
    draw_progress = ease("easeInOutCubic", clamp((t - 0.1) / max(0.001, duration * 0.55), 0, 1))
    seg_count = int(draw_progress * (len(pts) - 1))
    for i in range(seg_count):
        draw.line([pts[i], pts[i + 1]], fill=hex_rgba(accent), width=5)
    if 0 < draw_progress < 1 and seg_count < len(pts) - 1:
        a, b = pts[seg_count], pts[seg_count + 1]
        frac = draw_progress * (len(pts) - 1) - seg_count
        draw.line([a, (a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac)], fill=hex_rgba(accent), width=5)
    if draw_progress >= 0.99 and len(pts) > 1:
        tip = pts[-1]
        prev = pts[-2]
        ang = math.atan2(tip[1] - prev[1], tip[0] - prev[0])
        size_a = 14
        arrow = [
            tip,
            (tip[0] - size_a * math.cos(ang - 0.45), tip[1] - size_a * math.sin(ang - 0.45)),
            (tip[0] - size_a * math.cos(ang + 0.45), tip[1] - size_a * math.sin(ang + 0.45)),
        ]
        draw.polygon(arrow, fill=hex_rgba(accent))
    stagger = min(0.11, 0.5 / max(1, len(pts)))
    for i, (px, py) in enumerate(pts):
        p = clamp((t - 0.18 - i * stagger) / 0.34, 0, 1)
        if p <= 0:
            continue
        radius = int(10 * ease("easeOutBack", p))
        fill = accent if i == len(pts) - 1 else secondary
        draw.ellipse([px - radius, py - radius, px + radius, py + radius], fill=hex_rgba(fill, 255))
        label = f"{round(values[i] * 100)}%" if values[i] <= 1.0001 else str(round(values[i]))
        lf = fonts.get("mono", False, 24)
        lw = lf.getlength(label) if HAVE_PIL else 30
        draw.text((px - lw / 2, py - 48), label, font=lf, fill=(*hex_rgb(fg), int(255 * p)))


# ---------------------------------------------------------------------------
# Blender wireframe fallback
# ---------------------------------------------------------------------------

def primitive_wire(primitive):
    verts, edges, faces = [], [], []
    if primitive == "cube":
        verts = [(x, y, z) for x in (-0.5, 0.5) for y in (-0.5, 0.5) for z in (-0.5, 0.5)]
        edges = [(0, 1), (0, 2), (0, 4), (1, 3), (1, 5), (2, 3), (2, 6), (3, 7), (4, 5), (4, 6), (5, 7), (6, 7)]
        faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    elif primitive == "sphere":
        lat, lon = 8, 14
        for i in range(lat + 1):
            theta = math.pi * i / lat
            for j in range(lon):
                phi = TWO_PI * j / lon
                verts.append((0.5 * math.sin(theta) * math.cos(phi), 0.5 * math.cos(theta), 0.5 * math.sin(theta) * math.sin(phi)))
        for j in range(lon):
            for i in range(lat):
                a = i * lon + j
                b = i * lon + (j + 1) % lon
                edges.append((a, b))
        for i in range(lat):
            for j in range(lon):
                edges.append((i * lon + j, (i + 1) * lon + j))
    elif primitive == "torus":
        major_r, minor_r, maj, minr = 0.4, 0.13, 12, 10
        for i in range(maj):
            u = TWO_PI * i / maj
            for j in range(minr):
                v = TWO_PI * j / minr
                verts.append(((major_r + minor_r * math.cos(v)) * math.cos(u), minor_r * math.sin(v), (major_r + minor_r * math.cos(v)) * math.sin(u)))
        for i in range(maj):
            for j in range(minr):
                a = i * minr + j
                b = i * minr + (j + 1) % minr
                c = ((i + 1) % maj) * minr + j
                edges.append((a, b))
                edges.append((a, c))
    elif primitive == "plane":
        verts = [(-0.5, 0, -0.5), (0.5, 0, -0.5), (0.5, 0, 0.5), (-0.5, 0, 0.5)]
        edges = [(0, 1), (1, 2), (2, 3), (3, 0)]
    elif primitive == "cylinder":
        seg = 14
        for j in range(seg):
            phi = TWO_PI * j / seg
            verts.append((0.5 * math.cos(phi), -0.5, 0.5 * math.sin(phi)))
            verts.append((0.5 * math.cos(phi), 0.5, 0.5 * math.sin(phi)))
        for j in range(seg):
            edges.append((2 * j, 2 * j + 1))
            edges.append((2 * j, 2 * ((j + 1) % seg)))
            edges.append((2 * j + 1, 2 * ((j + 1) % seg) + 1))
    else:  # cone
        seg = 14
        verts.append((0, 0.55, 0))
        for j in range(seg):
            phi = TWO_PI * j / seg
            verts.append((0.5 * math.cos(phi), -0.5, 0.5 * math.sin(phi)))
        for j in range(seg):
            edges.append((0, 1 + j))
            edges.append((1 + j, 1 + (j + 1) % seg))
    return verts, edges, faces


def rotate_point(p, rot):
    rx, ry, rz = [math.radians(v) for v in rot]
    x, y, z = p
    y, z = y * math.cos(rx) - z * math.sin(rx), y * math.sin(rx) + z * math.cos(rx)
    x, z = x * math.cos(ry) + z * math.sin(ry), -x * math.sin(ry) + z * math.cos(ry)
    x, y = x * math.cos(rz) - y * math.sin(rz), x * math.sin(rz) + y * math.cos(rz)
    return (x, y, z)


def draw_scene_graph(base, draw, graph, tokens, t, W, H):
    cam = graph.get("camera") or {}
    cam_pos = sample_prop(cam.get("keyframes") or [], "position", t, cam.get("position") or [0, 1.4, 4.2])
    target = sample_prop(cam.get("keyframes") or [], "target", t, cam.get("target") or [0, 0, 0])
    fov = float(cam.get("fov", 45))
    forward = [target[i] - cam_pos[i] for i in range(3)]
    flen = math.sqrt(sum(v * v for v in forward)) or 1
    forward = [v / flen for v in forward]
    up_hint = [0, 1, 0]
    right = [forward[1] * up_hint[2] - forward[2] * up_hint[1], forward[2] * up_hint[0] - forward[0] * up_hint[2], forward[0] * up_hint[1] - forward[1] * up_hint[0]]
    rlen = math.sqrt(sum(v * v for v in right)) or 1
    right = [v / rlen for v in right]
    up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]]
    focal = 1.0 / math.tan(math.radians(fov) / 2)
    materials = {m["id"]: m for m in graph.get("materials", [])}
    mesh_palette = list((tokens.get("palette") or {}).values()) or ["#ffb703", "#8ecae6"]

    def project(p):
        rel = [p[i] - cam_pos[i] for i in range(3)]
        x = sum(rel[i] * right[i] for i in range(3))
        y = sum(rel[i] * up[i] for i in range(3))
        z = sum(rel[i] * forward[i] for i in range(3))
        if z <= 0.15:
            return None
        return (W / 2 + (x / z) * focal * (H / 2), H / 2 - (y / z) * focal * (H / 2))

    for mesh in graph.get("meshes", []):
        verts, edges, faces = primitive_wire(mesh.get("primitive", "cube"))
        kfs = mesh.get("keyframes") or []
        position = sample_prop(kfs, "position", t, mesh.get("position") or [0, 0, 0])
        rotation = sample_prop(kfs, "rotation", t, mesh.get("rotation") or [0, 0, 0])
        scale = sample_prop(kfs, "scale", t, mesh.get("scale") or [1, 1, 1])
        opacity = sample_prop(kfs, "opacity", t, 1.0)
        mat = materials.get(mesh.get("materialId"))
        color = mat["color"] if mat else mesh_palette[len(mesh_palette) % 3]
        pts = []
        for v in verts:
            p = rotate_point((v[0] * scale[0], v[1] * scale[1], v[2] * scale[2]), rotation)
            pts.append(project((p[0] + position[0], p[1] + position[1], p[2] + position[2])))
        alpha = int(255 * clamp(opacity, 0, 1))
        for face in faces:
            poly = [pts[i] for i in face if pts[i]]
            if len(poly) == len(face):
                draw.polygon(poly, fill=(*hex_rgb(color), int(alpha * 0.18)))
        for a, b in edges:
            if pts[a] and pts[b]:
                draw.line([pts[a], pts[b]], fill=(*hex_rgb(color), alpha), width=2)


# ---------------------------------------------------------------------------
# Layers / effects / camera
# ---------------------------------------------------------------------------

def cover_resize(img, w, h):
    iw, ih = img.size
    if iw <= 0 or ih <= 0:
        return img.resize((int(w), int(h)))
    scale = max(w / iw, h / ih)
    nw, nh = max(1, int(iw * scale)), max(1, int(ih * scale))
    resized = img.resize((nw, nh), Image.LANCZOS)
    left = (nw - int(w)) // 2
    top = (nh - int(h)) // 2
    return resized.crop((left, top, left + int(w), top + int(h)))


class SourceReader:
    def __init__(self, path_value, in_sec, fps, W, H):
        self.size = (W, H)
        self.need = W * H * 3
        self.proc = subprocess.Popen(
            [
                "ffmpeg", "-v", "error", "-ss", f"{max(0.0, in_sec):.3f}", "-i", path_value,
                "-vf", f"fps={fps},scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.last = Image.new("RGB", (W, H), (10, 16, 24))

    def frame(self):
        data = self.proc.stdout.read(self.need) if self.proc and self.proc.stdout else b""
        if data and len(data) >= self.need:
            self.last = Image.frombytes("RGB", self.size, data)
        return self.last.copy()

    def close(self):
        try:
            if self.proc:
                self.proc.kill()
        except Exception:
            pass


def draw_layer(base, draw, layer, assets, scene, tokens, t, W, H):
    ltype = layer.get("type")
    opacity = float(layer.get("opacity", 1))
    x, y = float(layer.get("x", 0)), float(layer.get("y", 0))
    for track in scene.get("keyframes", []):
        if track.get("target") != layer.get("id"):
            continue
        value = sample_track(track, t)
        prop = track.get("property")
        if prop == "x":
            x = value
        elif prop == "y":
            y = value
        elif prop == "opacity":
            opacity = value
    if opacity <= 0.01:
        return
    if ltype == "shape":
        w = float(layer.get("width") or W)
        h = float(layer.get("height") or H)
        color = hex_rgba(layer.get("color") or "#ffffff", int(255 * clamp(opacity, 0, 1)))
        radius = int(layer.get("radius", 0))
        if layer.get("glass"):
            color = (*color[:3], int(255 * 0.16 * opacity))
        draw.rounded_rectangle([x, y, x + w, y + h], radius=radius, fill=color)
        return
    if ltype in ("grain", "vignette"):
        return
    asset_id = layer.get("assetId")
    path_value = assets.get(asset_id)
    if not path_value or not os.path.exists(path_value):
        return
    target_w = float(layer.get("width") or W)
    target_h = float(layer.get("height") or H)
    ken = layer.get("kenBurns") or {}
    zoom = float(sample_prop(scene.get("keyframes", []), "scale", t, ken.get("scale", 1.0)) or 1.0) if ken else 1.0
    try:
        img = Image.open(path_value).convert("RGBA")
    except Exception:
        return
    img = cover_resize(img, target_w * zoom, target_h * zoom)
    if opacity < 1:
        alpha = img.getchannel("A").point(lambda a: int(a * opacity))
        img.putalpha(alpha)
    base.alpha_composite(img, (int(x - (img.width - target_w) / 2), int(y - (img.height - target_h) / 2)))


def seeded_noise(W, H, frame_index, seed, opacity):
    rng = random.Random(seed * 100003 + frame_index)
    small = Image.frombytes("L", (max(1, W // 4), max(1, H // 4)), bytes(rng.randint(0, 255) for _ in range((W // 4) * (H // 4))))
    noise = small.resize((W, H), Image.NEAREST)
    grain = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    grain.putalpha(noise.point(lambda v: int(v * opacity)))
    return grain


def vignette_overlay(W, H, strength):
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    steps = 24
    for i in range(steps):
        p = i / steps
        inset_x = W * 0.5 * (1 - p)
        inset_y = H * 0.5 * (1 - p)
        shade = int(255 * strength * p)
        d.rectangle([inset_x, inset_y, W - inset_x, H - inset_y], outline=shade, width=max(2, int(H * 0.03)))
    return mask


def apply_camera(img, scene, t, W, H):
    kfs = (scene.get("camera") or {}).get("keyframes") or []
    if not kfs:
        return img
    zoom = float(sample_prop(kfs, "zoom", t, 1.0))
    pan_x = float(sample_prop(kfs, "panX", t, 0.0))
    pan_y = float(sample_prop(kfs, "panY", t, 0.0))
    rot = float(sample_prop(kfs, "rotateZ", t, 0.0))
    content = img
    if zoom != 1.0:
        nw, nh = max(1, int(W * zoom)), max(1, int(H * zoom))
        content = img.resize((nw, nh), Image.BICUBIC)
        left = int((nw - W) / 2 + pan_x)
        top = int((nh - H) / 2 + pan_y)
        content = content.crop((left, top, left + W, top + H))
    elif pan_x or pan_y:
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(img, (int(-pan_x), int(-pan_y)))
        content = canvas
    if rot:
        content = content.rotate(-rot, resample=Image.BICUBIC, center=(W / 2, H / 2))
    return content


def apply_clip_reveal(img, clip, t, W, H):
    if not clip or clip.get("type", "none") == "none":
        return img
    p = clamp((t - float(clip.get("delaySec", 0))) / max(0.001, float(clip.get("durationSec", 0.7))), 0, 1)
    e = ease("easeInOutCubic", p)
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    kind = clip.get("type")
    if kind == "iris":
        r = int(e * 0.76 * math.hypot(W, H) / 2)
        d.ellipse([W / 2 - r, H / 2 - r, W / 2 + r, H / 2 + r], fill=255)
    elif kind == "diagonal":
        d.polygon([(0, 0), (e * 1.4 * W, 0), (e * 1.4 * W - 0.4 * W, H), (0, H)], fill=255)
    else:
        d.rectangle([0, 0, W * e, H], fill=255)
    out = img.copy()
    out.putalpha(Image.composite(img.getchannel("A"), Image.new("L", (W, H), 0), mask))
    return out


# ---------------------------------------------------------------------------
# Frame composition
# ---------------------------------------------------------------------------

class RenderContext:
    def __init__(self, bundle, readers):
        self.bundle = bundle
        self.scene = bundle["scene"]
        self.tokens = bundle.get("tokens") or {}
        self.assets = bundle.get("assets") or {}
        self.meta = bundle.get("meta") or {}
        self.graph = bundle.get("sceneGraph")
        self.fonts = FontBook(bundle)
        self.readers = readers
        self.W = int(self.meta.get("width", 1280))
        self.H = int(self.meta.get("height", 720))
        self.alpha = bool(self.meta.get("alpha"))
        self.seed = int(self.meta.get("seed", 424242))
        self.duration = float(self.meta.get("sceneDurationSec", 1.0))
        self.scene_start = float(self.meta.get("sceneStartSec", 0))
        self.captions = bundle.get("captions")
        self.aspect = self.meta.get("aspect") or {}

    def render(self, t, frame_index, lint_mode=False):
        scene = self.scene
        W, H = self.W, self.H
        bg = scene.get("background")
        if bg == "transparent" or self.alpha:
            base = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        else:
            base = Image.new("RGBA", (W, H), hex_rgba(bg or "#000000"))
        draw = ImageDraw.Draw(base)

        clip = scene.get("sourceClip")
        if clip:
            reader = self.readers.get("source")
            if reader is not None:
                frame = reader.frame()
                base.alpha_composite(frame.convert("RGBA"))
        if self.graph:
            draw_scene_graph(base, draw, self.graph, self.tokens, t, W, H)
        for layer in scene.get("layers", []):
            draw_layer(base, draw, layer, self.assets, scene, self.tokens, t, W, H)
        draw_choreo(base, draw, scene, self.tokens, t, self.duration, W, H, self.fonts)
        for el in scene.get("textElements", []):
            draw_text_element(base, draw, scene, self.tokens, el, t, W, H, self.fonts)
        draw_captions(base, draw, self.captions, self.scene_start, t, W, H, self.fonts, self.tokens)

        if not lint_mode:
            grain_opacity = float(self.tokens.get("grainOpacity", 0.05))
            for effect in scene.get("effects", []):
                if effect.get("type") == "grain":
                    grain_opacity = max(grain_opacity, float(effect.get("intensity", 0.2)) * 0.5)
                if effect.get("type") == "vignette":
                    base.alpha_composite(Image.merge("RGBA", (Image.new("L", (W, H), 0),) * 3 + (vignette_overlay(W, H, float(effect.get("intensity", 0.3))),)))
            if grain_opacity > 0.001:
                base.alpha_composite(seeded_noise(W, H, frame_index, self.seed, grain_opacity))

        clip_reveal = scene.get("clipReveal") or {}
        if clip_reveal.get("type", "none") != "none":
            base = apply_clip_reveal(base, clip_reveal, t, W, H)
        base = apply_camera(base, scene, t, W, H)
        return base


# ---------------------------------------------------------------------------
# Lint
# ---------------------------------------------------------------------------

def _zone_hit(box, aspect, W, H):
    if not aspect or not aspect.get("explicit"):
        return None
    zones = ((aspect.get("zones") or {}).get("dangerZones")) or []
    x, y, w, h = box
    for zone in zones:
        rect = zone.get("rect") or {}
        zx = float(rect.get("x", 0)) * W
        zy = float(rect.get("y", 0)) * H
        zw = float(rect.get("width", 0)) * W
        zh = float(rect.get("height", 0)) * H
        iw = min(x + w, zx + zw) - max(x, zx)
        ih = min(y + h, zy + zh) - max(y, zy)
        if iw > 1 and ih > 1 and iw * ih > 4:
            return zone
    return None


def lint_bundle(bundle):
    ctx = RenderContext(bundle, {})
    scene = ctx.scene
    W, H = ctx.W, ctx.H
    defects = []

    def add(category, detail, frame_index):
        defects.append({
            "category": category,
            "sceneId": scene.get("id", "scene"),
            "frameIndex": frame_index,
            "critical": category in ("clip", "brokenMedia", "blankFrame"),
            "detail": detail,
        })

    for layer in scene.get("layers", []):
        if layer.get("type") in ("image", "video", "svg", "png_alpha", "illustration"):
            asset_path = ctx.assets.get(layer.get("assetId"))
            if not asset_path or not os.path.exists(asset_path):
                add("brokenMedia", f'layer "{layer.get("id")}" asset missing on disk', 0)

    scene_len = max(0.001, float(ctx.meta.get("sceneDurationSec", 1)))
    frames = sorted({int(round(f * (max(1, int(scene_len * ctx.meta.get("fps", 30))) - 1))) for f in (0, 0.25, 0.5, 0.75, 1)})
    bg = scene.get("background") if scene.get("background") != "transparent" else "#000000"
    bg_rgb = hex_rgb(bg)
    for frame_index in frames:
        t = frame_index / float(ctx.meta.get("fps", 30))
        img = ctx.render(t, frame_index, lint_mode=True)
        text_count = 0
        for el in scene.get("textElements", []):
            boxes, opacity, *_ = text_boxes_for_element(scene, ctx.tokens, el, t, W, H, ctx.fonts)
            if opacity <= 0.02:
                continue
            for box in boxes:
                text_count += 1
                if box["x"] < -1 or box["y"] < -1 or box["x"] + box["w"] > W + 1 or box["y"] + box["h"] > H + 1:
                    add("clip", f'text "{el.get("id")}" extends outside the {W}x{H} viewport', frame_index)
                zone = _zone_hit((box["x"], box["y"], box["w"], box["h"]), ctx.aspect, W, H)
                if zone:
                    add("layout", f'text "{el.get("id")}" enters the {zone.get("label")} safe-zone', frame_index)
                size = float(el.get("sizePx", 40))
                ratio = contrast_ratio(hex_rgb(el.get("color", "#ffffff")), bg_rgb)
                needed = 3.0 if size >= 24 else 4.5
                if ratio < needed:
                    add("contrast", f'text "{el.get("id")}" contrast {ratio:.2f}:1 < {needed}:1', frame_index)
        for chunk in (ctx.captions or {}).get("chunks", []):
            band = chunk.get("safeBox") or {}
            cb = (
                float(band.get("xPercent", 0)) / 100 * W,
                float(band.get("yPercent", 0)) / 100 * H,
                float(band.get("widthPercent", 0)) / 100 * W,
                float(band.get("heightPercent", 0)) / 100 * H,
            )
            zone = _zone_hit(cb, ctx.aspect, W, H)
            if zone:
                add("layout", f'caption "{chunk.get("id")}" enters the {zone.get("label")} safe-zone', frame_index)
        grey = img.convert("L")
        lo, hi = grey.getextrema()
        has_content = text_count > 0 or bool(scene.get("layers")) or bool(scene.get("sourceClip")) or bool(ctx.graph) or bool(scene.get("enginePayload", {}).get("sceneType"))
        if (hi - lo) < 3 and not has_content:
            add("blankFrame", "frame contains no visible content", frame_index)
    # de-duplicate by (category, detail)
    seen = set()
    unique = []
    for defect in defects:
        key = (defect["category"], defect["detail"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(defect)
    return {"defects": unique}


# ---------------------------------------------------------------------------
# Pillow-less FFmpeg fallback
# ---------------------------------------------------------------------------

def ffmpeg_fallback(bundle):
    meta = bundle.get("meta") or {}
    scene = bundle.get("scene") or {}
    W, H = int(meta.get("width", 1280)), int(meta.get("height", 720))
    fps = float(meta.get("fps", 30))
    duration = float(meta.get("durationSec", 1))
    alpha = bool(meta.get("alpha"))
    fonts = bundle.get("fontFiles") or {}
    font_file = fonts.get("bold") or fonts.get("regular")
    bg = scene.get("background") if scene.get("background") != "transparent" else "black@0.0"
    filters = []
    def escape_font(path_value):
        return path_value.replace(chr(92), "/").replace(":", chr(92) + ":")

    for el in scene.get("textElements", []):
        text = str(el.get("text", "")).replace("'", "").replace(":", "")
        color = str(el.get("color", "#ffffff")).replace("#", "0x")
        opts = f"text='{text}':x={int(el.get('x', 60))}:y={int(el.get('y', 60))}:fontsize={int(el.get('sizePx', 48))}:fontcolor={color}"
        if font_file:
            opts += f":fontfile='{escape_font(font_file)}'"
        filters.append(f"drawtext={opts}")

    caps = bundle.get("captions") or {}
    scene_start = float(meta.get("sceneStartSec", 0))
    cap_size = max(16, int(H * (0.045 if H > W else 0.05)))
    for chunk in caps.get("chunks", []):
        start = max(0.0, float(chunk.get("startSec", 0)) - scene_start)
        end = min(duration, float(chunk.get("endSec", 0)) - scene_start)
        if end <= start:
            continue
        text = caption_casing(str(chunk.get("text", "")), (caps.get("typography") or {}).get("casing", "upper"))
        text = text.replace("'", "").replace(":", "").replace(",", " ")
        band = chunk.get("safeBox") or {}
        band_y = float(band.get("yPercent", 62)) / 100 * H + float(band.get("heightPercent", 14)) / 100 * H * 0.3
        opts = (
            f"text='{text}':x=(w-text_w)/2:y={int(band_y)}:fontsize={cap_size}"
            f":fontcolor=0xffffff:box=1:boxcolor=0x00000099:boxborderw=14"
            f":enable='between(t,{start:.3f},{end:.3f})'"
        )
        if font_file:
            opts += f":fontfile='{escape_font(font_file)}'"
        filters.append(f"drawtext={opts}")

    vf = ",".join(filters) if filters else "null"
    pix = "rgba" if alpha else "rgb24"
    cmd = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c={bg}:s={W}x{H}:d={duration}:r={fps}", "-vf", vf,
           "-f", "rawvideo", "-pix_fmt", pix, "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    while True:
        chunk = proc.stdout.read(65536)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--mode", default="render", choices=["render", "lint"])
    parser.add_argument("--out", default="-")
    args = parser.parse_args()
    with open(args.bundle, "r", encoding="utf-8") as handle:
        bundle = json.load(handle)

    if args.mode == "lint":
        result = lint_bundle(bundle) if HAVE_PIL else {"defects": []}
        print(json.dumps(result))
        return

    if not HAVE_PIL:
        ffmpeg_fallback(bundle)
        return

    meta = bundle.get("meta") or {}
    W, H = int(meta.get("width", 1280)), int(meta.get("height", 720))
    fps = float(meta.get("fps", 30))
    duration = float(meta.get("durationSec", 1))
    alpha = bool(meta.get("alpha"))
    samples = max(1, min(4, int(meta.get("motionBlurSamples", 1))))
    readers = {}
    clip = (bundle.get("scene") or {}).get("sourceClip")
    if clip:
        readers["source"] = SourceReader(clip["path"], float(clip.get("inSec", 0)), fps, W, H)
    ctx = RenderContext(bundle, readers)
    total = max(1, int(round(duration * fps)))
    out = sys.stdout.buffer
    try:
        for frame_index in range(total):
            if samples > 1:
                acc = None
                for s in range(samples):
                    t = (frame_index + s / samples) / fps
                    img = ctx.render(t, frame_index)
                    acc = img if acc is None else Image.blend(acc, img, 1.0 / (s + 1))
                img = acc
            else:
                img = ctx.render(frame_index / fps, frame_index)
            frame = img.convert("RGBA") if alpha else img.convert("RGB")
            out.write(frame.tobytes())
        out.flush()
    except BrokenPipeError:
        pass
    finally:
        for reader in readers.values():
            reader.close()


if __name__ == "__main__":
    main()
