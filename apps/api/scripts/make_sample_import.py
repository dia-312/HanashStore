"""Writes small sample .xlsx files for trying the importer.

python -m scripts.make_sample_import out.xlsx            -> a good file
python -m scripts.make_sample_import out.xlsx --bad-row  -> same, plus one row with a bad price
"""

import sys

from openpyxl import Workbook

HEADER = ("المنتج", "الفئة", "اللون", "الحجم", "السعر", "الكمية")
ROWS = [
    ("شيشة نخلة صغيرة", "شيش", "أزرق", "", 140, 10),
    ("شيشة نخلة صغيرة", "شيش", "أخضر", "", 140, 6),
    ("شيشة نخلة صغيرة", "شيش", "فضي", "", 155.5, 4),
    ("جمر سريع الاشتعال", "جمر", "", "حبة 33", 18, 80),
    ("جمر سريع الاشتعال", "جمر", "", "حبة 40", 24, 50),
    ("فوهة زجاج", "قطع غيار", "شفاف", "", 9.5, 120),
    ("ملقط فحم ستانلس", "قطع غيار", "", "", 12.75, 0),
]
BAD_ROW = ("حقيبة نقل", "قطع غيار", "أسود", "", "abc", 5)


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "sample.xlsx"
    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.append(HEADER)
    for row in ROWS:
        ws.append(row)
    if "--bad-row" in sys.argv:
        ws.append(BAD_ROW)
    wb.save(out)


if __name__ == "__main__":
    main()
