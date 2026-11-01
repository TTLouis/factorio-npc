#!/usr/bin/env python3
"""Import a provider avatar from source artwork.

Turns artwork of any size into the square, transparent, 128x128 PNG the mod's
sprite prototype expects. The automatic head normalization is followed by a
small per-avatar optical correction from provider_icon_optical.json when one is
recorded; this keeps hair ornaments and other silhouette outliers from making
one model avatar look smaller than its neighbours.

A white-background source is keyed to transparent first. That is a flood fill
from the border rather than a global "white is transparent" test, so white
inside the drawing - a maid headdress, an eye highlight - survives.

Framing is the part worth getting right, because every avatar sits in the same
button and an inconsistent one reads as a mistake:

  --slice X0:X1   take one figure out of a multi-figure sheet by pixel column.
  --head N        scale so the head is N of the icon's 128 pixels wide. This
                  is the setting that keeps a set consistent, and the one to
                  reach for by default: the head is measured in each source, so
                  it does not matter how large each drawing is on its own
                  canvas. Squaring a figure by its bounding box instead scales
                  a short drawing up more than a tall one, and the heads come
                  out different sizes.
  --frame SIDE    crop a fixed SIDE x SIDE box out of the SOURCE instead. Only
                  equivalent when every figure is drawn at one scale, as on a
                  single sheet.
  --anchor F      where the widest row sits in that box, top to bottom. The
                  head decides the scale; the bottom decides the placement, so
                  this only positions a figure that already reaches the bottom.
  --no-baseline   do not sit the figure on the bottom edge (see below).
  --scale F       override the per-avatar optical scale from
                  scripts/provider_icon_optical.json.
  --offset-x N    override the optical horizontal shift, in 128px-canvas units.
  --offset-y N    override the optical vertical shift, in 128px-canvas units.
  --no-optical-adjustment
                  ignore the per-avatar optical manifest for this import.
  --size N        output N x N instead of the mod's 128. Framing is unchanged,
                  so a larger size is the same picture with more pixels - see
                  assets/provider/ for the archived 256 set.
  --out-dir DIR   write somewhere other than the mod's graphics folder.
  --keep-top F    for single portrait art with no sheet to match: drop the
                  bottom of the drawing before squaring by bounding box, so
                  the costume does not eat the frame.

Usage:
  python packages/autorio/scripts/import_provider_icon.py <source> <id> [options]
  ... <source> <id> --head 102
  ... <source> <id> --slice 878:1300 --head 102
  ... <source> <id> --keep-top 0.72
  ... <source> <id> --check
"""

from __future__ import annotations

import json
import os
import sys
from collections import deque

from PIL import Image

# 128 source pixels drawn at 32 GUI units, so the icon stays crisp at the 200%
# UI scale Factorio allows instead of being upscaled from a 1:1 source.
TARGET = 128
# Share of the square the artwork fills, so it does not touch the button border.
INSET = 0.94
# How far a border pixel may differ from white and still be treated as backdrop.
WHITE_TOLERANCE = 18
# Only the upper part of a figure is searched for the widest row; below that a
# costume or a held prop is often wider than the head.
HEAD_BAND = 0.62
DEFAULT_ANCHOR = 0.55
# How far a figure may be pushed down to reach the bottom edge, as a share of
# the frame. Most need a few percent. Needing much more means the artwork is
# proportioned unlike the rest of the set, which is worth seeing rather than
# silently shoving into place.
MAX_BASELINE_SHIFT = 0.15
# Head width in the finished icon, in its 128 pixels. Chosen so the head fills
# the button without the hair touching its border; every avatar uses it.
DEFAULT_HEAD = 102

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(
    os.path.join(SCRIPT_DIR, "..", "graphics", "icons", "provider"),
)
OPTICAL_ADJUSTMENTS_PATH = os.path.join(SCRIPT_DIR, "provider_icon_optical.json")


