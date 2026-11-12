"""Glyph outlines as one SVG path, for type that must scale far beyond what a browser will draw as text.

    python3 glyph-outline.py <font file> <font size px> '<json: [{"c": "w", "x": 60, "y": 1124}, ...]>'

Each character is drawn from the font's own outline at its pen position (x, y = baseline, in px, as the browser laid
it out: kerning and tracking included). Prints the path's d attribute. Needs fontTools.
"""
import json
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def outline(font_file: str, size: float, chars: list) -> str:
    font = TTFont(font_file)
    glyphs, cmap, scale = font.getGlyphSet(), font.getBestCmap(), size / font["head"].unitsPerEm
    pen = SVGPathPen(glyphs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    for ch in chars:
        name = cmap.get(ord(ch["c"]))
        if name is None or not ch["c"].strip():
            continue
        # Font units are y-up from the baseline; the frame is y-down. Scale, flip, and move to the pen position.
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, ch["x"], ch["y"])))
    return pen.getCommands()


if __name__ == "__main__":
    print(outline(sys.argv[1], float(sys.argv[2]), json.loads(sys.argv[3])))
