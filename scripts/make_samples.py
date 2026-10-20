"""Generate the demo .eml files in samples/ (same parsing path as real IMAP mail).

    python scripts/make_samples.py

rfq_with_excel.eml attaches samples/electrical_tail_spend.xlsx — the customer's real sheet format.
"""
from __future__ import annotations

import io
from datetime import date, timedelta
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

from openpyxl import Workbook

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
INBOX = "quotes@demo.example.com"
CUSTOMER = "quotes@demo.example.com"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def xlsx(rows: list[list]) -> bytes:
    wb = Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def eml(name: str, sender: str, subject: str, body: str, attachment: tuple[str, bytes] | None = None) -> None:
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = INBOX
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="demo.example.com")
    msg.set_content(body)
    if attachment:
        msg.add_attachment(attachment[1], maintype="application", subtype=XLSX.split("/")[1], filename=attachment[0])
    (SAMPLES / name).write_bytes(bytes(msg))
    print("wrote", SAMPLES / name)


def write_price_list() -> None:
    """Standalone mode starter price list, built from the demo catalogue (blank price = not set yet)."""
    import json
    target = SAMPLES.parent / "data" / "standalone" / "price_list.xlsx"
    if target.exists():
        print("kept", target)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    items = json.loads((SAMPLES.parent / "data" / "mock_zoho_catalog.json").read_text())["items"]
    rows = [["Item code", "Item name", "Unit", "Price", "Description"]]
    rows += [[i["sku"], i["name"], i["unit"], i["rate"] or None, i.get("description") or ""]
             for i in items if i.get("seed", True)]
    target.write_bytes(xlsx(rows))
    print("wrote", target)


def pdf_rfq() -> bytes:
    """A buyer's RFQ as a PDF table — read by the AI layer."""
    from fpdf import FPDF
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 10, "Demo Customer Pvt Ltd - Request for Quotation", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, "RFQ No: RFQ-ELEC-0944    Required by: within 3 weeks", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    with pdf.table(col_widths=(10, 35, 95, 20, 20)) as table:
        for row in [("Sl", "Material", "Description", "Qty", "UOM"),
                    ("1", "1300043319", "BOX,JNCTN,ELEC,4X4X2IN,GI", "14", "EA"),
                    ("2", "1200078573", "LMP,DWN LGHT,18W,220-240V,DN172B", "25", "EA"),
                    ("3", "", "Duct tape 50mm x 25m", "5", "EA")]:
            r = table.row()
            for c in row:
                r.cell(c)
    return bytes(pdf.output())


def main() -> None:
    write_price_list()
    need_by = (date.today() + timedelta(days=21)).strftime("%d/%m/%Y")

    eml("rfq_with_excel.eml", f"Ravi Kumar <{CUSTOMER}>",
        "RFQ-ELEC-0918 - Request for quotation: electrical spares",
        f"""Dear Sales Team,

Please find attached our requirement for electrical spares (tail spend, Sep). Kindly quote your
best prices along with the delivery period for each item.

RFQ No: RFQ-ELEC-0918
Required by: {need_by}
Delivery address: Demo Customer Pvt Ltd, Plot 12, Autonagar
Visakhapatnam 530012, Andhra Pradesh

Prices should be inclusive of freight to our Vizag plant. GST extra as applicable.

Regards,
Ravi Kumar
Demo Customer Pvt Ltd
Purchase Department
Mobile: +91 98480 12345
""", ("Electrical tail spend Sep-09.xlsx", (SAMPLES / "electrical_tail_spend.xlsx").read_bytes()))

    eml("rfq_inline_items.eml", f"Priya Sharma <{CUSTOMER}>",
        "Need quotation - shutdown spares",
        """Hi team,

Hope you're doing well. We need a quotation for the below at the earliest, our plant shutdown
starts next month.

We need 20 nos of the Finder relay 55.34 with socket (our code 1300077549), around 150 metres of
3.5 core 25 sqmm aluminium armoured cable, and 2 Eaton 9E 3kVA online UPS units.
Also add:
- MECO DC panel ammeter SMP35SW x 3
- SS cable ties 150mm, 10 packets

Please mention the delivery time for each.

Thanks & regards,
Priya Sharma
Demo Customer Pvt Ltd
""")

    eml("rfq_odd_layout.eml", f"Anil Reddy <{CUSTOMER}>",
        "Material list for substation maintenance",
        """Hello,

Attached is the material list for our substation maintenance work. Please send your quotation
by this Friday. Our ref is MR-SUB-2231.

Anil
Maintenance, Demo Customer Pvt Ltd
""", ("substation_material_list.xlsx", xlsx([
            ["Material Requirement - Substation maintenance"],
            ["Raised by", "Electrical Dept"],
            [],
            ["Sl", "What we need", "Make / Part ref", "How many", "Units"],
            [1, "Downlight LED 18W round", "Philips DN172B", 40, "Nos"],
            [2, "Junction box 4x4x2 GI", None, 25, "Nos"],
            [3, "Duct tape 50mm", None, 12, "Rolls"],
            [4, "Panel cooling fan 6 inch", "Rexnord AC062", 6, "Nos"],
        ])))

    eml("rfq_bad_quantity.eml", f"Ravi Kumar <{CUSTOMER}>",
        "RFQ-ELEC-0931 - quotation required",
        """Dear Sales Team,

Please quote for the attached items.

RFQ No: RFQ-ELEC-0931

Regards,
Ravi Kumar
Demo Customer Pvt Ltd
""", ("rfq_0931.xlsx", xlsx([
            ["Item Code", "Description", "Qty", "UOM"],
            [1300043319, "BOX,JNCTN,ELEC,4X4X2IN,GI", 0, "EA"],
            [1200078573, "LMP,DWN LGHT,18W,220-240V,DN172B", "TBD", "EA"],
            [1300077549, "Rly,Aux,Soc,P38,7A,4NO+4NC,230VAC", 10, "NOS"],
        ])))

    msg_pdf = ("rfq_pdf.eml", f"Ravi Kumar <{CUSTOMER}>", "RFQ-ELEC-0944 - quotation request (PDF attached)",
               """Dear Sales Team,

Please find our RFQ attached as a PDF and send your quotation.

Regards,
Ravi Kumar
Demo Customer Pvt Ltd
""")
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = msg_pdf[1], INBOX, msg_pdf[2]
    msg["Date"], msg["Message-ID"] = formatdate(localtime=True), make_msgid(domain="demo.example.com")
    msg.set_content(msg_pdf[3])
    msg.add_attachment(pdf_rfq(), maintype="application", subtype="pdf", filename="RFQ-ELEC-0944.pdf")
    (SAMPLES / msg_pdf[0]).write_bytes(bytes(msg))
    print("wrote", SAMPLES / msg_pdf[0])

    eml("rfq_unknown_customer.eml", "Kiran Rao <purchase@newbuyer.example>",
        "Enquiry for cable ties and duct tape",
        """Hi,

We are a new buyer. Please send a quotation for the attached list.

Regards,
Kiran Rao
New Buyer Engineering
""", ("enquiry.xlsx", xlsx([
            ["Item Code", "Description", "Qty", "UOM"],
            [1300055887, "TIE,CBL,150MM,SS", 50, "PKT"],
            [1300055724, "TAPE,ADHSV,DUCT,25M,50MM,200UM,PE", 30, "EA"],
        ])))


if __name__ == "__main__":
    main()