def key_white_background(image):
    """Flood-fill transparency in from the border, so interior white is kept."""
    width, height = image.size
    pixels = image.load()

    def is_backdrop(x, y):
        r, g, b, a = pixels[x, y]
        return a == 0 or min(r, g, b) >= 255 - WHITE_TOLERANCE

    seen = bytearray(width * height)
    queue = deque()
    border = [(x, y) for x in range(width) for y in (0, height - 1)]
    border += [(x, y) for y in range(height) for x in (0, width - 1)]
    for x, y in border:
        if is_backdrop(x, y) and not seen[y * width + x]:
            seen[y * width + x] = 1
            queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height and not seen[ny * width + nx] and is_backdrop(nx, ny):
                seen[ny * width + nx] = 1
                queue.append((nx, ny))
    return image


def widest_head_row(art):
    """(width, y, centre_x) of the widest opaque row in the head band."""
    pixels = art.getchannel("A").load()
    best = (0, 0, art.width / 2)
    for y in range(max(1, int(art.height * HEAD_BAND))):
        row = [x for x in range(art.width) if pixels[x, y] > 8]
        if not row:
            continue
        width = row[-1] - row[0] + 1
        if width > best[0]:
            best = (width, y, (row[0] + row[-1]) / 2)
    return best


def to_icon(source_path, slice_x=None, frame=None, head=None, anchor=DEFAULT_ANCHOR, keep_top=1.0, size=TARGET, baseline=True, scale=1.0, offset_x=0.0, offset_y=0.0):
    image = Image.open(source_path).convert("RGBA")
    if image.getchannel("A").getextrema()[0] == 255:
        image = key_white_background(image)
    if slice_x is not None:
        image = image.crop((slice_x[0], 0, slice_x[1] + 1, image.height))

    box = image.getchannel("A").getbbox()
    if box is None:
        raise SystemExit(f"{source_path}: nothing left after keying the background")
    art = image.crop(box)

    if frame is not None or head is not None:
        measured, y, centre = widest_head_row(art)
        if measured == 0:
            raise SystemExit(f"{source_path}: could not measure a head to frame against")
        # The square is downscaled to size * INSET, so a head of `head` pixels
        # per 128 of output needs this much source around it. Scaling the target
        # with the size keeps framing identical across output sizes.
        wanted = head * size / TARGET
        side = frame if frame is not None else max(1, round(measured * size * INSET / wanted))
        side = max(1, round(side / scale))
        top = -round(y - anchor * side)
        # Sit the figure on the bottom edge. Anchoring on the head alone scales
        # every avatar alike but leaves each one wherever its own costume ends,
        # so a figure whose art stops early floats above the button's edge while
        # its neighbours are cut flush by it. Only ever pushed down: a figure
        # already running past the edge is flush there by definition, and
        # pulling it up would drag its head out of frame.
        drop = side - (top + art.height)
        if drop > 0:
            limit = round(side * MAX_BASELINE_SHIFT)
            if baseline:
                top += min(drop, limit)
            if drop > limit:
                print(f"note: {os.path.basename(source_path)} sits {drop} px above the edge, past the {limit} px limit")
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.paste(art, (-round(centre - side / 2), top))
    else:
        if keep_top < 1.0:
            art = art.crop((0, 0, art.width, max(1, round(art.height * keep_top))))
            trimmed = art.getchannel("A").getbbox()
            if trimmed is None:
                raise SystemExit(f"{source_path}: --keep-top {keep_top} cropped everything away")
            art = art.crop(trimmed)
        side = max(art.size)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.paste(art, ((side - art.width) // 2, (side - art.height) // 2))

    inner = max(1, round(size * INSET))
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # Optical offsets are recorded in 128px-canvas units so the same manifest
    # works for both the shipped 128px files and archived 256px copies.
    output_scale = size / TARGET
    left = (size - inner) // 2 + round(offset_x * output_scale)
    top = (size - inner) // 2 + round(offset_y * output_scale)
    icon.paste(square.resize((inner, inner), Image.LANCZOS), (left, top))
    return icon


def load_optical_adjustments(path=OPTICAL_ADJUSTMENTS_PATH):
    """Return per-avatar visual corrections recorded outside runtime code."""
    if not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    avatars = payload.get("avatars", {})
    if not isinstance(avatars, dict):
        raise SystemExit(f"{path}: 'avatars' must be an object")
    return avatars


def take(argv, flag, convert, default):
    if flag not in argv:
        return default
    at = argv.index(flag)
    try:
        value = convert(argv[at + 1])
    except (IndexError, ValueError):
        raise SystemExit(f"{flag} needs a value")
    del argv[at:at + 2]
    return value


def head_width(icon):
    """Rough head width, normalized to 128, for the consistency report."""
    pixels = icon.getchannel("A").load()
    scale = icon.width / TARGET
    rows = range(round(40 * scale), round(80 * scale))
    row = [x for y in rows for x in range(icon.width) if pixels[x, y] > 8]
    return round((max(row) - min(row) + 1) / scale) if row else 0


def bottom_edge(icon):
    """Where the figure ends, normalized to 128. Equal across a set means the
    avatars sit on one line instead of each floating at its own height."""
    box = icon.getchannel("A").getbbox()
    return round(box[3] / (icon.width / TARGET)) if box else 0


def main():
    argv = sys.argv[1:]
    check_only = "--check" in argv
    no_optical_adjustment = "--no-optical-adjustment" in argv
    slice_x = take(argv, "--slice", lambda v: tuple(int(part) for part in v.split(":")), None)
    frame = take(argv, "--frame", int, None)
    head = take(argv, "--head", int, None)
    anchor = take(argv, "--anchor", float, DEFAULT_ANCHOR)
    keep_top = take(argv, "--keep-top", float, 1.0)
    size = take(argv, "--size", int, TARGET)
    out_dir = take(argv, "--out-dir", str, OUT_DIR)
    baseline = "--no-baseline" not in argv
    scale_override = take(argv, "--scale", float, None)
    offset_x_override = take(argv, "--offset-x", float, None)
    offset_y_override = take(argv, "--offset-y", float, None)

    if size < 16:
        raise SystemExit("--size must be at least 16")
    if slice_x is not None and len(slice_x) != 2:
        raise SystemExit("--slice takes X0:X1")
    if frame is not None and head is not None:
        raise SystemExit("--frame and --head are alternatives, not both")
    if frame is None and head is None and keep_top == 1.0:
        head = DEFAULT_HEAD
    if not 0 < keep_top <= 1 or not 0 < anchor < 1:
        raise SystemExit("--keep-top and --anchor are fractions")

    args = [arg for arg in argv if not arg.startswith("--")]
    if len(args) != 2:
        raise SystemExit(__doc__)
    source, provider = args

    adjustment = {}
    if not no_optical_adjustment:
        candidate = load_optical_adjustments().get(provider, {})
        if isinstance(candidate, dict):
            adjustment = candidate
    scale = scale_override if scale_override is not None else float(adjustment.get("scale", 1.0))
    offset_x = offset_x_override if offset_x_override is not None else float(adjustment.get("offset_x", 0.0))
    offset_y = offset_y_override if offset_y_override is not None else float(adjustment.get("offset_y", 0.0))
    if not 0.5 <= scale <= 2:
        raise SystemExit("--scale/manifest scale must be a multiplier between 0.5 and 2")
    if abs(offset_x) > 32 or abs(offset_y) > 32:
        raise SystemExit("--offset-x/--offset-y and manifest offsets must stay within 32px")

    icon = to_icon(
        source,
        slice_x,
        frame,
        head,
        anchor,
        keep_top,
        size,
        baseline,
        scale,
        offset_x,
        offset_y,
    )
    report = (
        f"{provider}: {icon.size[0]}x{icon.size[1]}, head {head_width(icon)}px, "
        f"bottom {bottom_edge(icon)}, optical scale {scale:g}, shift {offset_x:+g},{offset_y:+g}"
    )
    if check_only:
        print(f"{report} (not written)")
        return

    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, provider + ".png")
    icon.save(out)
    print(f"wrote {out} - {report}")


if __name__ == "__main__":
    main()
