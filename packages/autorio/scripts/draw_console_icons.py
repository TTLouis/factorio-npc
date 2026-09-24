#!/usr/bin/env python3
"""Draw the console title-bar icons (graphics/icons/console/*.png).

Pure standard library so it runs anywhere: each icon is a handful of stroked
segments, circles and ellipses rasterised at 4x and averaged down, then written
as a 32x32 RGBA PNG. Two variants per icon: a light one for the dark title bar
and a dark one for the hovered/clicked button, the same pair Factorio's own
frame action buttons use.

Run from packages/autorio:  python3 scripts/draw_console_icons.py
The output is deterministic, so re-running it produces identical files.
"""

import math
import os
import struct
import zlib

SIZE = 32
SUPER = 4
STROKE = 2.4
VARIANTS = {'white': (232, 232, 232), 'black': (24, 24, 24)}


def segment(ax, ay, bx, by):
    def distance(x, y):
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(x - (ax + t * dx), y - (ay + t * dy))
    return distance


def circle(cx, cy, r):
    return lambda x, y: abs(math.hypot(x - cx, y - cy) - r)


def ellipse(cx, cy, rx, ry):
    # Distance to an ellipse outline, approximated by scaling to a unit circle.
    def distance(x, y):
        nx, ny = (x - cx) / rx, (y - cy) / ry
        return abs(math.hypot(nx, ny) - 1) * min(rx, ry)
    return distance


def polyline(*points):
    return [segment(*points[i], *points[i + 1]) for i in range(len(points) - 1)]


ICONS = {
    # An open book: two pages meeting at the spine.
    'learn': [
        *polyline((16, 9), (5, 6.5), (5, 23.5), (16, 26)),
        *polyline((16, 9), (27, 6.5), (27, 23.5), (16, 26)),
        segment(16, 9, 16, 26),
    ],
    # A clock face with two hands: past tasks.
    'history': [
        circle(16, 16, 10.5),
        segment(16, 16, 16, 9.5),
        segment(16, 16, 20.5, 19),
    ],
    # A bug: head, body and three legs a side.
    'debug': [
        circle(16, 8, 3),
        ellipse(16, 18.5, 6, 8),
        segment(16, 12, 16, 26),
        segment(10.5, 14, 5, 11.5), segment(21.5, 14, 27, 11.5),
        segment(10, 19, 4, 19), segment(22, 19, 28, 19),
        segment(10.5, 24, 5.5, 27.5), segment(21.5, 24, 26.5, 27.5),
    ],
}


def coverage(shapes):
    alpha = []
    for py in range(SIZE):
        row = []
        for px in range(SIZE):
            hits = 0
            for sy in range(SUPER):
                for sx in range(SUPER):
                    x = px + (sx + 0.5) / SUPER
                    y = py + (sy + 0.5) / SUPER
                    if any(shape(x, y) <= STROKE / 2 for shape in shapes):
                        hits += 1
            row.append(round(255 * hits / (SUPER * SUPER)))
        alpha.append(row)
    return alpha


def png(path, alpha, rgb):
    raw = b''.join(b'\x00' + b''.join(struct.pack('BBBB', *rgb, a) for a in row) for row in alpha)

    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

    with open(path, 'wb') as out:
        out.write(b'\x89PNG\r\n\x1a\n')
        out.write(chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)))
        out.write(chunk(b'IDAT', zlib.compress(raw, 9)))
        out.write(chunk(b'IEND', b''))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(here, '..', 'graphics', 'icons', 'console')
    os.makedirs(target, exist_ok=True)
    for name, shapes in ICONS.items():
        alpha = coverage(shapes)
        for variant, rgb in VARIANTS.items():
            png(os.path.join(target, f'{name}-{variant}.png'), alpha, rgb)


if __name__ == '__main__':
    main()
