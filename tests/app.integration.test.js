// Integration test: boots the whole SPA in jsdom and walks through a real bill.
// Requires jsdom (npm i -D jsdom). Skips gracefully if it is not installed.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (e) { /* optional dev dependency */ }

const ROOT = path.join(__dirname, '..');

function boot(seed) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.addEventListener('error', (e) => errors.push(e.error || e.message));
  window.scrollTo = () => {};
  window.confirm = () => true;
  window.print = () => { window.__printed = (window.__printed || 0) + 1; };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
  if (seed) Object.keys(seed).forEach((k) => window.localStorage.setItem(k, seed[k]));

  for (const f of ['utils', 'calc', 'store', 'invoice', 'app']) {
    window.eval(fs.readFileSync(path.join(ROOT, 'js', f + '.js'), 'utf8') + `\n//# sourceURL=${f}.js`);
  }
  // app.js initialises itself on DOMContentLoaded (or immediately if the DOM is
  // already parsed); wait for jsdom's own event so init runs exactly once.
  return new Promise((resolve) => {
    const done = () => resolve({ window, document: window.document, errors });
    if (window.document.readyState === 'loading') window.document.addEventListener('DOMContentLoaded', done);
    else done();
  });
}

function type(window, el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const skip = JSDOM ? false : 'jsdom not installed';

test('app boots without runtime errors and shows an empty bill', { skip }, async () => {
  const { document, errors } = await boot();
  assert.deepEqual(errors, []);
  assert.equal(document.querySelectorAll('#items .item').length, 1);
  assert.match(document.querySelector('#summary').textContent, /Net payable/);
  assert.match(document.querySelector('#f-invoiceNo').placeholder, /INV-0001/);
});

test('full bill flow: items, old gold, payment, save, preview, print', { skip }, async () => {
  const { window, document, errors } = await boot();
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // Customer
  type(window, $('#c-name'), 'Priya Sharma');
  type(window, $('#c-phone'), '9876543210');

  // Item 1 via quick-add chip (reuses the empty first row)
  $('[data-quick^="Gold Chain"]').click();
  assert.equal($$('#items .item').length, 1);
  let row = $('#items .item');
  assert.equal(row.querySelector('[data-k=description]').value, 'Gold Chain');
  assert.equal(row.querySelector('[data-k=purity]').value, '22K');
  assert.equal(Number(row.querySelector('[data-k=rate]').value), 14190, 'rate auto-filled from settings');
  type(window, row.querySelector('[data-k=grossWeight]'), '10.5');
  type(window, row.querySelector('[data-k=lessWeight]'), '0.5');
  type(window, row.querySelector('[data-k=makingValue]'), '500');
  assert.equal(row.querySelector('.item-net').value, '10.000');
  // 10 g * 14190 = 141,900 + making 5,000 = 146,900
  assert.equal(row.querySelector('.item-amount-val').textContent, '\u20B91,46,900.00');

  // Item 2: add and switch category to Silver -> purity/rate follow
  $('#addItemBtn').click();
  assert.equal($$('#items .item').length, 2);
  row = $$('#items .item')[1];
  type(window, row.querySelector('[data-k=description]'), 'Silver Anklets');
  type(window, row.querySelector('[data-k=category]'), 'Silver');
  assert.equal(row.querySelector('[data-k=purity]').value, '925 Silver');
  assert.equal(Number(row.querySelector('[data-k=rate]').value), 218);
  type(window, row.querySelector('[data-k=grossWeight]'), '50');
  type(window, row.querySelector('[data-k=makingType]'), 'percent');
  type(window, row.querySelector('[data-k=makingValue]'), '10');
  // 50 * 218 = 10,900 + 10% = 11,990

  // Old gold exchange
  $('#oldCard .card-toggle').click();
  assert.equal($$('#oldItems .row-line').length, 1, 'opening the section adds a row');
  const old = $('#oldItems .row-line');
  type(window, old.querySelector('[data-k=description]'), 'Old bangle');
  type(window, old.querySelector('[data-k=grossWeight]'), '5');
  // purity 91.6 default, rate = 24K 15480 -> 5*0.916*15480 = 70,898.40

  // Totals: subtotal 158,890; GST 3% = 4,766.70; grand = 163,656.70; less 70,898.40 = 92,758.30 -> round 92,758
  const summary = $('#summary').textContent;
  assert.match(summary, /Subtotal.*\u20B91,58,890\.00/);
  assert.match(summary, /CGST @ 1\.5%\u20B92,383\.35/);
  assert.match(summary, /Grand total\u20B91,63,656\.70/);
  assert.match(summary, /Old metal exchange− \u20B970,898\.40/);
  assert.match(summary, /Net payable\u20B992,758\.00/);
  assert.match(summary, /Rupees Ninety Two Thousand Seven Hundred Fifty Eight Only/);

  // Payment: mark fully paid then reduce to a part payment
  $('#payFullBtn').click();
  let pay = $('#payments .row-line');
  assert.equal(Number(pay.querySelector('[data-k=amount]').value), 92758);
  type(window, pay.querySelector('[data-k=amount]'), '50000');
  type(window, pay.querySelector('[data-k=mode]'), 'UPI');
  assert.match($('#summary').textContent, /Balance due\u20B942,758\.00/);

  // Save -> invoice number assigned & persisted
  $('#saveBtn').click();
  assert.equal($('#f-invoiceNo').value, 'INV-0001');
  assert.equal(window.JBStore.getBills().length, 1);
  assert.equal($('#billCount').textContent, '1');
  assert.match($('#f-invoiceNo').placeholder, /INV-0002/);

  // Preview renders an invoice with the right figures
  $('#previewBtn').click();
  assert.ok($('#view-preview').classList.contains('is-active'));
  const inv = $('#previewStage .inv');
  assert.ok(inv, 'invoice rendered');
  const invText = inv.textContent;
  assert.match(invText, /TAX INVOICE/);
  assert.match(invText, /INV-0001/);
  assert.match(invText, /Priya Sharma/);
  assert.match(invText, /Gold Chain/);
  assert.match(invText, /Old bangle/);
  assert.match(invText, /PARTIALLY PAID/);
  assert.match(invText, /Balance due\u20B942,758\.00/);
  assert.match(invText, /Rupees Ninety Two Thousand Seven Hundred Fifty Eight Only/);

  // Copies and templates
  type(window, $('#p-copies'), '2');
  assert.equal($$('#previewStage .inv').length, 2);
  assert.match($$('#previewStage .inv-copy')[1].textContent, /Duplicate/);
  type(window, $('#p-template'), 'modern');
  assert.ok($('#previewStage .inv--modern'));
  type(window, $('#p-paper'), 'thermal');
  assert.ok($('#previewStage .sheet--thermal'));

  // Print fills the print root and calls window.print
  $('#printBtn').click();
  return new Promise((resolve) => setTimeout(resolve, 80)).then(() => {
    assert.equal(window.__printed, 1);
    assert.equal($$('#printRoot .inv').length, 2);
    assert.ok(document.body.classList.contains('is-printing'));
    window.dispatchEvent(new window.Event('afterprint'));
    assert.ok(!document.body.classList.contains('is-printing'));
    assert.match($('#pageStyle').textContent, /80mm auto/);

    // History shows the saved bill with DUE pill and correct stats
    document.querySelector('.nav-btn[data-view=history]').click();
    const histRow = $('#histTable tbody tr');
    assert.ok(histRow);
    assert.match(histRow.textContent, /INV-0001/);
    assert.match(histRow.textContent, /DUE/);
    assert.match($('#histStats').textContent, /Outstanding/);
    assert.match($('#histStats').textContent, /\u20B942,758\.00/);

    // Filter: paid should hide it, due should show it
    type(window, $('#histFilter'), 'paid');
    assert.equal($$('#histTable tbody tr').length, 0);
    type(window, $('#histFilter'), 'due');
    assert.equal($$('#histTable tbody tr').length, 1);

    // New bill => empty editor, numbering continues
    document.querySelector('.nav-btn[data-view=editor]').click();
    $('#newBtn').click();
    assert.equal($('#f-invoiceNo').value, '');
    assert.equal($$('#items .item').length, 1);
    assert.equal($('#items .item [data-k=description]').value, '');

    // Reopen from history and previous customer suggestions exist
    document.querySelector('.nav-btn[data-view=history]').click();
    $('#histTable [data-act=open]').click();
    assert.equal($('#c-name').value, 'Priya Sharma');
    assert.match($('#custList').innerHTML, /Priya Sharma/);

    assert.deepEqual(errors, []);
  });
});

test('estimate numbering is separate and inclusive-tax toggles work', { skip }, async () => {
  const { window, document, errors } = await boot();
  const $ = (s) => document.querySelector(s);
  $('.seg-btn[data-doctype=estimate]').click();
  assert.match($('#f-invoiceNo').placeholder, /EST-0001/);
  const row = $('#items .item');
  type(window, row.querySelector('[data-k=description]'), 'Ring');
  type(window, row.querySelector('[data-k=grossWeight]'), '10');
  type(window, row.querySelector('[data-k=rate]'), '5150');
  $('#f-taxInclusive').click();
  assert.match($('#summary').textContent, /Taxable value\u20B950,000\.00/);
  $('#saveBtn').click();
  assert.equal($('#f-invoiceNo').value, 'EST-0001');
  $('#previewBtn').click();
  assert.match($('#previewStage .inv-doc-type').textContent, /ESTIMATE/);
  assert.deepEqual(errors, []);
});

test('settings form round-trips and changes defaults for new bills', { skip }, async () => {
  const { window, document, errors } = await boot();
  const $ = (s) => document.querySelector(s);
  document.querySelector('.nav-btn[data-view=settings]').click();
  type(window, $('[name=shopName]'), 'Shree Jewellers');
  type(window, $('[name=gstin]'), '27abcde1234f1z5');
  type(window, $('[name=invoicePrefix]'), 'SJ/26-27/');
  type(window, $('[name=invoiceNext]'), '101');
  type(window, $('[name=taxType]'), 'gst_inter');
  $('#settingsForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const s = window.JBStore.getSettings();
  assert.equal(s.shopName, 'Shree Jewellers');
  assert.equal(s.gstin, '27ABCDE1234F1Z5');
  assert.equal(s.invoiceNext, 101);

  document.querySelector('.nav-btn[data-view=editor]').click();
  $('#newBtn').click();
  assert.match($('#f-invoiceNo').placeholder, /SJ\/26-27\/0101/);
  assert.equal($('#f-taxType').value, 'gst_inter');
  const row = $('#items .item');
  type(window, row.querySelector('[data-k=description]'), 'Ring');
  type(window, row.querySelector('[data-k=grossWeight]'), '1');
  assert.match($('#summary').textContent, /IGST @ 3%/);
  $('#previewBtn').click();
  assert.match($('#previewStage .inv').textContent, /Shree Jewellers/);
  assert.match($('#previewStage .inv').textContent, /27ABCDE1234F1Z5/);
  assert.deepEqual(errors, []);
});

test('rates page: derive from 24K, save, and quick calculator', { skip }, async () => {
  const { window, document, errors } = await boot();
  const $ = (s) => document.querySelector(s);
  document.querySelector('.nav-btn[data-view=rates]').click();
  type(window, $('#ratesGrid input[data-rate="24K"]'), '16000');
  $('#deriveRatesBtn').click();
  assert.equal(Number($('#ratesGrid input[data-rate="22K"]').value), Math.round(16000 * 22 / 24));
  $('#saveRatesBtn').click();
  assert.equal(window.JBStore.getSettings().rates['22K'], Math.round(16000 * 22 / 24));
  assert.match($('#sidebarRates').textContent, /16,000/);

  type(window, $('#qc-purity'), '24K');
  type(window, $('#qc-weight'), '10');
  assert.match($('#qc-result').textContent, /1,60,000\.00/);
  assert.deepEqual(errors, []);
});

test('draft autosaves (debounced) and is restored on next boot', { skip }, async () => {
  const a = await boot();
  type(a.window, a.document.querySelector('#c-name'), 'Draft Customer');
  await new Promise((resolve) => setTimeout(resolve, 500)); // autosave is debounced (400ms)
  const raw = a.window.localStorage.getItem('jbg:draft');
  assert.equal(JSON.parse(raw).customer.name, 'Draft Customer');
  assert.deepEqual(a.errors, []);

  // jsdom gives every window a fresh localStorage; copy the draft across to
  // simulate a reload of the same browser profile.
  const c = await boot({ 'jbg:draft': raw });
  assert.equal(c.document.querySelector('#c-name').value, 'Draft Customer');
  assert.deepEqual(c.errors, []);
});
