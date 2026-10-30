"""Large test dataset generator (SPEC section 17) for the per-milestone performance checks.

    python scripts/seed_large.py <out_dir> [--scale 1.0] [--no-thumbs]

Writes deterministic JSON using the SPEC section 6 field names (ids are UUIDv7, money is integer
agorot) plus 400 real 400px WebP thumbnails:

    products.json  400        variants.json  2,000     customers.json  500
    invoices.json  20,000 (each with its lines)         payments.json   15,000
    returns.json   1,000 (each with its lines)          thumbs/<n>.webp 400

Only users, devices and settings exist as tables in M1, so nothing is loaded into Postgres yet. Each
later milestone adds a loader for the tables it creates (M2 catalog, M4 customers and invoices, M7
returns) and reads these files. The script checks its own output (totals, stock, return limits)
before finishing. Fake data only.
"""

import argparse
import json
import random
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SEED = 20261030
DAY_MS = 86_400_000
END_MS = 1_793_318_400_000  # 2026-10-30 00:00 UTC
SPAN_DAYS = 365

N_PRODUCTS, VARIANTS_PER_PRODUCT = 400, 5
N_CUSTOMERS, N_INVOICES, N_PAYMENTS, N_RETURNS = 500, 20_000, 15_000, 1_000

KINDS = [
    ("أرجيلة", ["كبيرة", "وسط", "صغيرة", "مزخرفة"], (25000, 90000), "HK"),
    ("بربيش", ["سيليكون", "جلد", "معدني"], (800, 4500), "HS"),
    ("فحم", ["طبيعي", "سريع الاشتعال", "كوكو"], (1500, 6500), "CH"),
    ("راس", ["طين", "سيراميك", "زجاج"], (1200, 7000), "BW"),
    ("ماسك", ["خشب", "ألمنيوم", "زجاج"], (500, 3500), "MP"),
]
COLORS = [
    ("أسود", (30, 30, 36)),
    ("أحمر", (190, 40, 50)),
    ("أزرق", (45, 105, 190)),
    ("ذهبي", (200, 160, 50)),
    ("فضي", (160, 165, 175)),
]
SIZES = ["صغير", "وسط", "كبير", "25 قطعة", "1.8 م"]
AREAS = ["رام الله", "نابلس", "الخليل", "بيت لحم", "جنين", "طولكرم", "قلقيلية", "القدس"]
SHOP_WORDS = ["أبو", "ملك", "نجوم", "الأصيل", "الشرق", "البركة", "الوفاء", "السلام"]


def new_id(rng: random.Random, ms: int) -> str:
    """Deterministic UUIDv7: the timestamp is the fake creation time, the rest comes from `rng`."""
    rand = rng.getrandbits(74)
    value = (
        (ms << 80) | (0x7 << 76) | ((rand >> 62) << 64) | (0b10 << 62) | (rand & ((1 << 62) - 1))
    )
    return str(uuid.UUID(int=value))


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, UTC).isoformat().replace("+00:00", "Z")


def make_thumb(path: Path, pid: int, rgb: tuple[int, int, int], rng: random.Random) -> None:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (400, 400), (246, 243, 236))
    draw = ImageDraw.Draw(img)
    for _ in range(260):  # texture, so the WebP weighs what a real photo would (~25 KB)
        x, y, r = rng.randrange(400), rng.randrange(400), rng.randrange(6, 60)
        tint = tuple(max(0, min(255, c + rng.randrange(-40, 40))) for c in rgb)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=tint)
    draw.rounded_rectangle((90, 70, 310, 330), radius=40, fill=rgb, outline=(20, 33, 61), width=6)
    draw.text(
        (200, 200),
        f"#{pid}",
        fill=(255, 255, 255),
        font=ImageFont.load_default(size=44),
        anchor="mm",
    )
    grain = Image.effect_noise((400, 400), 48).convert("RGB")
    Image.blend(img, grain, 0.18).save(path, "WEBP", quality=65, method=4)


