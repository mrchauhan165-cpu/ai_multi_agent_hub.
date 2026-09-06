# Jewellery Bill Generator

A fast, offline-first web app for jewellers to create GST-ready invoices and
estimates for gold, silver, platinum and diamond jewellery — with per-gram
rates, wastage / value addition, making charges, stone charges, old-metal
exchange, part payments, and print-ready output on A4, A5, Letter or 80 mm
thermal paper.

No build step, no server, no accounts. Open `index.html` and start billing.
All data lives in the browser (`localStorage`) and can be backed up / restored
as JSON.

## Features

**Billing**
- Line items with gross / less / net weight, wastage (VA) %, rate per gram,
  and making charges as **per gram**, **% of metal value**, **per piece** or
  **flat**; stone / other charges and per-item discount.
- Purity presets (24K / 22K / 18K / 14K / 925 silver / 950 platinum …) that
  auto-fill today's rate; HSN and HUID fields.
- Old-metal exchange: net weight × purity × rate, minus a melting/testing
  deduction, subtracted from the bill (negative totals become a refund).
- Bill-level discount (amount or %) applied pro-rata **before** tax.
- Tax modes: GST (CGST + SGST), IGST, VAT, sales tax or none; tax-exclusive or
  tax-inclusive pricing; per-item tax-rate override (e.g. 18 % on a watch).
- Additional charges (hallmarking, certification, courier) with their own tax
  rate. Round-off to the nearest unit. Multiple payments (cash / UPI / card…)
  with balance due.
- Amount in words (Indian lakh/crore or international system), metal summary
  with fine weight, tax split.
- Tax invoices and estimates with separate auto-numbering
  (`INV-0001`, `EST-0001`; prefix & padding configurable).

**Output**
- Live preview with three templates (Classic / Modern / Compact) and four
  paper sizes (A4 / A5 / Letter / 80 mm thermal).
- Print or save as PDF straight from the browser; print Original + Duplicate
  (+ Office copy) in one go.
- Download a standalone HTML copy, copy a WhatsApp-friendly text summary or
  open WhatsApp directly to the customer's number.

**Records & settings**
- Saved bills with search, filters (invoices / estimates / due / paid),
  outstanding & monthly totals, CSV export, re-open / duplicate / delete.
- Previous customers auto-suggest.
- Shop profile (logo, signature, GSTIN, PAN, BIS licence, bank/UPI details,
  terms, footer) and billing defaults.
- Today's rates board with "derive karat rates from 24K" and a quick
  calculator.
- JSON backup / restore of everything.
- Keyboard shortcuts: `Ctrl/⌘+S` save, `Ctrl/⌘+P` preview → print.

## Running

Just open `index.html` in a browser, or serve the folder with any static
server:

```bash
python3 -m http.server 8080
# then open http://localhost:8080/
```

It works fully offline; the Google Fonts link is optional (falls back to
system fonts).

## Project layout

```
index.html         App shell (editor, preview, history, rates, settings)
css/app.css        Application UI styles
css/invoice.css    Invoice document styles (screen + print, 3 templates)
js/utils.js        Formatting, currency, dates, amount-in-words
js/calc.js         Pricing engine (pure functions — no DOM)
js/store.js        localStorage persistence, numbering, backup/restore
js/invoice.js      Invoice HTML renderer + text summary
js/app.js          UI controller
tests/             Node test-suite for the engine and a jsdom integration run
```

## Pricing model

For each line item:

```
net weight        = gross − less (stones / thread / lac)
wastage weight    = net × wastage %
metal value       = (net + wastage) × rate per gram
making            = per-gram × net | % of metal value | per piece × qty | flat
line amount       = metal value + making + stone + other − item discount
```

Bill discount is allocated across lines proportionally, then tax is applied
(or backed out, if prices are tax-inclusive). Additional charges are taxed at
their own rate. Old-metal exchange value is deducted from the grand total,
the result is rounded (optional) and payments are subtracted to give the
balance.

## Tests

```bash
npm test                    # engine tests (no dependencies; integration suite skips without jsdom)
npm i -D jsdom && npm test  # also runs the jsdom integration suite
```

## Notes

- Default rates in **Today's rates** are placeholders — update them from your
  board rate each morning.
- Because data is stored per browser, use **Settings → Backup** regularly
  and before switching devices or clearing browser data.
