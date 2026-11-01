#!/usr/bin/env python3
"""Render provider avatars at their actual 48px-button / 40px-canvas geometry."""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "graphics", "icons", "provider"))
PROVIDERS = ("claude", "openai", "deepseek", "gemini", "qwen")
VARIANTS = 4
BUTTON = 48
CANVAS = 40
LABEL_WIDTH = 92
ROW_HEIGHT = 66
TOP = 28
GAP = 10


def main():
    output = sys.argv[1] if len(sys.argv) > 1 else "provider-icons-contact-sheet.png"
    width = LABEL_WIDTH + VARIANTS * (BUTTON + GAP) + GAP
    height = TOP + len(PROVIDERS) * ROW_HEIGHT + GAP
    sheet = Image.new("RGBA", (width, height), (24, 24, 24, 255))
    draw = ImageDraw.Draw(sheet)

    draw.text((8, 8), "48px button / 40px provider canvas", fill=(230, 230, 230, 255))
    for variant in range(1, VARIANTS + 1):
        x = LABEL_WIDTH + (variant - 1) * (BUTTON + GAP)
        draw.text((x + 18, 8), str(variant), fill=(180, 180, 180, 255))

    for row, provider in enumerate(PROVIDERS):
        y = TOP + row * ROW_HEIGHT
        draw.text((8, y + 18), provider, fill=(230, 230, 230, 255))
        for variant in range(1, VARIANTS + 1):
            name = f"{provider}-{variant}.png"
            path = os.path.join(ICON_DIR, name)
            if not os.path.exists(path):
                raise SystemExit(f"missing {path}")
            icon = Image.open(path).convert("RGBA").resize((CANVAS, CANVAS), Image.LANCZOS)
            x = LABEL_WIDTH + (variant - 1) * (BUTTON + GAP)
            draw.rectangle((x, y, x + BUTTON - 1, y + BUTTON - 1), fill=(48, 48, 48, 255), outline=(96, 96, 96, 255))
            sheet.alpha_composite(icon, (x + (BUTTON - CANVAS) // 2, y + (BUTTON - CANVAS) // 2))

    sheet.save(output)
    print(f"wrote {output}")


if __name__ == "__main__":
    main()
