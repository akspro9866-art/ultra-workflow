#!/usr/bin/env python3
"""Build the offline bundled fonts in assets/fonts/ from open-license variable sources.

Sources (SIL Open Font License 1.1, via the google/fonts repository):
  - Space Grotesk  https://github.com/floriankarsten/space-grotesk
  - Inter          https://github.com/rsms/inter
  - JetBrains Mono https://github.com/JetBrains/JetBrainsMono

The script downloads the variable TTFs, pins a single weight with fontTools
varLib.instancer, subsets to Latin + typographic punctuation (keeps files small
for the cloud zip), and renames the families to Ultra* so cloud agents can rely
on stable family names. Run: `python scripts/make-bundled-fonts.py`.
"""

from __future__ import annotations

import io
import os
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "fonts")

SOURCES = {
    "sg": "https://raw.githubusercontent.com/google/fonts/main/ofl/spacegrotesk/SpaceGrotesk%5Bwght%5D.ttf",
    "inter": "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf",
    "jbm": "https://raw.githubusercontent.com/google/fonts/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf",
}

# Latin + Latin-1 supplement + the punctuation/symbols captions actually use.
UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+2013-2014,U+2018-201D,U+2020-2022,U+2026,U+2030,"
    "U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2260,U+2264-2265,U+25B6,U+2713"
)

TARGETS = [
    # (source key, output file, family, subfamily, weight, axes)
    ("sg", "UltraDisplay-Bold.ttf", "Ultra Display", "Bold", 700, {"wght": 700}),
    ("inter", "UltraSans-Regular.ttf", "Ultra Sans", "Regular", 400, {"opsz": 16, "wght": 400}),
    ("inter", "UltraSans-Bold.ttf", "Ultra Sans", "Bold", 700, {"opsz": 16, "wght": 700}),
    ("jbm", "UltraMono-Regular.ttf", "Ultra Mono", "Regular", 400, {"wght": 400}),
]


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


def set_names(font: TTFont, family: str, subfamily: str) -> None:
    name = font["name"]
    full = family if subfamily == "Regular" else f"{family} {subfamily}"
    postscript = full.replace(" ", "")
    values = {
        1: family,
        2: subfamily,
        3: f"{family}; Ultra Workflow bundled build",
        4: full,
        6: postscript,
        16: family,
        17: subfamily,
    }
    # Replace the English Windows records; drop other platform copies to avoid stale names.
    name.names = type(name.names)()
    for name_id, value in values.items():
        name.setName(value, name_id, 3, 1, 0x409)
        name.setName(value, name_id, 1, 0, 0)
    if subfamily == "Bold":
        font["OS/2"].usWeightClass = 700
        font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0x40) | 0x20
        font["head"].macStyle |= 0x01
    else:
        font["OS/2"].usWeightClass = 400
        font["OS/2"].fsSelection = (font["OS/2"].fsSelection & ~0x20) | 0x40
        font["head"].macStyle &= ~0x01


def build(source_bytes: bytes, target, tmp_dir: str) -> int:
    key, filename, family, subfamily, _weight, axes = target
    font = TTFont(io.BytesIO(source_bytes))
    if "fvar" in font:
        font = instancer.instantiateVariableFont(font, axes, inplace=False, updateFontNames=False)
    set_names(font, family, subfamily)
    raw_path = os.path.join(tmp_dir, key + "-" + filename)
    font.save(raw_path)

    out_path = os.path.join(OUT, filename)
    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt", "ccmp", "mark", "mkmk"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["DSIG", "MVAR", "STAT", "fvar", "gvar", "avar", "HVAR", "VVAR"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)
    font.save(out_path)
    return os.path.getsize(out_path)


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    tmp_dir = os.path.join(ROOT, "tmp", "fonts-build")
    os.makedirs(tmp_dir, exist_ok=True)
    cache: dict[str, bytes] = {}
    total = 0
    for target in TARGETS:
        key = target[0]
        if key not in cache:
            cache[key] = download(SOURCES[key])
        size = build(cache[key], target, tmp_dir)
        total += size
        print(f"  {target[1]:26s} {size / 1024:7.1f} KiB")
    print(f"total bundled fonts: {total / 1024:.1f} KiB (target <= 650 KiB)")
    if total > 650 * 1024:
        print("ERROR: bundled fonts exceed 650 KiB", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
