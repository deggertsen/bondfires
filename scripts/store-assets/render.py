#!/usr/bin/env python3
"""Render store marketing frames from raw captures.

Usage: python3 -I render.py <slides.json> <captures_dir> <out_dir> [target,target]

Targets: ios-6.9, ios-13, play-phone, play-tablet (default: all).

slides.json: [{"id": "01-home", "headline": "...", "accent": "word", "sub": "...",
               "phone": "home.png", "tablet": "home-ipad.png"}]
Each target below renders every slide whose capture exists.
"""
import base64, json, os, subprocess, sys, tempfile, html

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

TARGETS = {
    # name: (width, height, capture key, out subdir)
    "ios-6.9": (1320, 2868, "phone", "apple/iphone-6.9"),
    "ios-13": (2064, 2752, "tablet", "apple/ipad-13"),
    "play-phone": (1080, 1920, "phone", "play/phoneScreenshots"),
    "play-tablet": (1600, 2560, "tablet", "play/tenInchScreenshots"),
}

CSS = """
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Inter+Tight:wght@600;700&display=swap');
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width:%(w)dpx; height:%(h)dpx; overflow:hidden; background:#141416; }
.stage { position:relative; width:100%%; height:100%%;
  background:
    radial-gradient(120%% 55%% at 50%% 108%%, rgba(217,119,54,.55) 0%%, rgba(160,78,36,.22) 38%%, rgba(20,20,22,0) 70%%),
    radial-gradient(70%% 30%% at 85%% 0%%, rgba(240,171,104,.10) 0%%, rgba(20,20,22,0) 70%%),
    #141416; }
.copy { position:absolute; left:0; right:0; top:%(top)dpx; padding:0 %(pad)dpx; text-align:center; }
h1 { font-family:'Inter Tight', Inter, sans-serif; font-weight:700; color:#F3F4F6;
  font-size:%(h1)dpx; line-height:1.06; letter-spacing:-0.025em; text-wrap:balance; }
h1 em { font-style:normal; color:#F0AB68;
  background:linear-gradient(180deg,#F0AB68 0%%,#D97736 100%%); -webkit-background-clip:text; background-clip:text; color:transparent; }
p { font-family:Inter, sans-serif; font-weight:500; color:#9CA3AF; font-size:%(sub)dpx;
  line-height:1.35; margin-top:%(gap)dpx; text-wrap:balance; }
.device { position:absolute; left:50%%; transform:translateX(-50%%); top:%(dtop)dpx; width:%(dw)dpx;
  padding:%(bez)dpx; border-radius:%(outer)dpx; background:#0B0B0C;
  box-shadow: 0 0 0 %(rim)dpx #33353A, 0 40px 120px rgba(0,0,0,.6), 0 0 160px rgba(217,119,54,.18); }
.device img { display:block; width:100%%; border-radius:%(inner)dpx; }
"""


def render(slide, cap_path, target, out_path):
    w, h, key, _ = TARGETS[target]
    tablet = key == "tablet"
    s = w / 1320  # scale relative to the iPhone canvas
    if tablet:
        s = w / 1700
    p = dict(w=w, h=h,
             top=int(150 * s), pad=int(90 * s),
             h1=int(112 * s), sub=int(50 * s), gap=int(28 * s),
             bez=int(16 * s), rim=max(2, int(3 * s)))
    # device width: phone ~ 78% of canvas, tablet ~ 82%
    p["dw"] = int(w * (0.80 if tablet else 0.78))
    p["outer"] = int((60 if tablet else 120) * s)
    p["inner"] = p["outer"] - p["bez"]
    p["dtop"] = int(h * (0.27 if not tablet else 0.25))
    if tablet:  # big canvas: larger type, device fills more of the width
        p.update(top=int(w * 0.075), pad=int(w * 0.06), h1=int(w * 0.082), sub=int(w * 0.031),
                 gap=int(w * 0.016), dw=int(w * 0.86), dtop=int(h * 0.285))
    if target == "play-phone":  # shorter canvas: tighter copy, smaller device
        p.update(top=int(110 * s), h1=int(100 * s), sub=int(46 * s), dw=int(w * 0.70), dtop=int(h * 0.30))
    with open(cap_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    headline = html.escape(slide["headline"])
    if slide.get("accent"):
        a = html.escape(slide["accent"])
        headline = headline.replace(a, f"<em>{a}</em>", 1)
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><style>{CSS % p}</style></head>
<body><div class="stage">
<div class="copy"><h1>{headline}</h1><p>{html.escape(slide.get('sub', ''))}</p></div>
<div class="device"><img src="data:image/png;base64,{b64}"></div>
</div></body></html>"""
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as t:
        t.write(doc)
        tmp = t.name
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
                    f"--window-size={w},{h}", "--virtual-time-budget=4000",
                    f"--screenshot={out_path}", f"file://{tmp}"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.unlink(tmp)
    # Stores reject alpha on Apple; flatten to RGB.
    from PIL import Image
    im = Image.open(out_path).convert("RGB")
    assert im.size == (w, h), (out_path, im.size)
    im.save(out_path)


def main():
    slides_path, caps, out = sys.argv[1:4]
    only = set(sys.argv[4].split(",")) if len(sys.argv) > 4 else None
    slides = json.load(open(slides_path))
    for target, (w, h, key, sub) in TARGETS.items():
        if only and target not in only:
            continue
        n = 0
        for slide in slides:
            cap = slide.get(key)
            if not cap or not os.path.exists(os.path.join(caps, cap)):
                continue
            n += 1
            dest = os.path.join(out, sub, f"{n}_{slide['id']}.png")
            render(slide, os.path.join(caps, cap), target, dest)
            print("wrote", dest)


if __name__ == "__main__":
    main()
