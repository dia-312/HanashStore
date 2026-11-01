"""Money rules for invoices and balances (SPEC section 7). Flagged for line-by-line review: money.

Everything is integer agorot. The same rules exist in `apps/web/src/lib/billing.ts`; both are
tested against `shared/billing_cases.json`. The server's result always wins.
"""

from collections.abc import Sequence


def line_total(qty: int, unit_price: int) -> int:
    return qty * unit_price


def invoice_totals(line_totals: Sequence[int], discount: int) -> tuple[int, int]:
    """(subtotal, total). The discount is a fixed amount, 0 <= discount <= subtotal."""
    subtotal = sum(line_totals)
    if discount < 0 or discount > subtotal:
        raise ValueError("discount must be between 0 and the subtotal")
    return subtotal, subtotal - discount


def allocate_discount(line_totals: Sequence[int], discount: int) -> list[int]:
    """Split a discount over the lines in proportion to their totals.

    Each share is rounded down to the agora; the agorot left over go one by one to the lines with
    the largest remainders (ties: the earlier line). The shares always add up to `discount`.
    """
    subtotal = sum(line_totals)
    if discount < 0 or discount > subtotal:
        raise ValueError("discount must be between 0 and the subtotal")
    if discount == 0 or subtotal == 0:
        return [0] * len(line_totals)
    shares = [discount * t // subtotal for t in line_totals]
    remainders = [discount * t % subtotal for t in line_totals]
    leftover = discount - sum(shares)
    order = sorted(range(len(line_totals)), key=lambda i: (-remainders[i], i))
    for i in order[:leftover]:
        shares[i] += 1
    return shares


def remaining_on_invoice(total: int, paid: int) -> int:
    """What is still owed on one invoice: never negative, an overpayment is credit elsewhere."""
    return max(total - paid, 0)


def customer_balance(
    opening: int, invoices_total: int, returns_total: int, payments_total: int
) -> int:
    """Positive = the customer owes. Calculated by query, never stored."""
    return opening + invoices_total - returns_total - payments_total


def return_line_amount(
    line_total: int,
    discount_share: int,
    sold_qty: int,
    already_qty: int,
    already_amount: int,
    qty: int,
) -> int:
    """What a customer is credited for taking `qty` of an invoice line back (SPEC section 7).

    The line is worth `line_total - discount_share` after its share of the discount. A part is
    worth that value times `qty / sold_qty`, rounded down. The return that takes the line's last
    unit back gets what is left, so all the returns of one line add up to exactly its value."""
    if sold_qty <= 0 or qty <= 0 or already_qty < 0 or already_qty + qty > sold_qty:
        raise ValueError("quantity out of range")
    net = line_total - discount_share
    if already_qty + qty == sold_qty:
        return net - already_amount
    return net * qty // sold_qty
