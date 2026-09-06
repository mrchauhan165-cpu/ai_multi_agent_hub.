/*
 * app.js — UI controller. Wires the editor, live summary, preview/print,
 * history, rates and settings views to the pure modules (utils / calc /
 * store / invoice).
 */
(function () {
  'use strict';

  var U = window.JBUtils, C = window.JBCalc, S = window.JBStore, INV = window.JBInvoice;
  var esc = U.escapeHtml;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var ICON = {
    del: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    dup: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    print: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/></svg>'
  };

  var PAY_MODES = ['Cash', 'UPI', 'Card', 'Bank transfer', 'Cheque', 'Advance adjusted', 'Other'];
  var DEFAULT_PURITY = { Gold: '22K', Silver: '925 Silver', Platinum: '950 Platinum', Diamond: '18K', Gemstone: '22K', Other: '' };
  var METAL_FOR_CATEGORY = { Gold: 'Gold', Silver: 'Silver', Platinum: 'Platinum', Diamond: 'Gold', Gemstone: 'Gold', Other: '' };
  var VIEW_TITLES = { editor: 'New bill', preview: 'Preview', history: 'Saved bills', rates: "Today's rates", settings: 'Shop settings' };
  var PAPER = {
    a4: { css: 'A4', margin: '10mm' },
    a5: { css: 'A5', margin: '8mm' },
    letter: { css: 'letter', margin: '10mm' },
    thermal: { css: '80mm auto', margin: '3mm' }
  };

  var state = {
    settings: S.getSettings(),
    bill: null,
    computed: null,
    view: 'editor',
    preview: { template: 'classic', paper: 'a4', copies: 1 },
    lastSavedJson: '',
    customers: {}
  };

  /* ================================================================== */
  /* Small helpers                                                       */
  /* ================================================================== */

  var toastTimer;
  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-show'); }, 2800);
  }

  function money(n) { return U.formatMoney(n, state.bill ? state.bill.currency : state.settings.currency); }

  function fillSelect(sel, options, value) {
    sel.innerHTML = options.map(function (o) {
      var v = typeof o === 'string' ? o : o.value;
      var l = typeof o === 'string' ? o : o.label;
      return '<option value="' + esc(v) + '">' + esc(l) + '</option>';
    }).join('');
    if (value != null) sel.value = value;
  }

  function download(filename, content, type) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function rateFor(purity) {
    var rates = state.settings.rates || {};
    if (!purity) return 0;
    if (rates[purity] != null) return U.num(rates[purity]);
    var key = Object.keys(rates).find(function (k) { return k.toLowerCase() === String(purity).toLowerCase(); });
    return key ? U.num(rates[key]) : 0;
  }

  function numOrEmpty(v) { return v == null || v === 0 || v === '' ? '' : v; }

  function safeFilename(s) { return String(s || 'invoice').replace(/[^\w\-]+/g, '_'); }

  /* ================================================================== */
  /* Views                                                               */
  /* ================================================================== */

  function showView(name) {
    state.view = name;
    document.body.className = 'view-' + name;
    $$('.view').forEach(function (v) { v.classList.toggle('is-active', v.id === 'view-' + name); });
    $$('.nav-btn').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === name || (name === 'preview' && b.dataset.view === 'editor'));
    });
    $('#sidebar').classList.remove('is-open');
    if (name === 'history') renderHistory();
    if (name === 'rates') renderRates();
    if (name === 'settings') renderSettingsForm();
    if (name === 'preview') renderPreview();
    updateTopbar();
    window.scrollTo(0, 0);
  }

  function isDirty() {
    return JSON.stringify(state.bill) !== state.lastSavedJson;
  }

  function hasContent(bill) {
    return (bill.items || []).some(function (it) { return it.description || U.num(it.grossWeight) > 0; }) ||
      !!(bill.customer && bill.customer.name) || (bill.oldItems || []).length > 0;
  }

  function updateTopbar() {
    var b = state.bill;
    var title = VIEW_TITLES[state.view];
    var actions = '';
    if (b && (state.view === 'editor' || state.view === 'preview')) {
      var kind = b.docType === 'estimate' ? 'Estimate' : 'Bill';
      title = b.invoiceNo ? kind + ' ' + b.invoiceNo : 'New ' + kind.toLowerCase();
      if (state.view === 'preview') title = 'Preview · ' + title;
      var dirty = isDirty();
      actions = '<span class="muted small">' + (dirty ? (state.lastSavedJson ? 'Unsaved changes' : 'Draft (auto-saved locally)') : 'Saved') + '</span>';
    }
    $('#viewTitle').textContent = title;
    $('#topbarActions').innerHTML = actions;
  }

  /* ================================================================== */
  /* Editor: load / new                                                  */
  /* ================================================================== */

  function newBill() {
    var s = state.settings;
    var b = C.newBill({
      currency: s.currency, taxType: s.taxType, taxRate: s.taxRate, taxInclusive: s.taxInclusive, roundOff: s.roundOff
    });
    b.items = [defaultItem()];
    return b;
  }

  function defaultItem(over) {
    var s = state.settings;
    var it = C.newItem({
      category: 'Gold',
      purity: '22K',
      makingType: s.defaultMakingType || 'per_gram',
      wastagePct: U.num(s.defaultWastage)
    });
    if (over) Object.keys(over).forEach(function (k) { it[k] = over[k]; });
    it.rate = rateFor(it.purity);
    return it;
  }

  function loadBill(bill, savedJson) {
    state.bill = bill;
    state.lastSavedJson = savedJson != null ? savedJson : '';
    $('#f-invoiceNo').value = bill.invoiceNo || '';
    $('#f-date').value = bill.date || U.todayISO();
    $('#f-dueDate').value = bill.dueDate || '';
    $('#f-currency').value = bill.currency || 'INR';
    $$('.seg-btn[data-doctype]').forEach(function (btn) { btn.classList.toggle('is-active', btn.dataset.doctype === (bill.docType || 'invoice')); });
    ['name', 'phone', 'email', 'address', 'gstin', 'pan'].forEach(function (k) { $('#c-' + k).value = (bill.customer && bill.customer[k]) || ''; });
    $('#f-discountValue').value = numOrEmpty(bill.discountValue);
    $('#f-discountType').value = bill.discountType || 'flat';
    $('#f-taxType').value = bill.tax.type;
    $('#f-taxRate').value = bill.tax.rate;
    $('#f-taxInclusive').checked = !!bill.tax.inclusive;
    $('#f-roundOff').checked = !!bill.roundOff;
    $('#f-notes').value = bill.notes || '';
    $('#oldCard').classList.toggle('is-open', (bill.oldItems || []).length > 0);
    updateInvoicePlaceholder();
    renderItems();
    renderOld();
    renderCharges();
    renderPayments();
    recalc();
  }

  function updateInvoicePlaceholder() {
    $('#f-invoiceNo').placeholder = 'Auto: ' + S.peekNumber(state.bill.docType, state.settings);
  }

  function startNewBill(force) {
    if (!force && state.bill && isDirty() && hasContent(state.bill)) {
      if (!confirm('Discard unsaved changes to the current bill?')) return;
    }
    S.clearDraft();
    loadBill(newBill(), '');
    showView('editor');
    $('#c-name').focus();
  }

  function duplicateBill() {
    var b = U.clone(state.bill);
    b.id = U.uid();
    b.invoiceNo = '';
    b.date = U.todayISO();
    b.payments = [];
    b.createdAt = new Date().toISOString();
    b.items.forEach(function (it) { it.id = U.uid(); });
    b.oldItems.forEach(function (it) { it.id = U.uid(); });
    b.charges.forEach(function (it) { it.id = U.uid(); });
    loadBill(b, '');
    showView('editor');
    toast('Duplicated — this is a new unsaved bill');
  }

  /* ================================================================== */
  /* Editor: items                                                       */
  /* ================================================================== */

  function renderItems() {
    var wrap = $('#items');
    var tpl = $('#itemTpl');
    wrap.innerHTML = '';
    state.bill.items.forEach(function (it, i) {
      var node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.id = it.id;
      $('.item-no', node).textContent = i + 1;
      fillSelect($('.item-cat', node), C.CATEGORIES, it.category);
      fillSelect($('[data-k=makingType]', node), C.MAKING_TYPES, it.makingType);
      $$('[data-k]', node).forEach(function (input) {
        var k = input.dataset.k;
        if (input.tagName === 'SELECT') { input.value = it[k]; return; }
        if (input.type === 'number') {
          input.value = k === 'qty' ? (it.qty || 1) : numOrEmpty(it[k]);
        } else {
          input.value = it[k] == null ? '' : it[k];
        }
      });
      wrap.appendChild(node);
    });
  }

  function itemFromRow(row) {
    var id = row.dataset.id;
    return state.bill.items.find(function (it) { return it.id === id; });
  }

  function onItemInput(e) {
    var input = e.target;
    var k = input.dataset.k;
    if (!k) return;
    var row = input.closest('.item');
    var it = itemFromRow(row);
    if (!it) return;

    if (k === 'purity') {
      var oldRate = rateFor(it.purity);
      it.purity = input.value.trim();
      if (!U.num(it.rate) || U.num(it.rate) === oldRate) {
        var nr = rateFor(it.purity);
        if (nr) { it.rate = nr; $('[data-k=rate]', row).value = nr; }
      }
    } else if (k === 'category') {
      it.category = input.value;
      var metal = METAL_FOR_CATEGORY[it.category];
      var preset = C.PURITIES.find(function (p) { return p.label.toLowerCase() === String(it.purity).toLowerCase(); });
      if (!it.purity || (preset && metal && preset.metal !== metal)) {
        var prevRate = rateFor(it.purity);
        it.purity = DEFAULT_PURITY[it.category] || '';
        $('[data-k=purity]', row).value = it.purity;
        if (!U.num(it.rate) || U.num(it.rate) === prevRate) {
          it.rate = rateFor(it.purity);
          $('[data-k=rate]', row).value = numOrEmpty(it.rate);
        }
      }
    } else if (k === 'taxRate') {
      it.taxRate = input.value === '' ? null : U.num(input.value);
    } else if (k === 'makingType') {
      it.makingType = input.value;
    } else if (input.type === 'number') {
      it[k] = k === 'qty' ? Math.max(1, Math.floor(U.num(input.value)) || 1) : U.num(input.value);
    } else {
      it[k] = input.value;
    }
    recalc();
  }

  function onItemClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var row = btn.closest('.item');
    var items = state.bill.items;
    var idx = items.findIndex(function (it) { return it.id === row.dataset.id; });
    if (idx < 0) return;
    var act = btn.dataset.act;
    if (act === 'del') {
      items.splice(idx, 1);
      if (!items.length) items.push(defaultItem());
    } else if (act === 'dup') {
      var copy = U.clone(items[idx]); copy.id = U.uid();
      items.splice(idx + 1, 0, copy);
    } else if (act === 'up' && idx > 0) {
      items.splice(idx - 1, 0, items.splice(idx, 1)[0]);
    } else if (act === 'down' && idx < items.length - 1) {
      items.splice(idx + 1, 0, items.splice(idx, 1)[0]);
    } else {
      return;
    }
    renderItems();
    recalc();
  }

  function addItem(over, focusKey) {
    var it = defaultItem(over);
    state.bill.items.push(it);
    renderItems();
    recalc();
    var row = $('#items .item[data-id="' + it.id + '"]');
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      var f = $('[data-k=' + (focusKey || 'description') + ']', row);
      if (f) f.focus();
    }
  }

  function calcLine(it, l, bill) {
    var cur = bill.currency;
    var parts = [];
    if (l.grossWeight || l.rate) {
      var w = 'Net ' + U.formatWeight(l.netWeight) + ' g';
      if (l.wastageWeight) w += ' + VA ' + U.formatWeight(l.wastageWeight) + ' g = ' + U.formatWeight(l.chargeableWeight) + ' g';
      parts.push(w + ' × ' + U.formatMoney(l.rate, cur) + ' = <b>' + U.formatMoney(l.metalValue, cur) + '</b>');
    }
    if (l.making) parts.push('Making <b>' + U.formatMoney(l.making, cur) + '</b>');
    if (l.stoneCharges) parts.push('Stones ' + U.formatMoney(l.stoneCharges, cur));
    if (l.otherCharges) parts.push('Other ' + U.formatMoney(l.otherCharges, cur));
    if (l.discount) parts.push('Discount −' + U.formatMoney(l.discount, cur));
    if (l.taxRate && bill.tax.type !== 'none') parts.push('Tax ' + U.formatPct(l.taxRate) + (bill.tax.inclusive ? ' (incl.)' : '') + ' = ' + U.formatMoney(l.tax, cur));
    return parts.join(' &nbsp;·&nbsp; ') || 'Enter weight and rate, or a making/stone charge.';
  }

  /* ================================================================== */
  /* Editor: old items / charges / payments                              */
  /* ================================================================== */

  function renderOld() {
    var wrap = $('#oldItems');
    wrap.innerHTML = state.bill.oldItems.map(function (o) {
      return '<div class="row-line row-line--old" data-id="' + esc(o.id) + '">' +
        '<label class="field"><span>Description</span><input data-k="description" value="' + esc(o.description) + '" placeholder="Old bangle, chain…"></label>' +
        '<label class="field"><span>Metal</span><select data-k="category">' + ['Gold', 'Silver', 'Platinum', 'Other'].map(function (c) { return '<option' + (c === o.category ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Gross (g)</span><input type="number" min="0" step="0.001" data-k="grossWeight" value="' + esc(numOrEmpty(o.grossWeight)) + '" placeholder="0.000"></label>' +
        '<label class="field"><span>Less (g)</span><input type="number" min="0" step="0.001" data-k="lessWeight" value="' + esc(numOrEmpty(o.lessWeight)) + '" placeholder="0.000"></label>' +
        '<label class="field"><span>Purity %</span><input type="number" min="0" max="100" step="0.1" data-k="purityPct" value="' + esc(numOrEmpty(o.purityPct)) + '" placeholder="100"></label>' +
        '<label class="field"><span>Rate /g <em title="Rate for pure (100%) metal">?</em></span><input type="number" min="0" step="0.01" data-k="rate" value="' + esc(numOrEmpty(o.rate)) + '" placeholder="0.00"></label>' +
        '<label class="field"><span>Deduction %</span><input type="number" min="0" max="100" step="0.1" data-k="deductionPct" value="' + esc(numOrEmpty(o.deductionPct)) + '" placeholder="0"></label>' +
        '<label class="field"><span>Value</span><output class="old-amt">0</output></label>' +
        '<button type="button" class="icon-btn icon-btn--danger" data-act="del" title="Remove">' + ICON.del + '</button>' +
        '</div>';
    }).join('');
  }

  function defaultOldItem() {
    var pureRate = rateFor('24K');
    return C.newOldItem({ category: 'Gold', purityPct: 91.6, rate: pureRate, deductionPct: 0 });
  }

  function renderCharges() {
    var wrap = $('#charges');
    wrap.innerHTML = state.bill.charges.map(function (c) {
      return '<div class="row-line row-line--charge" data-id="' + esc(c.id) + '">' +
        '<label class="field"><span>Particulars</span><input data-k="label" value="' + esc(c.label) + '" placeholder="Hallmarking charges"></label>' +
        '<label class="field"><span>Amount</span><input type="number" min="0" step="0.01" data-k="amount" value="' + esc(numOrEmpty(c.amount)) + '" placeholder="0"></label>' +
        '<label class="field"><span>Tax %</span><input type="number" min="0" step="0.01" data-k="taxRate" value="' + esc(numOrEmpty(c.taxRate)) + '" placeholder="0"></label>' +
        '<button type="button" class="icon-btn icon-btn--danger" data-act="del" title="Remove">' + ICON.del + '</button>' +
        '</div>';
    }).join('');
  }

  function renderPayments() {
    var wrap = $('#payments');
    wrap.innerHTML = state.bill.payments.map(function (p) {
      return '<div class="row-line row-line--pay" data-id="' + esc(p.id) + '">' +
        '<label class="field"><span>Mode</span><select data-k="mode">' + PAY_MODES.map(function (m) { return '<option' + (m === p.mode ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Amount</span><input type="number" min="0" step="0.01" data-k="amount" value="' + esc(numOrEmpty(p.amount)) + '" placeholder="0"></label>' +
        '<label class="field"><span>Reference</span><input data-k="ref" value="' + esc(p.ref) + '" placeholder="UPI txn id / cheque no."></label>' +
        '<label class="field"><span>Date</span><input type="date" data-k="date" value="' + esc(p.date) + '"></label>' +
        '<button type="button" class="icon-btn icon-btn--danger" data-act="del" title="Remove">' + ICON.del + '</button>' +
        '</div>';
    }).join('');
    if (!state.bill.payments.length) wrap.innerHTML = '<div class="muted small" style="margin-bottom:8px">No payment recorded — the full amount will show as balance due.</div>';
  }

  // Generic handler for the simple row lists (old items, charges, payments)
  function bindRowList(containerSel, listKey, renderFn) {
    var el = $(containerSel);
    el.addEventListener('input', function (e) {
      var input = e.target, k = input.dataset.k;
      if (!k) return;
      var row = input.closest('.row-line');
      var obj = state.bill[listKey].find(function (o) { return o.id === row.dataset.id; });
      if (!obj) return;
      obj[k] = input.type === 'number' ? U.num(input.value) : input.value;
      recalc();
    });
    el.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act=del]');
      if (!btn) return;
      var row = btn.closest('.row-line');
      state.bill[listKey] = state.bill[listKey].filter(function (o) { return o.id !== row.dataset.id; });
      renderFn();
      recalc();
    });
  }

  /* ================================================================== */
  /* Editor: recalc + summary                                            */
  /* ================================================================== */

  var scheduleDraftSave = U.debounce(function () {
    if (state.bill) S.saveDraft(state.bill);
  }, 400);

  function recalc() {
    var bill = state.bill;
    var r = state.computed = C.computeBill(bill);
    var cur = bill.currency;

    $$('#items .item').forEach(function (row, i) {
      var l = r.lines[i], it = bill.items[i];
      if (!l) return;
      $('.item-net', row).value = U.formatWeight(l.netWeight);
      $('.item-amount-val', row).textContent = U.formatMoney(l.amount, cur);
      $('.item-calc', row).innerHTML = calcLine(it, l, bill);
      row.classList.toggle('is-invalid', U.num(it.lessWeight) > U.num(it.grossWeight));
    });
    $$('#oldItems .row-line').forEach(function (row, i) {
      var o = r.oldLines[i];
      if (o) $('.old-amt', row).value = U.formatMoney(o.amount, cur) + '  (fine ' + U.formatWeight(o.fineWeight) + ' g)';
    });
    $('#oldSummary').textContent = r.oldLines.length ? '· ' + r.oldLines.length + ' item' + (r.oldLines.length > 1 ? 's' : '') + ', ' + U.formatMoney(r.oldTotal, cur) : '';

    renderSummary(r);

    var errs = C.validate(bill);
    $('#validation').innerHTML = errs.length ? '<ul>' + errs.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' : '';

    scheduleDraftSave();
    updateTopbar();
  }

  function renderSummary(r) {
    var bill = state.bill, cur = bill.currency;
    var rows = [];
    function row(label, val, cls) { rows.push('<div class="summary-row ' + (cls || '') + '"><span>' + label + '</span><span>' + val + '</span></div>'); }
    var m = function (n) { return U.formatMoney(n, cur); };

    row('Subtotal <span class="muted">(' + r.totalPieces + ' pc · ' + U.formatWeight(r.totalNet) + ' g net)</span>', m(r.subtotal));
    if (r.discount) row('Discount', '− ' + m(r.discount));
    if (r.charges.length) row('Additional charges', m(r.charges.reduce(function (s, c) { return s + c.taxable; }, 0)));
    if (bill.tax.type !== 'none') {
      row('Taxable value', m(r.taxable), 'is-muted');
      r.taxSplit.forEach(function (t) { row(esc(t.label), m(t.amount), 'is-muted'); });
    }
    row('Grand total', m(r.grandTotal), 'is-strong');
    if (r.oldTotal) row('Old metal exchange', '− ' + m(r.oldTotal));
    if (Math.abs(r.roundOff) >= 0.005) row('Round off', (r.roundOff > 0 ? '+ ' : '− ') + m(Math.abs(r.roundOff)), 'is-muted');
    row(r.netPayable < 0 ? 'Refund to customer' : 'Net payable', m(Math.abs(r.netPayable)), 'is-grand' + (r.netPayable < 0 ? ' is-refund' : ''));
    if (r.payments.length) {
      row('Paid', '− ' + m(r.paid));
      row(r.balance < -0.005 ? 'Change / credit' : 'Balance due', m(Math.abs(r.balance)), r.balance > 0.005 ? 'is-due' : 'is-strong');
    }
    $('#summary').innerHTML = rows.join('') + '<div class="summary-words">' + esc(U.amountInWords(Math.abs(r.netPayable), cur)) + '</div>';

    var mbLabel = r.payments.length ? (r.balance < -0.005 ? 'Change / credit' : 'Balance due') : (r.netPayable < 0 ? 'Refund to customer' : 'Net payable');
    var mbVal = r.payments.length ? Math.abs(r.balance) : Math.abs(r.netPayable);
    $('#mbLabel').textContent = mbLabel;
    $('#mbValue').textContent = m(mbVal);
  }

  /* ================================================================== */
  /* Save                                                                */
  /* ================================================================== */

  function saveBill(silent) {
    var bill = state.bill;
    var errs = C.validate(bill);
    if (errs.length) { toast(errs[0], true); return false; }
    var no = String(bill.invoiceNo || '').trim();
    if (!no) {
      no = S.takeNumber(bill.docType);
      bill.invoiceNo = no;
      $('#f-invoiceNo').value = no;
      state.settings = S.getSettings();
    } else if (S.invoiceNoExists(no, bill.id)) {
      toast('Invoice number ' + no + ' is already used by another bill.', true);
      return false;
    }
    if (!bill.createdAt) bill.createdAt = new Date().toISOString();
    S.saveBill(bill);
    S.saveDraft(bill);
    state.lastSavedJson = JSON.stringify(bill);
    updateBillCount();
    refreshCustomerList();
    updateInvoicePlaceholder();
    updateTopbar();
    if (!silent) toast('Saved ' + no);
    return true;
  }

  function updateBillCount() {
    $('#billCount').textContent = S.getBills().length;
  }

  /* ================================================================== */
  /* Customers (from previous bills)                                     */
  /* ================================================================== */

  function refreshCustomerList() {
    var map = {};
    S.getBills().forEach(function (b) {
      var c = b.customer || {};
      if (!c.name && !c.phone) return;
      var key = (c.name || '') + (c.phone ? ' · ' + c.phone : '');
      if (!map[key]) map[key] = c;
    });
    state.customers = map;
    $('#custList').innerHTML = Object.keys(map).map(function (k) { return '<option value="' + esc(k) + '">'; }).join('');
  }

  /* ================================================================== */
  /* Preview / print / share                                             */
  /* ================================================================== */

  function copyLabels(n) {
    return ['Original', 'Duplicate', 'Office copy'].slice(0, Math.max(1, Math.min(3, n)));
  }

  function invoiceArticles() {
    var labels = copyLabels(state.preview.copies);
    return labels.map(function (label) {
      return INV.render(state.bill, state.settings, { template: state.preview.template, copy: labels.length > 1 ? label : '', layout: state.preview.paper === 'thermal' ? 'stacked' : state.preview.paper === 'a5' ? 'narrow' : 'full' });
    });
  }

  function renderPreview() {
    var stage = $('#previewStage');
    stage.innerHTML = '';
    invoiceArticles().forEach(function (html) {
      var sheet = document.createElement('div');
      sheet.className = 'sheet sheet--' + state.preview.paper;
      sheet.innerHTML = html;
      stage.appendChild(sheet);
    });
    fitPreview();
  }

  function fitPreview() {
    var stage = $('#previewStage');
    var avail = stage.clientWidth;
    $$('.sheet', stage).forEach(function (sheet) {
      sheet.style.zoom = '';
      var w = sheet.offsetWidth;
      if (w > avail && avail > 0) sheet.style.zoom = String(Math.max(0.35, avail / w));
    });
  }

  function setPageStyle(paper) {
    var p = PAPER[paper] || PAPER.a4;
    var el = $('#pageStyle');
    if (!el) { el = document.createElement('style'); el.id = 'pageStyle'; document.head.appendChild(el); }
    el.textContent = '@page { size: ' + p.css + '; margin: ' + p.margin + '; }';
  }

  function doPrint() {
    var root = $('#printRoot');
    root.className = 'print-root paper-' + state.preview.paper;
    root.innerHTML = invoiceArticles().join('');
    setPageStyle(state.preview.paper);
    document.body.classList.add('is-printing');
    // Give the browser a tick to apply the class before opening the dialog.
    setTimeout(function () { window.print(); }, 50);
  }

  window.addEventListener('afterprint', function () {
    document.body.classList.remove('is-printing');
    $('#printRoot').innerHTML = '';
  });

  function getInvoiceCss() {
    try {
      var link = $$('link[rel=stylesheet]').find(function (l) { return /invoice\.css/.test(l.href); });
      if (link && link.sheet) {
        var rules = link.sheet.cssRules; // throws on cross-origin / file://
        return Promise.resolve(Array.prototype.map.call(rules, function (r) { return r.cssText; }).join('\n'));
      }
    } catch (e) { /* fall through */ }
    return fetch('css/invoice.css').then(function (r) { return r.text(); }).catch(function () { return ''; });
  }

  function downloadHtml() {
    var bill = state.bill;
    var p = PAPER[state.preview.paper] || PAPER.a4;
    getInvoiceCss().then(function (css) {
      var doc = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>' + esc((bill.docType === 'estimate' ? 'Estimate ' : 'Invoice ') + (bill.invoiceNo || '') + ' — ' + state.settings.shopName) + '</title>' +
        '<style>' + css + '\nbody{margin:0;background:#f3f3f3;font-family:Inter,system-ui,sans-serif}' +
        '.sheet{background:#fff;margin:16px auto;padding:' + (state.preview.paper === 'thermal' ? '4mm 3mm' : '12mm') + ';width:' + (state.preview.paper === 'thermal' ? '80mm' : state.preview.paper === 'a5' ? '148mm' : state.preview.paper === 'letter' ? '216mm' : '210mm') + ';max-width:100%;box-sizing:border-box;box-shadow:0 2px 12px rgba(0,0,0,.12)}' +
        '@media print{body{background:#fff}.sheet{margin:0;box-shadow:none;width:auto;padding:0;page-break-after:always}.sheet:last-child{page-break-after:auto}}' +
        '@page{size:' + p.css + ';margin:' + p.margin + '}</style></head>' +
        '<body class="paper-' + esc(state.preview.paper) + '">' +
        invoiceArticles().map(function (h) { return '<div class="sheet">' + h + '</div>'; }).join('') +
        '</body></html>';
      download(safeFilename((bill.invoiceNo || 'invoice')) + '.html', doc, 'text/html;charset=utf-8');
      toast('Downloaded HTML — open it in any browser and print to PDF');
    });
  }

  function shareText() {
    var text = INV.toText(state.bill, state.settings);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Bill summary copied to clipboard'); }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Bill summary copied'); } catch (e) { toast('Copy failed', true); }
    ta.remove();
  }

  function shareWhatsApp() {
    var text = INV.toText(state.bill, state.settings);
    var phone = String((state.bill.customer && state.bill.customer.phone) || '').replace(/\D/g, '');
    if (phone && phone.length === 10 && state.bill.currency === 'INR') phone = '91' + phone;
    var url = 'https://wa.me/' + phone + '?text=' + encodeURIComponent(text);
    window.open(url, '_blank', 'noopener');
  }

  /* ================================================================== */
  /* History                                                             */
  /* ================================================================== */

  function renderHistory() {
    var q = $('#histSearch').value.trim().toLowerCase();
    var f = $('#histFilter').value;
    var all = S.getBills().map(function (b) { return { bill: b, r: C.computeBill(b) }; });

    var rows = all.filter(function (x) {
      var b = x.bill, c = b.customer || {};
      if (q) {
        var hay = [b.invoiceNo, c.name, c.phone, c.email].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (f === 'invoice' && b.docType === 'estimate') return false;
      if (f === 'estimate' && b.docType !== 'estimate') return false;
      if (f === 'due' && !(b.docType !== 'estimate' && x.r.balance > 0.005)) return false;
      if (f === 'paid' && !(b.docType !== 'estimate' && x.r.balance <= 0.005)) return false;
      return true;
    });

    // Stats (invoices only)
    var invoices = all.filter(function (x) { return x.bill.docType !== 'estimate'; });
    var month = U.todayISO().slice(0, 7);
    var stats = {
      count: invoices.length,
      sales: invoices.reduce(function (s, x) { return s + x.r.netPayable; }, 0),
      month: invoices.filter(function (x) { return String(x.bill.date).slice(0, 7) === month; }).reduce(function (s, x) { return s + x.r.netPayable; }, 0),
      due: invoices.reduce(function (s, x) { return s + Math.max(0, x.r.balance); }, 0)
    };
    var cur = state.settings.currency;
    $('#histStats').innerHTML =
      '<div class="stat"><b>' + stats.count + '</b><span>Invoices</span></div>' +
      '<div class="stat"><b>' + U.formatMoney(stats.sales, cur) + '</b><span>Total billed</span></div>' +
      '<div class="stat"><b>' + U.formatMoney(stats.month, cur) + '</b><span>This month</span></div>' +
      '<div class="stat"><b style="color:' + (stats.due > 0 ? 'var(--red)' : 'inherit') + '">' + U.formatMoney(stats.due, cur) + '</b><span>Outstanding</span></div>';

    var tbody = $('#histTable tbody');
    tbody.innerHTML = rows.map(function (x) {
      var b = x.bill, r = x.r, c = b.customer || {};
      var pill = b.docType === 'estimate' ? '<span class="pill pill--est">EST</span>' :
        r.balance > 0.005 ? '<span class="pill pill--due">DUE</span>' : '<span class="pill pill--paid">PAID</span>';
      return '<tr data-id="' + esc(b.id) + '">' +
        '<td><b>' + esc(b.invoiceNo || '—') + '</b> ' + pill + '</td>' +
        '<td>' + esc(U.formatDate(b.date)) + '</td>' +
        '<td>' + esc(c.name || 'Walk-in') + (c.phone ? '<div class="muted small">' + esc(c.phone) + '</div>' : '') + '</td>' +
        '<td class="r">' + U.formatWeight(r.totalNet) + '</td>' +
        '<td class="r">' + U.formatMoney(r.netPayable, b.currency) + '</td>' +
        '<td class="r">' + (b.docType === 'estimate' ? '—' : U.formatMoney(r.balance, b.currency)) + '</td>' +
        '<td><div class="actions">' +
          '<button class="btn btn-ghost btn-sm" data-act="open">Open</button>' +
          '<button class="icon-btn" data-act="print" title="Preview / print">' + ICON.print + '</button>' +
          '<button class="icon-btn" data-act="dup" title="Duplicate">' + ICON.dup + '</button>' +
          '<button class="icon-btn icon-btn--danger" data-act="del" title="Delete">' + ICON.del + '</button>' +
        '</div></td></tr>';
    }).join('');
    $('#histEmpty').hidden = rows.length > 0;
    $('#histTable').hidden = rows.length === 0;
  }

  function onHistoryClick(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var tr = btn.closest('tr');
    var bill = S.getBill(tr.dataset.id);
    if (!bill) return;
    var act = btn.dataset.act;
    if (act === 'del') {
      if (!confirm('Delete ' + (bill.invoiceNo || 'this bill') + '? This cannot be undone.')) return;
      S.deleteBill(bill.id);
      if (state.bill && state.bill.id === bill.id) { S.clearDraft(); loadBill(newBill(), ''); }
      updateBillCount();
      renderHistory();
      toast('Deleted ' + (bill.invoiceNo || 'bill'));
      return;
    }
    if (state.bill && isDirty() && hasContent(state.bill) && state.bill.id !== bill.id) {
      if (!confirm('You have unsaved changes in the current bill. Discard them?')) return;
    }
    if (act === 'open') { loadBill(U.clone(bill), JSON.stringify(bill)); showView('editor'); }
    if (act === 'print') { loadBill(U.clone(bill), JSON.stringify(bill)); showView('preview'); }
    if (act === 'dup') { loadBill(U.clone(bill), JSON.stringify(bill)); duplicateBill(); }
  }

  function exportCsv() {
    var bills = S.getBills();
    if (!bills.length) { toast('No bills to export', true); return; }
    var head = ['Invoice No', 'Type', 'Date', 'Customer', 'Phone', 'Customer GSTIN', 'Items', 'Gross Wt (g)', 'Net Wt (g)', 'Subtotal', 'Discount', 'Taxable', 'Tax', 'Charges', 'Grand Total', 'Old Exchange', 'Round Off', 'Net Payable', 'Paid', 'Balance', 'Currency'];
    var q = function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [head.join(',')];
    bills.forEach(function (b) {
      var r = C.computeBill(b), c = b.customer || {};
      lines.push([b.invoiceNo, b.docType === 'estimate' ? 'Estimate' : 'Invoice', b.date, c.name, c.phone, c.gstin,
        (b.items || []).map(function (it) { return it.description; }).join('; '),
        r.totalGross.toFixed(3), r.totalNet.toFixed(3), U.round2(r.subtotal), U.round2(r.discount), U.round2(r.taxable), U.round2(r.tax),
        U.round2(r.chargesTotal), U.round2(r.grandTotal), U.round2(r.oldTotal), U.round2(r.roundOff), U.round2(r.netPayable), U.round2(r.paid), U.round2(r.balance), b.currency
      ].map(q).join(','));
    });
    download('jewellery-bills-' + U.todayISO() + '.csv', '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
  }

  /* ================================================================== */
  /* Rates                                                               */
  /* ================================================================== */

  function renderSidebarRates() {
    var rates = state.settings.rates || {};
    var keys = Object.keys(rates).slice(0, 6);
    $('#sidebarRates').innerHTML = '<h4>Rates / gram</h4>' + (keys.length ? keys.map(function (k) {
      return '<div class="rate-row"><span>' + esc(k) + '</span><b>' + U.formatMoney(rates[k], state.settings.currency) + '</b></div>';
    }).join('') : '<div class="muted small">No rates set</div>');
    fillSelect($('#qc-purity'), keys.length ? Object.keys(rates) : ['22K']);
    $('#purityList').innerHTML = C.PURITIES.map(function (p) { return p.label; }).concat(Object.keys(rates)).filter(function (v, i, a) { return a.indexOf(v) === i; })
      .map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
  }

  function renderRates() {
    var rates = state.settings.rates || {};
    var grid = $('#ratesGrid');
    grid.innerHTML = Object.keys(rates).map(function (k) {
      var pct = C.purityPctFor(k);
      return '<div class="rate-card" data-label="' + esc(k) + '">' +
        '<div class="rate-label"><span>' + esc(k) + ' <small>' + (pct < 100 ? U.formatPct(pct) : '') + '</small></span><button type="button" class="icon-btn icon-btn--danger" data-act="del" title="Remove">' + ICON.del + '</button></div>' +
        '<input type="number" min="0" step="0.01" value="' + esc(rates[k]) + '" data-rate="' + esc(k) + '">' +
        '</div>';
    }).join('') +
      '<div class="rate-card rate-card--new"><div class="rate-label">Add purity</div>' +
      '<input id="newRateLabel" list="purityList" placeholder="e.g. 20K or 916">' +
      '<input id="newRateValue" type="number" min="0" step="0.01" placeholder="Rate / g">' +
      '<button type="button" class="btn btn-secondary btn-sm" id="addRateBtn">+ Add</button></div>';
    $('#ratesSaved').textContent = '';
  }

  function readRatesGrid() {
    var out = {};
    $$('#ratesGrid input[data-rate]').forEach(function (inp) { out[inp.dataset.rate] = U.num(inp.value); });
    return out;
  }

  function saveRates() {
    state.settings.rates = readRatesGrid();
    S.saveSettings(state.settings);
    renderSidebarRates();
    $('#ratesSaved').textContent = 'Saved at ' + new Date().toLocaleTimeString();
    toast('Rates saved');
  }

  function deriveRates() {
    var rates = readRatesGrid();
    var r24 = U.num(rates['24K']);
    if (!r24) { toast('Enter the 24K rate first', true); return; }
    Object.keys(rates).forEach(function (k) {
      var m = /^(\d{1,2})K$/i.exec(k.trim());
      if (m && Number(m[1]) < 24) {
        var v = Math.round(r24 * Number(m[1]) / 24);
        $('#ratesGrid input[data-rate="' + k + '"]').value = v;
      }
    });
    toast('Derived karat rates from 24K — click Save rates to keep them');
  }

  function quickCalc() {
    var purity = $('#qc-purity').value;
    var w = U.num($('#qc-weight').value), mk = U.num($('#qc-making').value), wa = U.num($('#qc-wastage').value);
    var out = $('#qc-result');
    if (!w) { out.innerHTML = ''; return; }
    var rate = rateFor(purity);
    var b = newBill();
    b.items = [C.newItem({ description: 'x', purity: purity, grossWeight: w, rate: rate, makingType: 'per_gram', makingValue: mk, wastagePct: wa })];
    var r = C.computeBill(b);
    var l = r.lines[0];
    var cur = state.settings.currency;
    out.innerHTML = 'Metal value ' + U.formatWeight(l.chargeableWeight) + ' g × ' + U.formatMoney(rate, cur) + ' = <b>' + U.formatMoney(l.metalValue, cur) + '</b>' +
      (l.making ? ' &nbsp;+ making ' + U.formatMoney(l.making, cur) : '') +
      (r.tax ? ' &nbsp;+ tax ' + U.formatMoney(r.tax, cur) : '') +
      ' &nbsp;= &nbsp;<b>' + U.formatMoney(r.netPayable, cur) + '</b>';
  }

  /* ================================================================== */
  /* Settings                                                            */
  /* ================================================================== */

  function getPath(o, path) { return path.split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o); }
  function setPath(o, path, v) {
    var parts = path.split('.'), last = parts.pop();
    var t = parts.reduce(function (a, k) { if (!a[k] || typeof a[k] !== 'object') a[k] = {}; return a[k]; }, o);
    t[last] = v;
  }

  function renderSettingsForm() {
    var f = $('#settingsForm'), s = state.settings;
    $$('[name]', f).forEach(function (el) {
      var v = getPath(s, el.name);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });
    setImgPreview('#logoPreview', s.logo);
    setImgPreview('#signPreview', s.signature);
    $('#settingsSaved').textContent = '';
  }

  function setImgPreview(sel, src) {
    var img = $(sel);
    img.hidden = !src;
    img.src = src || '';
  }

  function saveSettingsForm(e) {
    if (e) e.preventDefault();
    var f = $('#settingsForm');
    var s = U.clone(state.settings);
    $$('[name]', f).forEach(function (el) {
      var v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'number') v = U.num(el.value);
      else v = el.value.trim();
      if (el.name === 'gstin' || el.name === 'pan') v = v.toUpperCase();
      setPath(s, el.name, v);
    });
    s.invoiceNext = Math.max(1, Math.floor(s.invoiceNext) || 1);
    s.invoicePad = U.clamp(Math.floor(s.invoicePad) || 4, 1, 8);
    S.saveSettings(s);
    state.settings = S.getSettings();
    renderSidebarRates();
    if (state.bill) { updateInvoicePlaceholder(); recalc(); }
    $('#settingsSaved').textContent = 'Saved';
    toast('Settings saved');
  }

  function readImageFile(file, maxSize) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function exportBackup() {
    download('jewellery-bills-backup-' + U.todayISO() + '.json', JSON.stringify(S.exportAll(), null, 2), 'application/json');
    toast('Backup downloaded');
  }

  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var replace = confirm('Replace ALL existing bills with the backup?\n\nOK = replace, Cancel = merge (keep existing and add missing).');
        var res = S.importAll(data, replace ? 'replace' : 'merge');
        state.settings = S.getSettings();
        renderSidebarRates();
        updateBillCount();
        refreshCustomerList();
        renderSettingsForm();
        toast('Restored ' + res.bills + ' bill(s) from backup');
      } catch (err) {
        toast(err.message || 'Could not read backup', true);
      }
    };
    reader.readAsText(file);
  }

  /* ================================================================== */
  /* Bind events                                                         */
  /* ================================================================== */

  function bind() {
    // Navigation
    $$('.nav-btn').forEach(function (b) { b.addEventListener('click', function () { showView(b.dataset.view); }); });
    $('#menuBtn').addEventListener('click', function () { $('#sidebar').classList.toggle('is-open'); });
    document.addEventListener('click', function (e) {
      var sb = $('#sidebar');
      if (sb.classList.contains('is-open') && !sb.contains(e.target) && !$('#menuBtn').contains(e.target)) sb.classList.remove('is-open');
    });
    $('#backupLink').addEventListener('click', function (e) { e.preventDefault(); exportBackup(); });

    // Header fields
    $('#f-invoiceNo').addEventListener('input', function () { state.bill.invoiceNo = this.value.trim(); recalc(); });
    $('#f-date').addEventListener('input', function () { state.bill.date = this.value; recalc(); });
    $('#f-dueDate').addEventListener('input', function () { state.bill.dueDate = this.value; recalc(); });
    $('#f-currency').addEventListener('input', function () { state.bill.currency = this.value; recalc(); });
    $$('.seg-btn[data-doctype]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.bill.docType = btn.dataset.doctype;
        $$('.seg-btn[data-doctype]').forEach(function (b) { b.classList.toggle('is-active', b === btn); });
        updateInvoicePlaceholder();
        recalc();
      });
    });

    // Customer
    ['name', 'phone', 'email', 'address', 'gstin', 'pan'].forEach(function (k) {
      $('#c-' + k).addEventListener('input', function () {
        state.bill.customer[k] = (k === 'gstin' || k === 'pan') ? this.value.toUpperCase() : this.value;
        recalc();
      });
    });
    $('#custSearch').addEventListener('input', function () {
      var c = state.customers[this.value];
      if (!c) return;
      ['name', 'phone', 'email', 'address', 'gstin', 'pan'].forEach(function (k) {
        state.bill.customer[k] = c[k] || '';
        $('#c-' + k).value = c[k] || '';
      });
      this.value = '';
      recalc();
      toast('Customer details filled');
    });

    // Items
    $('#items').addEventListener('input', onItemInput);
    $('#items').addEventListener('click', onItemClick);
    $('#addItemBtn').addEventListener('click', function () { addItem(null, 'description'); });
    $('#quickAdd').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-quick]');
      if (!chip) return;
      var p = chip.dataset.quick.split('|');
      // Reuse the first empty row instead of adding a new one
      var empty = state.bill.items.length === 1 && !state.bill.items[0].description && !U.num(state.bill.items[0].grossWeight);
      if (empty) state.bill.items = [];
      addItem({ description: p[0], category: p[1], purity: p[2] }, 'grossWeight');
    });
    $('#applyRatesBtn').addEventListener('click', function () {
      var n = 0;
      state.bill.items.forEach(function (it) { var r = rateFor(it.purity); if (r) { it.rate = r; n++; } });
      renderItems(); recalc();
      toast(n ? 'Applied today\'s rates to ' + n + ' item(s)' : 'No matching purity rates found — set them under Today\'s rates', !n);
    });

    // Old items / charges / payments
    bindRowList('#oldItems', 'oldItems', renderOld);
    bindRowList('#charges', 'charges', renderCharges);
    bindRowList('#payments', 'payments', renderPayments);
    $('#oldItems').addEventListener('input', function (e) {
      // Metal change => sensible purity/rate defaults
      if (e.target.dataset.k !== 'category') return;
      var row = e.target.closest('.row-line');
      var o = state.bill.oldItems.find(function (x) { return x.id === row.dataset.id; });
      if (!o) return;
      var map = { Gold: [91.6, rateFor('24K')], Silver: [92.5, rateFor('999 Silver')], Platinum: [95, rateFor('950 Platinum')], Other: [100, 0] };
      var d = map[o.category] || map.Other;
      o.purityPct = d[0]; o.rate = d[1];
      $('[data-k=purityPct]', row).value = d[0];
      $('[data-k=rate]', row).value = numOrEmpty(d[1]);
      recalc();
    });
    $('#addOldBtn').addEventListener('click', function () {
      state.bill.oldItems.push(defaultOldItem());
      renderOld(); recalc();
      var rows = $$('#oldItems .row-line'); var last = rows[rows.length - 1];
      if (last) $('[data-k=description]', last).focus();
    });
    $('#oldCard .card-toggle').addEventListener('click', function () {
      var open = $('#oldCard').classList.toggle('is-open');
      this.setAttribute('aria-expanded', String(open));
      if (open && !state.bill.oldItems.length) { state.bill.oldItems.push(defaultOldItem()); renderOld(); recalc(); }
    });
    $('#addChargeBtn').addEventListener('click', function () {
      state.bill.charges.push(C.newCharge({ taxRate: state.bill.tax.type === 'none' ? 0 : 18 }));
      renderCharges(); recalc();
      var rows = $$('#charges .row-line'); var last = rows[rows.length - 1];
      if (last) $('[data-k=label]', last).focus();
    });
    $('#addPaymentBtn').addEventListener('click', function () {
      var r = state.computed;
      state.bill.payments.push(C.newPayment({ amount: r && r.balance > 0 ? U.round2(r.balance) : 0 }));
      renderPayments(); recalc();
      var rows = $$('#payments .row-line'); var last = rows[rows.length - 1];
      if (last) $('[data-k=amount]', last).select();
    });
    $('#payFullBtn').addEventListener('click', function () {
      var r = state.computed;
      if (!r || r.balance <= 0.005) { toast('Nothing due on this bill'); return; }
      state.bill.payments.push(C.newPayment({ amount: U.round2(r.balance) }));
      renderPayments(); recalc();
    });

    // Discount / tax
    $('#f-discountValue').addEventListener('input', function () { state.bill.discountValue = U.num(this.value); recalc(); });
    $('#f-discountType').addEventListener('input', function () { state.bill.discountType = this.value; recalc(); });
    $('#f-taxType').addEventListener('input', function () { state.bill.tax.type = this.value; recalc(); });
    $('#f-taxRate').addEventListener('input', function () { state.bill.tax.rate = U.num(this.value); recalc(); });
    $('#f-taxInclusive').addEventListener('change', function () { state.bill.tax.inclusive = this.checked; recalc(); });
    $('#f-roundOff').addEventListener('change', function () { state.bill.roundOff = this.checked; recalc(); });
    $('#f-notes').addEventListener('input', function () { state.bill.notes = this.value; recalc(); });

    // Summary actions
    $('#previewBtn').addEventListener('click', function () {
      var errs = C.validate(state.bill);
      if (errs.length) {
        toast(errs[0], true);
        return;
      }
      var hadNo = !!state.bill.invoiceNo;
      if (saveBill(true)) toast(hadNo ? 'Saved ' + state.bill.invoiceNo : 'Saved as ' + state.bill.invoiceNo);
      showView('preview');
    });
    $('#mbPreviewBtn').addEventListener('click', function () { $('#previewBtn').click(); });
    $('#saveBtn').addEventListener('click', function () { saveBill(); });
    $('#newBtn').addEventListener('click', function () { startNewBill(); });
    $('#duplicateBtn').addEventListener('click', duplicateBill);

    // Preview
    $('#backToEditBtn').addEventListener('click', function () { showView('editor'); });
    $('#p-template').addEventListener('change', function () { state.preview.template = this.value; renderPreview(); });
    $('#p-paper').addEventListener('change', function () { state.preview.paper = this.value; renderPreview(); });
    $('#p-copies').addEventListener('change', function () { state.preview.copies = Number(this.value); renderPreview(); });
    $('#printBtn').addEventListener('click', doPrint);
    $('#downloadHtmlBtn').addEventListener('click', downloadHtml);
    $('#shareTextBtn').addEventListener('click', shareText);
    $('#whatsappBtn').addEventListener('click', shareWhatsApp);
    window.addEventListener('resize', U.debounce(function () { if (state.view === 'preview') fitPreview(); }, 150));

    // History
    $('#histSearch').addEventListener('input', U.debounce(renderHistory, 120));
    $('#histFilter').addEventListener('change', renderHistory);
    $('#histTable').addEventListener('click', onHistoryClick);
    $('#exportCsvBtn').addEventListener('click', exportCsv);

    // Rates
    $('#saveRatesBtn').addEventListener('click', saveRates);
    $('#deriveRatesBtn').addEventListener('click', deriveRates);
    $('#ratesGrid').addEventListener('click', function (e) {
      if (e.target.closest('#addRateBtn')) {
        var label = $('#newRateLabel').value.trim(), val = U.num($('#newRateValue').value);
        if (!label) { toast('Enter a purity label', true); return; }
        state.settings.rates = readRatesGrid();
        state.settings.rates[label] = val;
        renderRates();
        return;
      }
      var del = e.target.closest('[data-act=del]');
      if (del) {
        var card = del.closest('.rate-card');
        state.settings.rates = readRatesGrid();
        delete state.settings.rates[card.dataset.label];
        renderRates();
      }
    });
    $('#ratesGrid').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.target.id === 'newRateLabel' || e.target.id === 'newRateValue')) { e.preventDefault(); $('#addRateBtn').click(); }
    });
    ['#qc-purity', '#qc-weight', '#qc-making', '#qc-wastage'].forEach(function (sel) { $(sel).addEventListener('input', quickCalc); });

    // Settings
    $('#settingsForm').addEventListener('submit', saveSettingsForm);
    $('#logoFile').addEventListener('change', function () {
      if (!this.files[0]) return;
      readImageFile(this.files[0], 480).then(function (url) { state.settings.logo = url; setImgPreview('#logoPreview', url); toast('Logo ready — click Save settings'); }, function () { toast('Could not read image', true); });
    });
    $('#signFile').addEventListener('change', function () {
      if (!this.files[0]) return;
      readImageFile(this.files[0], 480).then(function (url) { state.settings.signature = url; setImgPreview('#signPreview', url); toast('Signature ready — click Save settings'); }, function () { toast('Could not read image', true); });
    });
    $('#logoClear').addEventListener('click', function () { state.settings.logo = ''; setImgPreview('#logoPreview', ''); $('#logoFile').value = ''; });
    $('#signClear').addEventListener('click', function () { state.settings.signature = ''; setImgPreview('#signPreview', ''); $('#signFile').value = ''; });
    $('#exportBtn').addEventListener('click', exportBackup);
    $('#importFile').addEventListener('change', function () { if (this.files[0]) importBackup(this.files[0]); this.value = ''; });
    $('#resetBtn').addEventListener('click', function () {
      if (!confirm('Erase ALL bills and settings stored in this browser? Take a backup first if needed.')) return;
      S.resetAll();
      location.reload();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      var key = e.key.toLowerCase();
      if (key === 's') {
        if (state.view === 'editor' || state.view === 'preview') { e.preventDefault(); saveBill(); }
        else if (state.view === 'settings') { e.preventDefault(); saveSettingsForm(); }
        else if (state.view === 'rates') { e.preventDefault(); saveRates(); }
      } else if (key === 'p') {
        if (state.view === 'editor') { e.preventDefault(); $('#previewBtn').click(); }
        else if (state.view === 'preview') { e.preventDefault(); doPrint(); }
      }
    });
  }

  /* ================================================================== */
  /* Init                                                                */
  /* ================================================================== */

  var initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    var currencyOpts = Object.keys(U.CURRENCIES).map(function (k) { return { value: k, label: U.CURRENCIES[k].label }; });
    fillSelect($('#f-currency'), currencyOpts);
    fillSelect($('#s-currency'), currencyOpts);
    fillSelect($('#f-taxType'), C.TAX_TYPES);
    fillSelect($('#s-taxType'), C.TAX_TYPES);
    fillSelect($('#s-makingType'), C.MAKING_TYPES);

    renderSidebarRates();
    updateBillCount();
    refreshCustomerList();
    bind();

    var draft = S.getDraft();
    if (draft && draft.items) {
      var saved = S.getBill(draft.id);
      loadBill(draft, saved ? JSON.stringify(saved) : '');
    } else {
      loadBill(newBill(), '');
    }
    showView('editor');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
