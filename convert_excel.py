#!/usr/bin/env python3
"""
Convert MCCS_Sales_Sample_Data.xlsx into dataset.json for the app's seeder.

Run this whenever the spreadsheet changes:

    python convert_excel.py MCCS_Sales_Sample_Data.xlsx

It writes dataset.json next to itself. Commit that file and redeploy, and the
seeder loads it on boot.

Only source columns are carried across. Anything the app computes (gross margin,
lift, ROI, incremental margin) is deliberately left out so there is exactly one
place where each number is produced.

Requires: pandas, openpyxl   ->   pip install pandas openpyxl
"""
import json
import sys
from pathlib import Path

import pandas as pd

SALES_SHEET = "Sales_Retail"
PROMO_SHEET = "Marketing_Promotions"

SALES_COLS = [
    "Month", "Installation", "Business Line", "Category",
    "Transactions", "Units Sold", "Gross Revenue", "COGS",
    "Inventory On Hand (Units)",
]
PROMO_COLS = [
    "Campaign ID", "Campaign Name", "Channel", "Installation", "Business Line",
    "Start Date", "End Date", "Marketing Spend", "Markdown %",
    "Baseline Period Sales", "Promo Period Sales", "Margin Rate",
]


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def require_columns(df, needed, sheet):
    missing = [c for c in needed if c not in df.columns]
    if missing:
        fail(f"{sheet} is missing column(s): {', '.join(missing)}")


def main():
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "MCCS_Sales_Sample_Data.xlsx")
    if not src.exists():
        fail(f"cannot find {src}")

    sales = pd.read_excel(src, SALES_SHEET)
    promos = pd.read_excel(src, PROMO_SHEET)
    require_columns(sales, SALES_COLS, SALES_SHEET)
    require_columns(promos, PROMO_COLS, PROMO_SHEET)

    # Revenue minus COGS must equal the sheet's own Gross Margin, or the
    # spreadsheet's formulas were edited and the numbers cannot be trusted.
    if "Gross Margin" in sales.columns:
        drift = ((sales["Gross Revenue"] - sales["COGS"]) - sales["Gross Margin"]).abs().max()
        if drift > 0.01:
            fail(f"Gross Revenue minus COGS does not match Gross Margin (max drift {drift:.2f})")

    sales = sales.sort_values(["Month", "Installation", "Business Line", "Category"])

    months = sorted(sales["Month"].dt.strftime("%Y-%m").unique().tolist())
    insts = sorted(sales["Installation"].unique().tolist())
    cats = sorted({f"{r['Business Line']}|{r['Category']}" for _, r in sales.iterrows()})

    m_idx = {m: i for i, m in enumerate(months)}
    i_idx = {n: i for i, n in enumerate(insts)}
    c_idx = {c: i for i, c in enumerate(cats)}

    def clean_int(v):
        return None if pd.isna(v) else int(round(float(v)))

    def clean_float(v):
        return None if pd.isna(v) else round(float(v), 2)

    rows = []
    for _, r in sales.iterrows():
        rows.append([
            m_idx[r["Month"].strftime("%Y-%m")],
            i_idx[r["Installation"]],
            c_idx[f"{r['Business Line']}|{r['Category']}"],
            clean_int(r["Transactions"]),
            clean_int(r["Units Sold"]),
            clean_float(r["Gross Revenue"]),
            clean_float(r["COGS"]),
            clean_int(r["Inventory On Hand (Units)"]),  # None outside MCX Retail
        ])

    def as_date(v):
        return None if pd.isna(v) else pd.Timestamp(v).strftime("%Y-%m-%d")

    campaigns = []
    for _, r in promos.iterrows():
        campaigns.append({
            "id": str(r["Campaign ID"]),
            "name": str(r["Campaign Name"]),
            "ch": str(r["Channel"]),
            "inst": str(r["Installation"]),
            "bl": str(r["Business Line"]),
            "start": as_date(r["Start Date"]),
            "end": as_date(r["End Date"]),
            "spend": clean_float(r["Marketing Spend"]),
            # Sheet stores these as fractions. The app works in percent.
            "md": round(float(r["Markdown %"]) * 100, 2),
            "base": clean_float(r["Baseline Period Sales"]),
            "promo": clean_float(r["Promo Period Sales"]),
            "marginRate": round(float(r["Margin Rate"]) * 100, 2),
        })

    out = {
        "source": src.name,
        "generated": pd.Timestamp.now("UTC").strftime("%Y-%m-%dT%H:%M:%SZ"),
        "months": months,
        "insts": insts,
        "cats": cats,
        "sales": rows,
        "promos": campaigns,
    }

    dest = Path(__file__).parent / "dataset.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))

    revenue = sales["Gross Revenue"].sum()
    print(f"Wrote {dest}")
    print(f"  {len(months)} months  {months[0]} to {months[-1]}")
    print(f"  {len(insts)} installations, {len(cats)} categories")
    print(f"  {len(rows)} sales rows, total revenue ${revenue:,.0f}")
    print(f"  {len(campaigns)} campaigns")
    print(f"  {dest.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
