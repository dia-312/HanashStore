"""Parsing of prices typed or exported as text. Money is integer agorot (SPEC section 7)."""

import re
from decimal import Decimal, InvalidOperation

MAX_AMOUNT_AGOROT = 10_000_000 * 100  # SPEC section 13: amounts up to 10,000,000 ILS

_ARABIC_DIGITS = str.maketrans(
    {**{0x0660 + i: str(i) for i in range(10)}, **{0x06F0 + i: str(i) for i in range(10)}}
)
_THOUSANDS = re.compile(r"^\d{1,3}(,\d{3})+(\.\d+)?$")


class MoneyError(ValueError):
    pass


def _without_noise(value: float) -> float:
    """Binary floats carry noise a person never sees: a price worked out by a formula in Excel
    comes back as 15.600000000000001, and 0.1 + 0.2 as 0.30000000000000004. Six decimals keep every
    real price (two decimals) and drop the noise; 12.555 stays 12.555 and is still refused."""
    return round(value, 6)


def parse_agorot(value: str | int | float | Decimal) -> int:
    """'12.50' -> 1250. At most two decimals, no negatives, never goes through binary floats
    (a float cell from Excel is read through its shortest repr, so 12.3 stays 12.30)."""
    if isinstance(value, bool):
        raise MoneyError("not a number")
    if isinstance(value, float):
        value = repr(_without_noise(value))
    text = str(value).strip().translate(_ARABIC_DIGITS)
    text = text.replace("٫", ".").replace("٬", ",").replace(" ", "").replace(" ", "")
    if _THOUSANDS.match(text):
        text = text.replace(",", "")
    elif re.fullmatch(r"\d+,\d{1,2}", text):
        text = text.replace(",", ".")
    if not re.fullmatch(r"\d+(\.\d+)?", text):
        raise MoneyError("not a number")
    try:
        amount = Decimal(text)
    except InvalidOperation as exc:  # pragma: no cover - the regex already rules this out
        raise MoneyError("not a number") from exc
    agorot = amount * 100
    if agorot != agorot.to_integral_value():
        raise MoneyError("more than two decimal places")
    result = int(agorot)
    if result > MAX_AMOUNT_AGOROT:
        raise MoneyError("amount too large")
    return result


def parse_quantity(value: str | int | float | Decimal) -> int:
    """Whole units only: '12', 12, 12.0 -> 12; '1.5' is rejected."""
    if isinstance(value, bool):
        raise MoneyError("not a number")
    if isinstance(value, float):
        value = repr(_without_noise(value))
    text = str(value).strip().translate(_ARABIC_DIGITS)
    if not re.fullmatch(r"\d+(\.0+)?", text):
        raise MoneyError("not a whole number")
    qty = int(Decimal(text))
    if qty > 100_000:
        raise MoneyError("quantity too large")
    return qty
