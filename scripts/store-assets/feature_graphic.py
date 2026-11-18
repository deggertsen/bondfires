#!/usr/bin/env python3
"""Render the 1024x500 Google Play feature graphic.

Usage: python3 -I feature_graphic.py <icon.png> <out.png> [capture1.png capture2.png]
"""
import base64, subprocess, sys, tempfile, os
from PIL import Image

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def b64(p):
    return base64.b64encode(open(p, "rb").read()).decode()


icon, out, *caps = sys.argv[1:]
phones = "".join(
    f'<div class="ph ph{i}"><img src="data:image/png;base64,{b64(c)}"></div>' for i, c in enumerate(caps[:2])
)
doc = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@500&family=Inter+Tight:wght@700&display=swap');
* {{ margin:0; padding:0; box-sizing:border-box; }}
html,body {{ width:1024px; height:500px; overflow:hidden; background:#141416; }}
.s {{ position:relative; width:1024px; height:500px;
  background: radial-gradient(60% 90% at 18% 60%, rgba(217,119,54,.42), rgba(160,78,36,.15) 45%, rgba(20,20,22,0) 75%),
              radial-gradient(50% 80% at 92% 110%, rgba(240,171,104,.18), rgba(20,20,22,0) 70%), #141416; }}
.icon {{ position:absolute; left:64px; top:64px; width:132px; height:132px;
  filter: drop-shadow(0 0 40px rgba(217,119,54,.55)); }}
.copy {{ position:absolute; left:64px; top:232px; width:{'520' if caps else '880'}px; }}
h1 {{ font-family:'Inter Tight',Inter,sans-serif; font-weight:700; color:#F3F4F6; font-size:58px; line-height:1.02; letter-spacing:-.025em; }}
h1 em {{ font-style:normal; background:linear-gradient(180deg,#F0AB68,#D97736); -webkit-background-clip:text; background-clip:text; color:transparent; }}
p {{ font-family:Inter,sans-serif; font-weight:500; color:#9CA3AF; font-size:22px; margin-top:16px; line-height:1.35; text-wrap:balance; }}
.ph {{ position:absolute; width:236px; padding:8px; background:#0B0B0C; border-radius:34px;
  box-shadow:0 0 0 2px #33353A, 0 30px 80px rgba(0,0,0,.6), 0 0 80px rgba(217,119,54,.2); }}
.ph img {{ display:block; width:100%; border-radius:27px; }}
.ph0 {{ left:618px; top:58px; transform:rotate(-6deg); }}
.ph1 {{ left:790px; top:96px; transform:rotate(5deg); }}
</style></head><body><div class="s">
<img class="icon" src="data:image/png;base64,{b64(icon)}">
<div class="copy"><h1>Your group,<br><em>on your own time.</em></h1>
<p>Short video conversations for the people you already have.</p></div>
{phones}
</div></body></html>"""
with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as t:
    t.write(doc)
subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
                "--window-size=1024,500", "--virtual-time-budget=4000", f"--screenshot={out}", f"file://{t.name}"],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
os.unlink(t.name)
im = Image.open(out).convert("RGB")
assert im.size == (1024, 500), im.size
im.save(out)
print("wrote", out)
