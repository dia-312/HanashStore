"""Arabic text normalization (SPEC section 9). The TypeScript copy is apps/web/src/lib/normalize.ts;
both are tested against shared/normalize_cases.json so they can't drift."""

import unicodedata

_TASHKEEL_AND_TATWEEL = {cp: None for cp in [*range(0x064B, 0x0660), 0x0670, 0x0640]}
_LETTER_FOLDS = str.maketrans(
    {
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ٱ": "ا",
        "ة": "ه",
        "ى": "ي",
        "ؤ": "و",
        "ئ": "ي",
    }
)
_DIGITS = str.maketrans(
    {**{0x0660 + i: str(i) for i in range(10)}, **{0x06F0 + i: str(i) for i in range(10)}}
)


def normalize_arabic(text: str) -> str:
    text = text.lower().translate(_TASHKEEL_AND_TATWEEL).translate(_LETTER_FOLDS).translate(_DIGITS)
    # Anything that is not a letter or a number is punctuation or space: one space each, collapsed.
    kept = (c if unicodedata.category(c)[0] in "LN" else " " for c in text)
    return " ".join("".join(kept).split())
