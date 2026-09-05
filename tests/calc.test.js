// Run with:  npm test   (node --test "tests/**/*.test.js")
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../js/utils.js');
const C = require('../js/calc.js');

const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.005, `${msg || ''} expected ${b}, got ${a}`);

/* ------------------------------------------------------------------ */
/* utils                                                               */
/* ------------------------------------------------------------------ */

test('num() parses leniently', () => {
  assert.equal(U.num('1,234.50'), 1234.5);
  assert.equal(U.num(''), 0);
  assert.equal(U.num(null), 0);
  assert.equal(U.num('abc'), 0);
  assert.equal(U.num(NaN), 0);
  assert.equal(U.num(12), 12);
});

test('round2() handles float noise', () => {
  assert.equal(U.round2(1.005), 1.01);
  assert.equal(U.round2(2.675), 2.68);
  assert.equal(U.round2(-1.005), -1);
});

test('formatMoney() uses Indian grouping for INR and western grouping for USD', () => {
  assert.equal(U.formatMoney(1234567.891, 'INR'), '\u20B912,34,567.89');
  assert.equal(U.formatMoney(1234567.891, 'USD'), '$1,234,567.89');
  assert.equal(U.formatMoney(-50, 'INR'), '-\u20B950.00');
});

test('formatDate()', () => {
  assert.equal(U.formatDate('2026-09-05'), '05 Sep 2026');
  assert.equal(U.formatDate(''), '');
});

