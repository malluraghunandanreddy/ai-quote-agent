"""Quotation documents (PDF + Excel) for connectors without their own quote screen — e.g. standalone mode."""
from __future__ import annotations

from pathlib import Path

from fpdf import FPDF
from fpdf.fonts import FontFace
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

from .config import get_settings
from .schemas import DraftQuote, QuoteResult

# The built-in PDF fonts are Latin-1 only; map common Unicode punctuation instead of printing '?'.
_REPLACE = {"–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "•": "*", "→": "->", "₹": "INR ", "…": "...",
            "≤": "<=", "≥": ">=", "×": "x", " ": " ", "\t": " "}


def pdf_text(value: object) -> str:
    text = str(value or "")
    for a, b in _REPLACE.items():
        text = text.replace(a, b)
    return text.encode("latin-1", "replace").decode("latin-1")


def totals(quote: DraftQuote, tax_percent: float) -> dict:
    priced = [l for l in quote.lines if l.rate > 0]
    subtotal = round(sum(l.quantity * l.rate * (1 - (l.discount_percent or 0) / 100) for l in priced), 2)
    tax = round(subtotal * tax_percent / 100, 2)
    return {"subtotal": subtotal, "tax": tax, "total": round(subtotal + tax, 2), "unpriced": len(quote.lines) - len(priced)}


def _money(v: float) -> str:
    return f"{v:,.2f}"


class _QuotePDF(FPDF):
    def footer(self) -> None:
        self.set_y(-12)
        self.set_font("Helvetica", "I", 8)
        self.set_text_color(130)
        self.cell(0, 6, f"DRAFT - review before sending to the customer   |   Page {self.page_no()}/{{nb}}", align="C")


