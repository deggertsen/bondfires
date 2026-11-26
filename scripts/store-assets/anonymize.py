#!/usr/bin/env python3
"""Blur other people's faces and drop last names in raw captures.

Usage: python3 -I anonymize.py <caps_dir>
Reads raw-*.png, writes anon-*.png (same size). Coordinates are full-res px.
"""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

caps = sys.argv[1]

# circles: (cx, cy, r); rects: (x0, y0, x1, y1, radius); clip_y: don't touch at/after this y
SPEC = {
    "raw-my-fires": {
        "circles": [(390, 888, 38), (390, 1476, 38), (390, 1770, 38), (390, 2065, 38)],
        "rects": [(48, 1890, 270, 2112, 30)],
        # (band_y0, band_y1, x_start, word_index_to_drop)
        "drop_word": [(1958, 2008, 300, 1, 960)],
    },
    "raw-thread-browser": {
        "circles": [(113, 1711, 62), (113, 2323, 62), (113, 2499, 62)],
        "clip_y": 2530,
    },
    "raw-spark": {
        "circles": [(390, 975, 92), (869, 975, 92), (1109, 975, 92), (1291, 975, 92)],
    },
    "raw-camp-detail": {
        "drop_word": [(1975, 2030, 230, 1, 900)],
    },
    # iPad 13" captures (2064x2752)
    "ipad-raw-thread-browser": {
        "circles": [(75, 1561, 44), (75, 1969, 44), (75, 2106, 44)],
        "grabber": True,
    },
    "ipad-raw-my-fires": {
        "circles": [(262, 592, 23), (262, 985, 23), (262, 1181, 23), (262, 1376, 23),
                    (262, 1768, 23), (259, 2161, 22), (262, 2553, 23)],
        "rects": [(30, 1258, 180, 1408, 22)],
        "drop_word": [(1303, 1340, 200, 1, 1000), (2087, 2124, 200, 1, 1000)],
        "gap": 7,
        "grabber": True,
    },
    "ipad-raw-spark": {
        "circles": [(419, 592, 62), (739, 592, 62), (898, 592, 62), (1059, 592, 62)],
        "grabber": True,
    },
    "ipad-raw-camp-detail": {
        "drop_word": [(1235, 1272, 150, 1, 1200)],
        "gap": 7,
        "grabber": True,
    },
    "ipad-camps-raw": {"grabber": True},
    "ipad-player": {"grabber": True},
}


def remove_grabber(im):
    """Paint out iPadOS's bottom-right window-resize grabber by copying the
    pixel column just left of it across each row."""
    x0, y0 = im.width - 80, im.height - 80
    px = im.load()
    for y in range(y0, im.height):
        c = px[x0 - 1, y]
        for x in range(x0, im.width):
            px[x, y] = c


def blur_regions(im, spec):
    mask = Image.new("L", im.size, 0)
    d = ImageDraw.Draw(mask)
    for cx, cy, r in spec.get("circles", []):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    for x0, y0, x1, y1, rad in spec.get("rects", []):
        d.rounded_rectangle([x0, y0, x1, y1], radius=rad, fill=255)
    if "clip_y" in spec:
        d.rectangle([0, spec["clip_y"], im.width, im.height], fill=0)
    # pixelate then blur: unrecognisable but still reads as "a photo"
    small = im.resize((im.width // 28, im.height // 28), Image.BILINEAR)
    pix = small.resize(im.size, Image.NEAREST).filter(ImageFilter.GaussianBlur(14))
    im.paste(pix, (0, 0), mask)


def drop_word(im, y0, y1, x_start, idx, x_end, min_gap=14):
    """Remove the idx-th word on a text line by shifting the remainder left."""
    band = im.crop((0, y0, x_end, y1)).convert("RGB")
    bg = band.getpixel((band.width - 5, (y1 - y0) // 2))
    w, h = band.size
    px = band.load()

    def is_ink(x):
        for y in range(h):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 60:
                return True
        return False

    cols = [is_ink(x) for x in range(w)]
    words, x = [], x_start
    while x < w:
        if cols[x]:
            s = x
            gap = 0
            while x < w and gap < min_gap:  # smaller gaps stay inside a word
                gap = 0 if cols[x] else gap + 1
                x += 1
            words.append((s, x - gap))
        else:
            x += 1
    assert len(words) > idx + 1, words
    keep_end = words[idx - 1][1]
    space = words[idx + 1][0] - words[idx][1]
    tail = im.crop((words[idx + 1][0], y0, w, y1))
    d = ImageDraw.Draw(im)
    d.rectangle([keep_end + 1, y0, w, y1 - 1], fill=bg)
    im.paste(tail, (keep_end + space, y0))
    # Clear anything the shift exposed at the right edge of the band.
    end = keep_end + space + (w - words[idx + 1][0])
    if end < w:
        d.rectangle([end, y0, w, y1 - 1], fill=bg)
    return words


for name, spec in SPEC.items():
    src = os.path.join(caps, name + ".png")
    im = Image.open(src).convert("RGB")
    for y0, y1, xs, idx, xe in spec.get("drop_word", []):
        print(name, "words:", drop_word(im, y0, y1, xs, idx, xe, spec.get("gap", 14)))
    blur_regions(im, spec)
    if spec.get("grabber"):
        remove_grabber(im)
    base = name.replace("ipad-raw-", "ipad-anon-").replace("ipad-camps-raw", "ipad-anon-camps").replace("ipad-player", "ipad-anon-player")
    out = os.path.join(caps, base.replace("raw-", "anon-") + ".png")
    im.save(out)
    print("wrote", out)
