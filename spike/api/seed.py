"""Seed for the M0 spike: 2,000 variants over 400 products + 400 real 400px WebP thumbnails.

Usage: python seed.py <out_dir>      (out_dir is spike/web/public/media; thumbs go to <out_dir>/t/)
Deterministic (fixed seed). Fake data only.
"""
import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "media")
THUMBS = OUT / "t"
THUMBS.mkdir(parents=True, exist_ok=True)

QUALITY = int(sys.argv[2]) if len(sys.argv) > 2 else 65  # tuned so thumbnails land near the ~25 KB in SPEC section 17
N_PRODUCTS = 400
VARIANTS_PER_PRODUCT = 5  # 400 x 5 = 2,000 (SPEC section 17 large dataset)

KINDS = [
    ("أرجيلة", ["كبيرة", "وسط", "صغيرة", "مزخرفة"], (25000, 90000)),
    ("بربيش", ["سيليكون", "جلد", "معدني"], (800, 4500)),
    ("فحم", ["طبيعي", "سريع الاشتعال", "كوكو"], (1500, 6500)),
    ("راس", ["طين", "سيراميك", "زجاج"], (1200, 7000)),
    ("ماسك", ["خشب", "ألمنيوم", "زجاج"], (500, 3500)),
]
COLORS = [("أسود", (30, 30, 36)), ("أحمر", (190, 40, 50)), ("أزرق", (45, 105, 190)),
          ("ذهبي", (200, 160, 50)), ("فضي", (160, 165, 175))]
SIZES = ["صغير", "وسط", "كبير", "25 قطعة", "1.8 م"]
SKU_PREFIX = {"أرجيلة": "HK", "بربيش": "HS", "فحم": "CH", "راس": "BW", "ماسك": "MP"}

rng = random.Random(20261029)
try:
    FONT = ImageFont.load_default(size=44)
except TypeError:  # very old Pillow
    FONT = ImageFont.load_default()


def make_thumb(pid: int, base_rgb: tuple[int, int, int]) -> int:
    img = Image.new("RGB", (400, 400), (246, 243, 236))
    d = ImageDraw.Draw(img)
    # Textured background so the WebP is a realistic ~20-30 KB, not a flat colour.
    for _ in range(260):
        x, y, r = rng.randrange(400), rng.randrange(400), rng.randrange(6, 60)
        tint = tuple(max(0, min(255, c + rng.randrange(-40, 40))) for c in base_rgb)
        d.ellipse((x - r, y - r, x + r, y + r), fill=tint)
    d.rounded_rectangle((90, 70, 310, 330), radius=40, fill=base_rgb, outline=(20, 33, 61), width=6)
    d.text((200, 200), f"#{pid}", fill=(255, 255, 255), font=FONT, anchor="mm")
    # Photo-like grain: real product photos are never smooth, and this is what makes the file size realistic.
    grain = Image.effect_noise((400, 400), 48).convert("RGB")
    img = Image.blend(img, grain, 0.18)
    path = THUMBS / f"{pid}.webp"
    img.save(path, "WEBP", quality=QUALITY, method=4)
    return path.stat().st_size


variants = []
sizes = []
vid = 1
for pid in range(1, N_PRODUCTS + 1):
    kind, styles, (lo, hi) = rng.choice(KINDS)
    style = rng.choice(styles)
    name = f"{kind} {style} {pid}"
    base_rgb = rng.choice(COLORS)[1]
    sizes.append(make_thumb(pid, base_rgb))
    base_price = rng.randrange(lo, hi, 50)
    for k in range(VARIANTS_PER_PRODUCT):
        color = COLORS[k % len(COLORS)][0]
        size = rng.choice(SIZES)
        variants.append({
            "id": vid, "productId": pid, "name": name, "color": color, "size": size,
            "sku": f"{SKU_PREFIX[kind]}-{pid:04d}-{k + 1}", "price": base_price + k * 500,
            "stock": rng.randrange(0, 80), "thumb": f"/media/t/{pid}.webp",
        })
        vid += 1

(OUT / "variants.json").write_text(json.dumps(variants, ensure_ascii=False), encoding="utf-8")
print(f"{len(variants)} variants, {N_PRODUCTS} thumbnails, avg {sum(sizes) / len(sizes) / 1024:.1f} KB "
      f"(min {min(sizes) / 1024:.1f}, max {max(sizes) / 1024:.1f}) -> {OUT}")
