"""Invoice and statement PDFs with WeasyPrint (SPEC sections 3 and 11).

The Jinja environment, the shared stylesheet and the font configuration are loaded once, not per
request (SPEC section 17). WeasyPrint itself is imported on first use: it needs pango and harfbuzz
(present in the Docker image and on CI), and nothing else in the API should fail to start on a
machine that lacks them."""

import logging
import os
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

from app import storage
from app.services.documents import LABELS, SHARED_DIR

FONTS_DIR = (
    Path(os.environ["FONTS_DIR"])
    if "FONTS_DIR" in os.environ
    else Path(__file__).resolve().parents[4] / "apps" / "web" / "public" / "fonts"
)
_TEMPLATES = Path(__file__).resolve().parents[1] / "templates"

_env = Environment(loader=FileSystemLoader(_TEMPLATES), autoescape=select_autoescape(["html"]))
_css = (SHARED_DIR / "documents.css").read_text(encoding="utf-8")
_font_config: Any = None


def _logo_src(logo_url: str | None) -> str | None:
    """The logo is a file in the media folder: WeasyPrint reads it from disk, not over HTTP."""
    if not logo_url or not logo_url.startswith(storage.URL_PREFIX + "/"):
        return None
    path = storage.media_root() / logo_url[len(storage.URL_PREFIX) + 1 :]
    return path.as_uri() if path.is_file() else None


def render_html(template: str, doc: dict[str, Any], labels: str) -> str:
    """The page as HTML. `labels` is "invoice" or "statement"."""
    return _env.get_template(template).render(
        doc=doc,
        L=LABELS[labels],
        shared_css=_css,
        fonts_dir=FONTS_DIR.as_posix(),
        logo_src=_logo_src(doc["business"].get("logo_url")),
    )


def render_pdf(template: str, doc: dict[str, Any], labels: str) -> bytes:
    global _font_config
    from weasyprint import HTML  # noqa: PLC0415 - lazy on purpose, see the module docstring
    from weasyprint.text.fonts import FontConfiguration  # noqa: PLC0415

    if _font_config is None:
        _font_config = FontConfiguration()
    html = render_html(template, doc, labels)
    content: bytes = HTML(string=html, base_url=str(_TEMPLATES)).write_pdf(font_config=_font_config)
    return content


def warm_up() -> None:
    """Renders a tiny statement so the first real PDF doesn't pay for loading WeasyPrint, pango and
    the fonts (seen to take over 30 s on a loaded machine right after the container started).
    Never raises: a machine without pango just keeps working without PDFs."""
    try:
        doc = {
            "business": {"name": "-", "phone": "", "footer": "", "logo_url": None},
            "customer": {"name": "-", "shop_name": None, "phone": None},
            "period": {"from": "01/01/2026", "to": "01/01/2026"},
            "rows": [],
            "totals": {"debit": "₪ 0.00", "credit": "₪ 0.00", "closing": "₪ 0.00"},
        }
        render_pdf("statement.html", doc, "statement")
    except Exception:  # noqa: BLE001 - a warm-up must never stop the API from starting
        logging.getLogger(__name__).warning("PDF warm-up skipped", exc_info=True)