test('numberToWords() indian system', () => {
  assert.equal(U.numberToWords(0, 'indian'), 'Zero');
  assert.equal(U.numberToWords(19, 'indian'), 'Nineteen');
  assert.equal(U.numberToWords(105, 'indian'), 'One Hundred Five');
  assert.equal(U.numberToWords(1234, 'indian'), 'One Thousand Two Hundred Thirty Four');
  assert.equal(U.numberToWords(100000, 'indian'), 'One Lakh');
  assert.equal(U.numberToWords(1234567, 'indian'), 'Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven');
  assert.equal(U.numberToWords(12345678, 'indian'), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
  assert.equal(U.numberToWords(1e9, 'indian'), 'One Hundred Crore');
});

test('numberToWords() international system', () => {
  assert.equal(U.numberToWords(1234567, 'intl'), 'One Million Two Hundred Thirty Four Thousand Five Hundred Sixty Seven');
  assert.equal(U.numberToWords(1000000000, 'intl'), 'One Billion');
});

test('amountInWords()', () => {
  assert.equal(U.amountInWords(1234.5, 'INR'), 'Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only');
  assert.equal(U.amountInWords(100, 'USD'), 'Dollars One Hundred Only');
  assert.equal(U.amountInWords(0.999, 'INR'), 'Rupees One Only'); // rounds to 1.00
  assert.equal(U.amountInWords(0, 'INR'), 'Rupees Zero Only');
});

test('escapeHtml()', () => {
  assert.equal(U.escapeHtml('<b>"Tom" & \'Jerry\'</b>'), '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
});

/* ------------------------------------------------------------------ */
/* calc — items                                                        */
/* ------------------------------------------------------------------ */

const bill = (over) => Object.assign(C.newBill(), over || {});

test('per-gram making, wastage and stone deduction', () => {
  const b = bill({
    items: [C.newItem({ description: 'Chain', grossWeight: 10.5, lessWeight: 0.5, wastagePct: 10, rate: 6000, makingType: 'per_gram', makingValue: 500 })]
  });
  const r = C.computeBill(b);
  const l = r.lines[0];
  approx(l.netWeight, 10, 'net');
  approx(l.wastageWeight, 1, 'wastage');
  approx(l.chargeableWeight, 11, 'chargeable');
  approx(l.metalValue, 66000, 'metal');
  approx(l.making, 5000, 'making');       // 500 * 10 net g
  approx(l.amount, 71000, 'amount');
});

test('making types: percent / per_piece / flat', () => {
  const base = { grossWeight: 10, rate: 1000 }; // metal = 10,000
  const pct = C.computeItem(C.newItem({ ...base, makingType: 'percent', makingValue: 12 }), bill());
  approx(pct.making, 1200, 'percent');
  const piece = C.computeItem(C.newItem({ ...base, makingType: 'per_piece', makingValue: 250, qty: 4 }), bill());
  approx(piece.making, 1000, 'per piece');
  const flat = C.computeItem(C.newItem({ ...base, makingType: 'flat', makingValue: 999, qty: 4 }), bill());
  approx(flat.making, 999, 'flat');
});

test('less weight is clamped to gross', () => {
  const l = C.computeItem(C.newItem({ grossWeight: 5, lessWeight: 9, rate: 100 }), bill());
  approx(l.netWeight, 0);
  approx(l.metalValue, 0);
});

/* ------------------------------------------------------------------ */
/* calc — bill totals                                                  */
/* ------------------------------------------------------------------ */

test('GST 3% split into CGST/SGST 1.5% each, exclusive', () => {
  const b = bill({ items: [C.newItem({ description: 'Ring', grossWeight: 10, rate: 5000 })] }); // 50,000
  const r = C.computeBill(b);
  approx(r.subtotal, 50000);
  approx(r.taxable, 50000);
  approx(r.tax, 1500);
  assert.equal(r.taxSplit.length, 2);
  assert.equal(r.taxSplit[0].label, 'CGST @ 1.5%');
  approx(r.taxSplit[0].amount, 750);
  approx(r.taxSplit[1].amount, 750);
  approx(r.grandTotal, 51500);
  approx(r.netPayable, 51500);
  approx(r.balance, 51500);
});

test('inclusive tax backs GST out of the entered amount', () => {
  const b = bill({ items: [C.newItem({ description: 'Ring', grossWeight: 10, rate: 5150 })] }); // 51,500 incl.
  b.tax.inclusive = true;
  const r = C.computeBill(b);
  approx(r.taxable, 50000);
  approx(r.tax, 1500);
  approx(r.grandTotal, 51500);
});

test('IGST is a single line', () => {
  const b = bill({ items: [C.newItem({ description: 'Ring', grossWeight: 10, rate: 5000 })] });
  b.tax.type = 'gst_inter';
  const r = C.computeBill(b);
  assert.equal(r.taxSplit.length, 1);
  assert.equal(r.taxSplit[0].label, 'IGST @ 3%');
  approx(r.taxSplit[0].amount, 1500);
});

test('tax type none zeroes tax even with a rate set', () => {
  const b = bill({ items: [C.newItem({ description: 'Ring', grossWeight: 10, rate: 5000 })] });
  b.tax.type = 'none';
  const r = C.computeBill(b);
  approx(r.tax, 0);
  approx(r.grandTotal, 50000);
  assert.equal(r.taxSplit.length, 0);
});

test('per-item tax override groups tax by rate', () => {
  const b = bill({
    items: [
      C.newItem({ description: 'Gold', grossWeight: 10, rate: 5000 }),                 // 50,000 @ 3%
      C.newItem({ description: 'Watch', grossWeight: 0, makingType: 'flat', makingValue: 10000, taxRate: 18 }) // 10,000 @ 18%
    ]
  });
  const r = C.computeBill(b);
  approx(r.tax, 1500 + 1800);
  assert.equal(r.taxSplit.length, 4); // CGST/SGST for 3% and for 18%
  assert.equal(r.taxSplit[2].label, 'CGST @ 9%');
});

test('bill-level flat discount is applied before tax, pro-rata', () => {
  const b = bill({
    items: [
      C.newItem({ description: 'A', grossWeight: 10, rate: 3000 }), // 30,000
      C.newItem({ description: 'B', grossWeight: 10, rate: 1000 })  // 10,000
    ],
    discountType: 'flat',
    discountValue: 4000
  });
  const r = C.computeBill(b);
  approx(r.discount, 4000);
  approx(r.lines[0].discountShare, 3000);
  approx(r.lines[1].discountShare, 1000);
  approx(r.taxable, 36000);
  approx(r.tax, 1080);
  approx(r.grandTotal, 37080);
});

test('percent discount', () => {
  const b = bill({ items: [C.newItem({ description: 'A', grossWeight: 10, rate: 1000 })], discountType: 'percent', discountValue: 10 });
  const r = C.computeBill(b);
  approx(r.discount, 1000);
  approx(r.taxable, 9000);
});

test('flat discount cannot exceed subtotal', () => {
  const b = bill({ items: [C.newItem({ description: 'A', grossWeight: 1, rate: 100 })], discountType: 'flat', discountValue: 5000 });
  const r = C.computeBill(b);
  approx(r.discount, 100);
  approx(r.taxable, 0);
});

test('additional charges are taxed at their own rate and included in grand total', () => {
  const b = bill({
    items: [C.newItem({ description: 'A', grossWeight: 10, rate: 1000 })], // 10,000 @3% => 10,300
    charges: [C.newCharge({ label: 'Hallmarking', amount: 100, taxRate: 18 })] // 118
  });
  const r = C.computeBill(b);
  approx(r.chargesTotal, 118);
  approx(r.grandTotal, 10418);
  approx(r.tax, 300 + 18);
});

test('old gold exchange with purity and deduction', () => {
  const b = bill({
    items: [C.newItem({ description: 'A', grossWeight: 10, rate: 5000 })], // 51,500 with GST
    oldItems: [C.newOldItem({ description: 'Old bangle', grossWeight: 20, lessWeight: 1, purityPct: 91.6, rate: 5000, deductionPct: 5 })]
  });
  const r = C.computeBill(b);
  const o = r.oldLines[0];
  approx(o.netWeight, 19);
  approx(o.fineWeight, 17.404);
  approx(o.grossValue, 87020);
  approx(o.deduction, 4351);
  approx(o.amount, 82669);
  approx(r.afterExchange, 51500 - 82669); // negative => shop owes customer
  assert.equal(r.netPayable, -31169);
});

test('round off to nearest whole unit and balance after payments', () => {
  const b = bill({
    items: [C.newItem({ description: 'A', grossWeight: 3.333, rate: 3333 })],
    payments: [C.newPayment({ mode: 'UPI', amount: 5000 }), C.newPayment({ mode: 'Cash', amount: 1000 })]
  });
  const r = C.computeBill(b);
  const raw = r.afterExchange;
  assert.equal(r.netPayable, Math.round(raw));
  approx(r.roundOff, Math.round(raw) - raw);
  approx(r.paid, 6000);
  approx(r.balance, Math.round(raw) - 6000);

  b.roundOff = false;
  const r2 = C.computeBill(b);
  assert.equal(r2.netPayable, U.round2(raw));
});

test('metal summary aggregates by category with fine weight', () => {
  const b = bill({
    items: [
      C.newItem({ description: 'A', category: 'Gold', purity: '22K', grossWeight: 10, rate: 1 }),
      C.newItem({ description: 'B', category: 'Gold', purity: '18K', grossWeight: 10, rate: 1 }),
      C.newItem({ description: 'C', category: 'Silver', purity: '925 Silver', grossWeight: 100, rate: 1 })
    ]
  });
  const r = C.computeBill(b);
  const gold = r.metals.find((m) => m.category === 'Gold');
  const silver = r.metals.find((m) => m.category === 'Silver');
  approx(gold.net, 20);
  approx(gold.fine, 9.16 + 7.5);
  approx(silver.fine, 92.5);
  assert.equal(r.totalPieces, 3);
});

test('purityPctFor() understands labels, karats, hallmarks and percents', () => {
  assert.equal(C.purityPctFor('22K'), 91.6);
  assert.equal(C.purityPctFor('22k'), 91.6);
  assert.equal(C.purityPctFor('916'), 91.6);
  approx(C.purityPctFor('21K'), 87.5);
  assert.equal(C.purityPctFor('75%'), 75);
  assert.equal(C.purityPctFor(''), 100);
});

test('validate() reports actionable errors', () => {
  const b = bill({ items: [C.newItem({ description: '', grossWeight: 1, lessWeight: 2 })] });
  const errs = C.validate(b);
  assert.ok(errs.some((e) => /description/.test(e)));
  assert.ok(errs.some((e) => /less weight/.test(e)));
  assert.deepEqual(C.validate(bill({ items: [C.newItem({ description: 'ok', grossWeight: 1, rate: 1 })] })), []);
  assert.deepEqual(C.validate(bill({ items: [] })), ['Add at least one item.']);
});

test('empty bill computes to zero without throwing', () => {
  const r = C.computeBill(bill({ items: [] }));
  assert.equal(r.subtotal, 0);
  assert.equal(r.netPayable, 0);
  assert.equal(r.balance, 0);
});