def generate(out: Path, scale: float = 1.0, thumbs: bool = True) -> dict[str, list[dict[str, Any]]]:
    rng = random.Random(SEED)
    n_products = max(1, round(N_PRODUCTS * scale))
    n_customers = max(1, round(N_CUSTOMERS * scale))
    n_invoices = max(1, round(N_INVOICES * scale))
    n_payments = max(1, round(N_PAYMENTS * scale))
    n_returns = max(1, round(N_RETURNS * scale))
    start_ms = END_MS - SPAN_DAYS * DAY_MS

    out.mkdir(parents=True, exist_ok=True)
    if thumbs:
        (out / "thumbs").mkdir(exist_ok=True)

    categories = {kind: new_id(rng, start_ms) for kind, *_ in KINDS}
    products: list[dict[str, Any]] = []
    variants: list[dict[str, Any]] = []
    for n in range(1, n_products + 1):
        kind, styles, (lo, hi), prefix = rng.choice(KINDS)
        rgb = rng.choice(COLORS)[1]
        product = {
            "id": new_id(rng, start_ms),
            "category_id": categories[kind],
            "name": f"{kind} {rng.choice(styles)} {n}",
            "thumb": f"thumbs/{n}.webp",
        }
        products.append(product)
        if thumbs:
            make_thumb(out / "thumbs" / f"{n}.webp", n, rgb, rng)
        base = rng.randrange(lo, hi, 50)
        for k in range(VARIANTS_PER_PRODUCT):
            variants.append(
                {
                    "id": new_id(rng, start_ms),
                    "product_id": product["id"],
                    "sku": f"{prefix}-{n:04d}-{k + 1}",
                    "color": COLORS[k % len(COLORS)][0],
                    "size": SIZES[(n + k) % len(SIZES)],  # keeps (product, color, size) unique
                    "price": base + k * 500,
                    "min_stock": rng.randrange(0, 10),
                    "opening_qty": rng.randrange(50, 400),
                }
            )

    customers = []
    for n in range(1, n_customers + 1):
        customers.append(
            {
                "id": new_id(rng, start_ms),
                "name": f"زبون {n}",
                "shop_name": f"{rng.choice(SHOP_WORDS)} {n}",
                "phone": f"059{rng.randrange(1_000_000, 9_999_999)}",
                "area": rng.choice(AREAS),
                "opening_balance": rng.choice([0, 0, 0, rng.randrange(10_000, 500_000, 100)]),
            }
        )

    invoices: list[dict[str, Any]] = []
    for n in range(1, n_invoices + 1):
        issued = start_ms + rng.randrange(SPAN_DAYS * DAY_MS)
        lines = []
        for sort_order, v in enumerate(rng.sample(variants, rng.randrange(1, 7))):
            qty = rng.randrange(1, 12)
            lines.append(
                {
                    "id": new_id(rng, issued),
                    "variant_id": v["id"],
                    "qty": qty,
                    "unit_price": v["price"],
                    "line_total": qty * v["price"],
                    "discount_share": 0,
                    "sort_order": sort_order,
                }
            )
        subtotal = sum(line["line_total"] for line in lines)
        discount = rng.choice([0, 0, 0, min(subtotal, rng.randrange(0, 20_000, 100))])
        invoices.append(
            {
                "id": new_id(rng, issued),
                "number": f"INV-{n:06d}",
                "customer_id": rng.choice(customers)["id"],
                "status": "confirmed",
                "subtotal": subtotal,
                "discount": discount,
                "total": subtotal - discount,
                "issued_at": iso(issued),
                "lines": lines,
            }
        )
    invoices.sort(key=lambda i: i["issued_at"])
    for n, inv in enumerate(invoices, 1):
        inv["number"] = f"INV-{n:06d}"

    payments = []
    for n in range(1, n_payments + 1):
        inv = rng.choice(invoices)
        linked = rng.random() < 0.6
        payments.append(
            {
                "id": new_id(rng, start_ms),
                "number": f"REC-{n:06d}",
                "customer_id": inv["customer_id"],
                "invoice_id": inv["id"] if linked else None,
                "method": rng.choice(["cash", "cash", "transfer", "cheque"]),
                "amount": max(100, rng.randrange(1, max(2, inv["total"]), 100)),
                "paid_at": inv["issued_at"],
                "status": "active",
            }
        )

    returns = []
    remaining = {line["id"]: line["qty"] for inv in invoices for line in inv["lines"]}
    for n in range(1, n_returns + 1):
        while True:  # a line can only be returned up to what was sold (SPEC section 7)
            inv = rng.choice(invoices)
            line = rng.choice(inv["lines"])
            if remaining[line["id"]] > 0:
                break
        qty = rng.randrange(1, remaining[line["id"]] + 1)
        remaining[line["id"]] -= qty
        returns.append(
            {
                "id": new_id(rng, start_ms),
                "number": f"RET-{n:06d}",
                "customer_id": inv["customer_id"],
                "invoice_id": inv["id"],
                "issued_at": inv["issued_at"],
                "lines": [
                    {
                        "id": new_id(rng, start_ms),
                        "invoice_line_id": line["id"],
                        "qty": qty,
                        "disposition": rng.choice(["restock", "restock", "damaged"]),
                    }
                ],
            }
        )

    data = {
        "products": products,
        "variants": variants,
        "customers": customers,
        "invoices": invoices,
        "payments": payments,
        "returns": returns,
    }
    check(data)
    for name, rows in data.items():
        (out / f"{name}.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return data


def check(data: dict[str, list[dict[str, Any]]]) -> None:
    """The SPEC section 6 and 7 invariants, so a loader can trust the generated files."""
    variant_ids = {v["id"] for v in data["variants"]}
    assert len({v["sku"] for v in data["variants"]}) == len(data["variants"]), "SKUs must be unique"
    assert len({(v["product_id"], v["color"], v["size"]) for v in data["variants"]}) == len(
        data["variants"]
    ), "(product, color, size) must be unique"
    for inv in data["invoices"]:
        assert inv["subtotal"] == sum(line["line_total"] for line in inv["lines"])
        assert inv["total"] == inv["subtotal"] - inv["discount"]
        assert 0 <= inv["discount"] <= inv["subtotal"]
        assert all(line["variant_id"] in variant_ids for line in inv["lines"])
        assert all(line["qty"] * line["unit_price"] == line["line_total"] for line in inv["lines"])
    sold = {line["id"]: line["qty"] for inv in data["invoices"] for line in inv["lines"]}
    returned: dict[str, int] = {}
    for ret in data["returns"]:
        for line in ret["lines"]:
            returned[line["invoice_line_id"]] = (
                returned.get(line["invoice_line_id"], 0) + line["qty"]
            )
    assert all(qty <= sold[line_id] for line_id, qty in returned.items()), "over-returned line"
    assert all(p["amount"] > 0 for p in data["payments"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("--scale", type=float, default=1.0, help="1.0 = the full SPEC dataset")
    parser.add_argument("--no-thumbs", action="store_true")
    args = parser.parse_args(argv)
    data = generate(args.out_dir, args.scale, thumbs=not args.no_thumbs)
    print({name: len(rows) for name, rows in data.items()}, "->", args.out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
