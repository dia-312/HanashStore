"""M0 spike API: one endpoint that renders the sample Arabic invoice to PDF with WeasyPrint."""
import json
import os
import time
from pathlib import Path

from fastapi import FastAPI, Response
from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML
from weasyprint.text.fonts import FontConfiguration

BASE = Path(__file__).parent
SHARED = Path(os.environ.get("SHARED_DIR", "/app/shared"))
FONTS = Path(os.environ.get("FONTS_DIR", "/app/fonts"))


def money(agorot: int) -> str:
    """Integer agorot -> '₪ 1,250.00' (same format as the web side's fmtMoney)."""
    return f"₪ {agorot / 100:,.2f}"


# Loaded once at startup, not per request (SPEC section 17).
_env = Environment(loader=FileSystemLoader(BASE / "templates"), autoescape=select_autoescape(["html"]))
_env.filters["money"] = money
_template = _env.get_template("invoice.html")
_shared_css = (SHARED / "invoice.css").read_text(encoding="utf-8")
_inv = json.loads((SHARED / "sample-invoice.json").read_text(encoding="utf-8"))
_font_config = FontConfiguration()

_subtotal = sum(l["qty"] * l["unit_price"] for l in _inv["lines"])
_total = _subtotal - _inv["discount"]
_totals = {"subtotal": _subtotal, "total": _total, "remaining": max(_total - _inv["paid"], 0)}

app = FastAPI(title="Spike M0 API")


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/spike/invoice.pdf")
def invoice_pdf():
    t0 = time.perf_counter()
    html = _template.render(
        inv=_inv, totals=_totals, shared_css=_shared_css, fonts_dir=FONTS.as_posix()
    )
    pdf = HTML(string=html, base_url=str(BASE)).write_pdf(font_config=_font_config)
    ms = round((time.perf_counter() - t0) * 1000)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{_inv["number"]}.pdf"',
            "X-Render-Ms": str(ms),
            "Cache-Control": "no-store",
        },
    )
