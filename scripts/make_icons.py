#!/usr/bin/env python3
"""Generate extension icons (stdlib only): 16x16 pixel art, nearest-neighbor upscale."""
import struct, zlib, os

def png(path, px):
    h, w = len(px), len(px[0])
    raw = b"".join(b"\x00" + b"".join(struct.pack("4B", *px[y][x]) for x in range(w)) for y in range(h))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))

BG   = (22, 24, 42, 255)    # dark slate
BAR  = (79, 140, 255, 255)  # accent blue (tab strip)
INK  = (232, 234, 242, 255) # light glyph

def glyph16():
    g = [[BG] * 16 for _ in range(16)]
    # tab strip across the top
    for x in range(16):
        for y in range(3):
            g[y][x] = BAR
    g[1][1] = BG; g[1][2] = BG; g[1][3] = BG  # fake tab notch
    # globe: circle centered (8, 10), r=4
    cx, cy, r = 8, 10, 4
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if r * r - 1 <= d2 <= r * r + 2:
                g[y][x] = INK
            elif d2 < r * r - 1 and ((y == cy) or (x == cx) or (y == cy - 1) or (y == cy + 1) or (x == cx - 1) or (x == cx + 1)):
                g[y][x] = INK  # meridians + equator grid
    return g

def upscale(g, k):
    out = []
    for row in g:
        big_row = []
        for px in row:
            big_row.extend([px] * k)
        for _ in range(k):
            out.append(big_row)
    return out

def main():
    outdir = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
    os.makedirs(outdir, exist_ok=True)
    g = glyph16()
    for size in (16, 32, 48, 128):
        png(os.path.join(outdir, f"icon{size}.png"), upscale(g, size // 16))
    print("icons written to", outdir)

if __name__ == "__main__":
    main()
