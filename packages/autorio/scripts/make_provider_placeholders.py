#!/usr/bin/env python3
"""Write a placeholder provider avatar.

These are not artwork. Each file is a flat plate in the vendor's brand color, so
that the console button is visibly per-vendor before the real icon has been
dropped in, and so the data stage - which has no file-exists test and treats a
missing sprite file as a hard load failure - always finds a file to load.

Real artwork is imported with import_provider_icon.py instead. Writing a
placeholder over one would throw that away, so an existing file is never
overwritten without --force.

Usage:
  python packages/autorio/scripts/make_provider_placeholders.py <provider-id>...
  python packages/autorio/scripts/make_provider_placeholders.py openai --force
"""

from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw

# Matches import_provider_icon.py, because every provider sprite shares one
# `size` in data.lua.
SIZE = 128
SS = 4
N = SIZE * SS
OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "graphics", "icons", "provider"),
)

PLACEHOLDERS = {
    "claude": (217, 119, 87),
    "openai": (16, 163, 127),
    "deepseek": (77, 107, 254),
}


def darken(color, amount):
    return tuple(round(channel * (1 - amount)) for channel in color)


def main():
    providers = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    force = "--force" in sys.argv
    if not providers:
        raise SystemExit(__doc__)
    unknown = [name for name in providers if name not in PLACEHOLDERS]
    if unknown:
        raise SystemExit(f"No brand color for: {', '.join(unknown)}")

    os.makedirs(OUT_DIR, exist_ok=True)
    for name in providers:
        color = PLACEHOLDERS[name]
        target = os.path.join(OUT_DIR, name + ".png")
        if os.path.exists(target) and not force:
            raise SystemExit(f"{target} already exists; pass --force to replace it with a placeholder")
        image = Image.new("RGBA", (N, N), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle([0, 0, N - 1, N - 1], radius=SS * 28, fill=darken(color, 0.62) + (255,))
        draw.rounded_rectangle(
            [SS * 10, SS * 10, N - 1 - SS * 10, N - 1 - SS * 10],
            radius=SS * 20,
            fill=color + (255,),
        )
        image.resize((SIZE, SIZE), Image.LANCZOS).save(target)
        print("wrote " + target)


if __name__ == "__main__":
    main()