def write_pdf(path: Path, quote: DraftQuote, result: QuoteResult) -> None:
    s = get_settings()
    t = totals(quote, s.standalone_tax_percent)
    pdf = _QuotePDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=16)
    pdf.add_page()
    pdf.set_margins(15, 15, 15)

    # header: seller left, title right
    pdf.set_font("Helvetica", "B", 15)
    pdf.cell(110, 8, pdf_text(s.business_name))
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(40, 60, 140)
    pdf.cell(0, 8, "QUOTATION", align="R", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(90)
    pdf.set_font("Helvetica", "", 9)
    seller = [s.business_address, " | ".join(x for x in [s.business_phone, s.business_email] if x),
              f"GSTIN: {s.business_gstin}" if s.business_gstin else ""]
    y0 = pdf.get_y()
    for line in [x for x in seller if x]:
        pdf.multi_cell(110, 4.5, pdf_text(line), new_x="LMARGIN", new_y="NEXT")
    seller_bottom = pdf.get_y()
    pdf.set_xy(125, y0)
    pdf.set_text_color(200, 40, 40)
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(0, 5, "DRAFT", align="R", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0)
    pdf.set_y(max(seller_bottom, pdf.get_y()) + 6)

    # quote meta + bill-to
    pdf.set_font("Helvetica", "", 9)
    meta = [("Quotation no.", result.quote_number), ("Date", quote.quote_date.strftime("%d %b %Y")),
            ("Valid until", quote.expiry_date.strftime("%d %b %Y")), ("Your reference", quote.reference)]
    bill = [quote.customer_name, quote.customer_email, quote.contact_phone,
            f"Deliver to: {quote.delivery_address}" if quote.delivery_address else None,
            f"Delivery terms: {quote.delivery_terms}" if quote.delivery_terms else None]
    top = pdf.get_y()
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(95, 5, "Quotation for", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 9)
    for line in [x for x in bill if x]:
        pdf.multi_cell(95, 4.5, pdf_text(line), new_x="LMARGIN", new_y="NEXT")
    left_bottom = pdf.get_y()
    pdf.set_y(top)
    for label, value in meta:
        pdf.set_x(120)
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(30, 5, label)
        pdf.set_font("Helvetica", "", 9)
        pdf.cell(0, 5, pdf_text(value), new_x="LMARGIN", new_y="NEXT")
    pdf.set_y(max(left_bottom, pdf.get_y()) + 5)

    # line items
    header = FontFace(emphasis="BOLD", color=255, fill_color=(40, 60, 140))
    with pdf.table(col_widths=(8, 92, 18, 14, 22, 26), text_align=("RIGHT", "LEFT", "RIGHT", "LEFT", "RIGHT", "RIGHT"),
                   headings_style=header, line_height=4.6, padding=1.4, first_row_as_headings=True) as table:
        row = table.row()
        for h in ("#", "Item", "Qty", "Unit", "Rate", "Amount"):
            row.cell(h)
        for i, l in enumerate(quote.lines, 1):
            desc = l.description.split("\n")
            # first description line is usually a review tag; keep the item text compact on paper
            detail = next((d for d in desc if d and not d.startswith("[")), "")
            item = l.name + (f"\n{detail[:140]}" if detail and detail != l.name else "")
            row = table.row()
            row.cell(str(i))
            row.cell(pdf_text(item))
            row.cell(f"{l.quantity:g}")
            row.cell(pdf_text(l.unit or ""))
            row.cell(_money(l.rate) if l.rate > 0 else "TBC")
            row.cell(_money(l.quantity * l.rate * (1 - (l.discount_percent or 0) / 100)) if l.rate > 0 else "TBC")

    # totals
    pdf.ln(3)
    pdf.set_font("Helvetica", "", 9.5)
    lines = [("Subtotal", t["subtotal"])]
    if s.standalone_tax_percent:
        lines.append((f"Tax ({s.standalone_tax_percent:g}%)", t["tax"]))
    for label, value in lines:
        pdf.set_x(120)
        pdf.cell(45, 6, label)
        pdf.cell(0, 6, _money(value), align="R", new_x="LMARGIN", new_y="NEXT")
    pdf.set_x(120)
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(45, 7, "Total (INR)")
    pdf.cell(0, 7, _money(t["total"]), align="R", new_x="LMARGIN", new_y="NEXT")
    if t["unpriced"]:
        pdf.set_font("Helvetica", "I", 8.5)
        pdf.set_text_color(180, 60, 0)
        pdf.cell(0, 5, f"{t['unpriced']} item(s) marked TBC have no price yet and are not included in the total.",
                 align="R", new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0)

    # notes & terms
    pdf.ln(4)
    for title, body in (("Notes", quote.notes), ("Terms", s.quote_terms)):
        if body:
            pdf.set_font("Helvetica", "B", 9)
            pdf.cell(0, 5, title, new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 8.5)
            pdf.multi_cell(0, 4.3, pdf_text(body), new_x="LMARGIN", new_y="NEXT")
            pdf.ln(2)
    pdf.output(str(path))


def write_xlsx(path: Path, quote: DraftQuote, result: QuoteResult) -> None:
    s = get_settings()
    t = totals(quote, s.standalone_tax_percent)
    wb = Workbook()
    ws = wb.active
    ws.title = "Quotation"
    bold = Font(bold=True)
    ws.append([s.business_name])
    ws["A1"].font = Font(bold=True, size=14)
    ws.append(["QUOTATION (DRAFT)"])
    ws.append([])
    for label, value in (("Quotation no.", result.quote_number), ("Date", quote.quote_date.isoformat()),
                         ("Valid until", quote.expiry_date.isoformat()), ("Your reference", quote.reference),
                         ("Customer", quote.customer_name), ("Email", quote.customer_email or ""),
                         ("Phone", quote.contact_phone or ""), ("Deliver to", quote.delivery_address or ""),
                         ("Delivery terms", quote.delivery_terms or "")):
        ws.append([label, value])
        ws.cell(ws.max_row, 1).font = bold
    ws.append([])
    ws.append(["#", "Item", "Description", "Qty", "Unit", "Rate", "Amount"])
    for c in ws[ws.max_row]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="283C8C")
    for i, l in enumerate(quote.lines, 1):
        amount = round(l.quantity * l.rate * (1 - (l.discount_percent or 0) / 100), 2) if l.rate > 0 else "TBC"
        ws.append([i, l.name, l.description, l.quantity, l.unit or "", l.rate if l.rate > 0 else "TBC", amount])
        ws.cell(ws.max_row, 3).alignment = Alignment(wrap_text=True, vertical="top")
    ws.append([])
    ws.append(["", "", "", "", "", "Subtotal", t["subtotal"]])
    if s.standalone_tax_percent:
        ws.append(["", "", "", "", "", f"Tax ({s.standalone_tax_percent:g}%)", t["tax"]])
    ws.append(["", "", "", "", "", "Total (INR)", t["total"]])
    ws.cell(ws.max_row, 6).font = bold
    ws.cell(ws.max_row, 7).font = bold
    for col, width in zip("ABCDEFG", (6, 42, 60, 8, 8, 14, 14)):
        ws.column_dimensions[col].width = width
    wb.save(path)
