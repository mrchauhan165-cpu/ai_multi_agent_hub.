/*
 * invoice.js — renders a computed bill into printable invoice HTML.
 * One DOM structure, several looks (classic / modern / compact) driven by CSS
 * classes; paper size is handled by a dynamic @page rule.
 */
(function (root) {
  'use strict';

  var U = root.JBUtils;
  var C = root.JBCalc;
  var esc = U.escapeHtml;

  function money(n, cur) { return '<span class="inv-num">' + U.formatMoney(n, cur) + '</span>'; }
  function wt(n) { return '<span class="inv-num">' + U.formatWeight(n) + '</span>'; }
  function moneyPlain(n, cur) { return U.formatMoney(n, cur); }
  function wtPlain(n) { return U.formatWeight(n); }

  function makingLabel(it, line, cur) {
    var v = U.num(it.makingValue);
    if (!v) return '—';
    switch (it.makingType) {
      case 'percent': return U.formatPct(v);
      case 'per_piece': return money(v, cur) + '/pc';
      case 'flat': return money(v, cur);
      default: return money(v, cur) + '/g';
    }
  }

  function headerBlock(settings, bill, title, r) {
    var lines = [];
    if (settings.address) lines.push(U.nl2br(settings.address));
    var contact = [];
    if (settings.phone) contact.push('Ph: ' + esc(settings.phone));
    if (settings.email) contact.push(esc(settings.email));
    if (settings.website) contact.push(esc(settings.website));
    if (contact.length) lines.push(contact.join(' &nbsp;|&nbsp; '));
    var ids = [];
    if (settings.gstin) ids.push('GSTIN: <b>' + esc(settings.gstin) + '</b>');
    if (settings.pan) ids.push('PAN: ' + esc(settings.pan));
    if (settings.bisLicense) ids.push('BIS Lic: ' + esc(settings.bisLicense));
    if (ids.length) lines.push(ids.join(' &nbsp;|&nbsp; '));

    return '' +
      '<header class="inv-head">' +
        '<div class="inv-brand">' +
          (settings.logo ? '<img class="inv-logo" src="' + esc(settings.logo) + '" alt="">' : '<div class="inv-logo inv-logo--mono">' + esc((settings.shopName || 'J').trim().charAt(0).toUpperCase()) + '</div>') +
          '<div class="inv-brand-text">' +
            '<h1>' + esc(settings.shopName || 'Jewellers') + '</h1>' +
            (settings.tagline ? '<div class="inv-tagline">' + esc(settings.tagline) + '</div>' : '') +
            '<div class="inv-meta-lines">' + lines.map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="inv-title">' +
          '<div class="inv-doc-type">' + esc(title) + '</div>' +
          '<table class="inv-kv">' +
            '<tr><th>Invoice No.</th><td>' + esc(bill.invoiceNo || '—') + '</td></tr>' +
            '<tr><th>Date</th><td>' + esc(U.formatDate(bill.date)) + '</td></tr>' +
            (bill.dueDate ? '<tr><th>Due Date</th><td>' + esc(U.formatDate(bill.dueDate)) + '</td></tr>' : '') +
            (bill.docType !== 'estimate' && r.payments.length ? '<tr><th>Payment</th><td class="inv-status inv-status--' + (r.balance <= 0.005 ? 'paid' : 'partial') + '">' + (r.balance <= 0.005 ? 'PAID' : 'PARTIALLY PAID') + '</td></tr>' : '') +
          '</table>' +
        '</div>' +
      '</header>';
  }

  function partiesBlock(settings, bill, r) {
    var c = bill.customer || {};
    var cust = [];
    if (c.name) cust.push('<div class="inv-cust-name">' + esc(c.name) + '</div>');
    if (c.address) cust.push('<div>' + U.nl2br(c.address) + '</div>');
    var contact = [];
    if (c.phone) contact.push('Ph: ' + esc(c.phone));
    if (c.email) contact.push(esc(c.email));
    if (contact.length) cust.push('<div>' + contact.join(' &nbsp;|&nbsp; ') + '</div>');
    var ids = [];
    if (c.gstin) ids.push('GSTIN: ' + esc(c.gstin));
    if (c.pan) ids.push('PAN: ' + esc(c.pan));
    if (ids.length) cust.push('<div>' + ids.join(' &nbsp;|&nbsp; ') + '</div>');
    if (!cust.length) cust.push('<div class="inv-muted">Walk-in customer</div>');

    // Rates actually used on this bill (distinct purity/rate pairs)
    var seen = {}, rates = [];
    (bill.items || []).forEach(function (it, i) {
      var line = r.lines[i];
      if (!line || !line.rate) return;
      var key = (it.purity || it.category) + '@' + line.rate;
      if (seen[key]) return;
      seen[key] = true;
      rates.push('<tr><th>' + esc(it.purity || it.category) + '</th><td>' + money(line.rate, bill.currency) + ' /g</td></tr>');
    });

    return '' +
      '<section class="inv-parties">' +
        '<div class="inv-box"><div class="inv-box-title">Bill To</div>' + cust.join('') + '</div>' +
        '<div class="inv-box inv-box--rates"><div class="inv-box-title">Rates applied</div>' +
          (rates.length ? '<table class="inv-kv inv-kv--tight">' + rates.join('') + '</table>' : '<div class="inv-muted">—</div>') +
        '</div>' +
      '</section>';
  }

  function itemsTable(bill, r, opts) {
    var cur = bill.currency;
    var showHsn = (bill.items || []).some(function (it) { return it.hsn; }) && (bill.tax.type === 'gst_intra' || bill.tax.type === 'gst_inter');
    var showWastage = r.lines.some(function (l) { return l.wastageWeight > 0; });
    var showExtra = r.lines.some(function (l) { return l.stoneCharges || l.otherCharges || l.discount; });
    var showTaxCol = (bill.items || []).some(function (it) { return it.taxRate != null && it.taxRate !== '' && U.num(it.taxRate) !== U.num(bill.tax.rate); });

    // Column plan (kept to <= 11 so it fits A4/A5):
    // # | Description (+HSN/HUID/qty sub-line) | Purity | Gross | Net (+less) | [VA] | Rate | Metal value | Making | [Stone/Other/Disc] | [Tax%] | Amount
    var head = '<tr>' +
      '<th class="c">#</th><th class="l">Description</th>' +
      '<th class="c">Purity</th><th class="c">Qty</th>' +
      '<th class="r">Gross<br>(g)</th><th class="r">Net<br>(g)</th>' +
      (showWastage ? '<th class="r">VA /<br>Wastage</th>' : '') +
      '<th class="r">Rate<br>/ g</th><th class="r">Metal<br>Value</th><th class="r">Making</th>' +
      (showExtra ? '<th class="r">Stone /<br>Other</th>' : '') +
      (showTaxCol ? '<th class="c">Tax<br>%</th>' : '') +
      '<th class="r">Amount</th></tr>';

    var rows = (bill.items || []).map(function (it, i) {
      var l = r.lines[i];
      var desc = '<div class="inv-item-name">' + esc(it.description || '—') + '</div>';
      var sub = [];
      if (showHsn && it.hsn) sub.push('HSN ' + esc(it.hsn));
      if (it.huid) sub.push('HUID ' + esc(it.huid));
      if (it.category && it.category !== 'Other' && it.category !== 'Gold') sub.push(esc(it.category));
      if (l.lessWeight) sub.push('Less ' + wt(l.lessWeight) + ' g');
      if (sub.length) desc += '<div class="inv-item-sub">' + sub.join(' · ') + '</div>';

      var extra = '';
      if (showExtra) {
        var parts = [];
        if (l.stoneCharges) parts.push(money(l.stoneCharges, cur));
        if (l.otherCharges) parts.push(money(l.otherCharges, cur));
        if (l.discount) parts.push('<span class="inv-item-sub">Disc</span> −' + money(l.discount, cur));
        extra = parts.length ? parts.join('<br>') : '—';
      }
      return '<tr>' +
        '<td class="c">' + (i + 1) + '</td><td class="l">' + desc + '</td>' +
        '<td class="c">' + esc(it.purity || '—') + '</td><td class="c">' + l.qty + '</td>' +
        '<td class="r">' + wt(l.grossWeight) + '</td>' +
        '<td class="r">' + wt(l.netWeight) + '</td>' +
        (showWastage ? '<td class="r">' + (l.wastageWeight ? U.formatPct(U.num(it.wastagePct)) + '<div class="inv-item-sub">' + wt(l.wastageWeight) + ' g</div>' : '—') + '</td>' : '') +
        '<td class="r">' + (l.rate ? money(l.rate, cur) : '—') + '</td>' +
        '<td class="r">' + money(l.metalValue, cur) + '</td>' +
        '<td class="r">' + (l.making ? money(l.making, cur) + '<div class="inv-item-sub">' + makingLabel(it, l, cur) + '</div>' : '—') + '</td>' +
        (showExtra ? '<td class="r">' + extra + '</td>' : '') +
        (showTaxCol ? '<td class="c">' + U.formatPct(l.taxRate) + '</td>' : '') +
        '<td class="r inv-amt">' + money(l.amount, cur) + '</td>' +
        '</tr>';
    }).join('');

    var trailing = 3 + (showWastage ? 1 : 0) + (showExtra ? 1 : 0) + (showTaxCol ? 1 : 0);
    var foot = '<tr class="inv-items-total">' +
      '<td colspan="4" class="r"><b>Total</b> &nbsp;<span class="inv-item-sub">' + r.totalPieces + ' pc</span></td>' +
      '<td class="r"><b>' + wt(r.totalGross) + '</b></td><td class="r"><b>' + wt(r.totalNet) + '</b></td>' +
      '<td colspan="' + trailing + '"></td>' +
      '<td class="r"><b>' + money(r.subtotal, cur) + '</b></td></tr>';

    return '<table class="inv-items"><thead>' + head + '</thead><tbody>' + rows + '</tbody><tfoot>' + foot + '</tfoot></table>';
  }

  /** Narrow table for A5: 8–9 columns, secondary figures on sub-lines. */
  function itemsTableNarrow(bill, r) {
    var cur = bill.currency;
    var showHsn = (bill.items || []).some(function (it) { return it.hsn; }) && (bill.tax.type === 'gst_intra' || bill.tax.type === 'gst_inter');
    var showExtra = r.lines.some(function (l) { return l.stoneCharges || l.otherCharges || l.discount; });
    var showTaxCol = (bill.items || []).some(function (it) { return it.taxRate != null && it.taxRate !== '' && U.num(it.taxRate) !== U.num(bill.tax.rate); });

    var head = '<tr>' +
      '<th class="c">#</th><th class="l">Description</th><th class="c">Purity</th><th class="c">Qty</th>' +
      '<th class="r">Net wt (g)</th><th class="r">Metal value</th><th class="r">Making</th>' +
      (showExtra ? '<th class="r">Stone / Other</th>' : '') +
      (showTaxCol ? '<th class="c">Tax %</th>' : '') +
      '<th class="r">Amount</th></tr>';

    var rows = (bill.items || []).map(function (it, i) {
      var l = r.lines[i];
      var desc = '<div class="inv-item-name">' + esc(it.description || '—') + '</div>';
      var sub = [];
      if (showHsn && it.hsn) sub.push('HSN ' + esc(it.hsn));
      if (it.huid) sub.push('HUID ' + esc(it.huid));
      if (it.category && it.category !== 'Other' && it.category !== 'Gold') sub.push(esc(it.category));
      if (sub.length) desc += '<div class="inv-item-sub">' + sub.join(' · ') + '</div>';

      var wtCell = wt(l.netWeight) + '<div class="inv-item-sub">gross ' + wt(l.grossWeight) + (l.lessWeight ? ' − ' + wt(l.lessWeight) : '') + '</div>';
      var metalSub = [];
      if (l.rate) metalSub.push('@ ' + money(l.rate, cur) + '/g');
      if (l.wastageWeight) metalSub.push('VA ' + U.formatPct(U.num(it.wastagePct)));
      var metalCell = money(l.metalValue, cur) + (metalSub.length ? '<div class="inv-item-sub">' + metalSub.join(' · ') + '</div>' : '');

      var extra = '';
      if (showExtra) {
        var parts = [];
        if (l.stoneCharges) parts.push(money(l.stoneCharges, cur));
        if (l.otherCharges) parts.push(money(l.otherCharges, cur));
        if (l.discount) parts.push('<span class="inv-item-sub">Disc</span> −' + money(l.discount, cur));
        extra = parts.length ? parts.join('<br>') : '—';
      }
      return '<tr>' +
        '<td class="c">' + (i + 1) + '</td><td class="l">' + desc + '</td>' +
        '<td class="c">' + esc(it.purity || '—') + '</td><td class="c">' + l.qty + '</td>' +
        '<td class="r">' + wtCell + '</td>' +
        '<td class="r">' + metalCell + '</td>' +
        '<td class="r">' + (l.making ? money(l.making, cur) + '<div class="inv-item-sub">' + makingLabel(it, l, cur) + '</div>' : '—') + '</td>' +
        (showExtra ? '<td class="r">' + extra + '</td>' : '') +
        (showTaxCol ? '<td class="c">' + U.formatPct(l.taxRate) + '</td>' : '') +
        '<td class="r inv-amt">' + money(l.amount, cur) + '</td>' +
        '</tr>';
    }).join('');

    var trailing = 2 + (showExtra ? 1 : 0) + (showTaxCol ? 1 : 0);
    var foot = '<tr class="inv-items-total">' +
      '<td colspan="4" class="r"><b>Total</b> &nbsp;<span class="inv-item-sub">' + r.totalPieces + ' pc</span></td>' +
      '<td class="r"><b>' + wt(r.totalNet) + '</b><div class="inv-item-sub">gross ' + wt(r.totalGross) + '</div></td>' +
      '<td colspan="' + trailing + '"></td>' +
      '<td class="r"><b>' + money(r.subtotal, cur) + '</b></td></tr>';

    return '<table class="inv-items inv-items--narrow"><thead>' + head + '</thead><tbody>' + rows + '</tbody><tfoot>' + foot + '</tfoot></table>';
  }

  /** Stacked item list for narrow (80mm) receipts. */
  function itemsStacked(bill, r) {
    var cur = bill.currency;
    var rows = (bill.items || []).map(function (it, i) {
      var l = r.lines[i];
      var meta = [];
      if (it.purity) meta.push(esc(it.purity));
      if (l.qty > 1) meta.push(l.qty + ' pc');
      if (it.huid) meta.push('HUID ' + esc(it.huid));
      var lines = [];
      lines.push('Gross ' + wt(l.grossWeight) + ' g' + (l.lessWeight ? ' − less ' + wt(l.lessWeight) + ' g' : '') + ' = net ' + wt(l.netWeight) + ' g');
      if (l.rate) lines.push((l.wastageWeight ? wt(l.chargeableWeight) + ' g (incl. VA ' + U.formatPct(U.num(it.wastagePct)) + ')' : wt(l.netWeight) + ' g') + ' × ' + money(l.rate, cur) + ' = ' + money(l.metalValue, cur));
      if (l.making) lines.push('Making ' + makingLabel(it, l, cur) + ' = ' + money(l.making, cur));
      if (l.stoneCharges) lines.push('Stone charges ' + money(l.stoneCharges, cur));
      if (l.otherCharges) lines.push('Other charges ' + money(l.otherCharges, cur));
      if (l.discount) lines.push('Discount −' + money(l.discount, cur));
      return '<div class="inv-stack-item">' +
        '<div class="inv-stack-head"><span>' + (i + 1) + '. <b>' + esc(it.description || '—') + '</b>' + (meta.length ? ' <span class="inv-item-sub">' + meta.join(' · ') + '</span>' : '') + '</span><b>' + money(l.amount, cur) + '</b></div>' +
        '<div class="inv-stack-lines">' + lines.map(function (x) { return '<div>' + x + '</div>'; }).join('') + '</div>' +
        '</div>';
    }).join('');
    return '<div class="inv-stack">' + rows +
      '<div class="inv-stack-total"><span>Total &nbsp;<span class="inv-item-sub">' + r.totalPieces + ' pc · net ' + wt(r.totalNet) + ' g</span></span><b>' + money(r.subtotal, cur) + '</b></div></div>';
  }

  function chargesTable(bill, r) {
    if (!r.charges.length) return '';
    var cur = bill.currency;
    return '<section class="inv-section"><div class="inv-section-title">Additional charges</div>' +
      '<table class="inv-items inv-items--small"><thead><tr><th class="l">Particulars</th><th class="r">Amount</th><th class="c">Tax</th><th class="r">Total</th></tr></thead><tbody>' +
      r.charges.map(function (c) {
        return '<tr><td class="l">' + esc(c.label || 'Charge') + '</td><td class="r">' + money(c.taxable, cur) + '</td><td class="c">' + (c.taxRate ? U.formatPct(c.taxRate) : '—') + '</td><td class="r">' + money(c.total, cur) + '</td></tr>';
      }).join('') +
      '</tbody></table></section>';
  }

  function oldTable(bill, r, stacked) {
    if (!r.oldLines.length) return '';
    var cur = bill.currency;
    if (stacked) {
      return '<section class="inv-section"><div class="inv-section-title">Old metal exchange (deducted)</div><div class="inv-stack">' +
        bill.oldItems.map(function (o, i) {
          var l = r.oldLines[i];
          return '<div class="inv-stack-item"><div class="inv-stack-head"><span>' + (i + 1) + '. <b>' + esc(o.description || 'Old ' + (o.category || 'metal')) + '</b></span><b>' + money(l.amount, cur) + '</b></div>' +
            '<div class="inv-stack-lines"><div>Net ' + wt(l.netWeight) + ' g × ' + U.formatPct(l.purityPct) + ' = fine ' + wt(l.fineWeight) + ' g × ' + money(l.rate, cur) + (l.deduction ? ' − ' + money(l.deduction, cur) : '') + '</div></div></div>';
        }).join('') +
        '<div class="inv-stack-total"><span>Total exchange value</span><b>' + money(r.oldTotal, cur) + '</b></div></div></section>';
    }
    return '<section class="inv-section"><div class="inv-section-title">Old metal exchange (deducted)</div>' +
      '<table class="inv-items inv-items--small"><thead><tr>' +
      '<th class="c">#</th><th class="l">Description</th><th class="r">Gross (g)</th><th class="r">Net (g)</th><th class="c">Purity</th><th class="r">Fine (g)</th><th class="r">Rate /g</th><th class="r">Deduction</th><th class="r">Value</th></tr></thead><tbody>' +
      bill.oldItems.map(function (o, i) {
        var l = r.oldLines[i];
        return '<tr><td class="c">' + (i + 1) + '</td><td class="l">' + esc(o.description || 'Old ' + (o.category || 'metal')) + '</td>' +
          '<td class="r">' + wt(l.grossWeight) + '</td><td class="r">' + wt(l.netWeight) + '</td><td class="c">' + U.formatPct(l.purityPct) + '</td>' +
          '<td class="r">' + wt(l.fineWeight) + '</td><td class="r">' + money(l.rate, cur) + '</td>' +
          '<td class="r">' + (l.deduction ? money(l.deduction, cur) : '—') + '</td><td class="r inv-amt">' + money(l.amount, cur) + '</td></tr>';
      }).join('') +
      '</tbody><tfoot><tr class="inv-items-total"><td colspan="8" class="r"><b>Total exchange value</b></td><td class="r"><b>' + money(r.oldTotal, cur) + '</b></td></tr></tfoot></table></section>';
  }

  function totalsBlock(settings, bill, r) {
    var cur = bill.currency;
    var rows = [];
    var push = function (label, val, cls) { rows.push('<tr class="' + (cls || '') + '"><th>' + label + '</th><td>' + val + '</td></tr>'); };

    push('Subtotal', money(r.subtotal, cur));
    if (r.discount) push('Discount' + (bill.discountType === 'percent' ? ' (' + U.formatPct(bill.discountValue) + ')' : ''), '- ' + money(r.discount, cur));
    if (r.chargesTotal) push('Additional charges', money(r.charges.reduce(function (s, c) { return s + c.taxable; }, 0), cur));
    if (bill.tax.type !== 'none') {
      push('Taxable value', money(r.taxable, cur));
      r.taxSplit.forEach(function (t) { push(esc(t.label), money(t.amount, cur)); });
    }
    push('Grand total', money(r.grandTotal, cur), 'inv-tot-strong');
    if (r.oldTotal) push('Less: old metal exchange', '- ' + money(r.oldTotal, cur));
    if (Math.abs(r.roundOff) >= 0.005) push('Round off', (r.roundOff > 0 ? '+ ' : '- ') + money(Math.abs(r.roundOff), cur));
    push(r.netPayable < 0 ? 'Refund to customer' : 'Net payable', money(Math.abs(r.netPayable), cur), 'inv-tot-grand');
    if (r.payments.length) {
      r.payments.forEach(function (p) {
        push('Paid — ' + esc(p.mode) + (p.ref ? ' (' + esc(p.ref) + ')' : ''), '- ' + money(p.amount, cur));
      });
      push(r.balance < 0 ? 'Change / credit' : 'Balance due', money(Math.abs(r.balance), cur), 'inv-tot-strong');
    }

    var bank = settings.bank || {};
    var bankLines = [];
    if (bank.name) bankLines.push('<div><b>Bank:</b> ' + esc(bank.name) + '</div>');
    if (bank.account) bankLines.push('<div><b>A/c No:</b> ' + esc(bank.account) + '</div>');
    if (bank.ifsc) bankLines.push('<div><b>IFSC:</b> ' + esc(bank.ifsc) + '</div>');
    if (bank.upi) bankLines.push('<div><b>UPI:</b> ' + esc(bank.upi) + '</div>');

    return '' +
      '<section class="inv-bottom">' +
        '<div class="inv-bottom-left">' +
          '<div class="inv-words"><span class="inv-box-title">Amount in words</span>' + esc(U.amountInWords(Math.abs(r.netPayable), cur)) + '</div>' +
          (r.metals.length ? '<div class="inv-metals"><span class="inv-box-title">Metal summary</span><table class="inv-kv inv-kv--tight">' +
            r.metals.map(function (m) { return '<tr><th>' + esc(m.category) + '</th><td>' + m.pieces + ' pc · net ' + wt(m.net) + ' g · fine ' + wt(m.fine) + ' g</td></tr>'; }).join('') +
            '</table></div>' : '') +
          (bankLines.length ? '<div class="inv-bank"><span class="inv-box-title">Payment details</span>' + bankLines.join('') + '</div>' : '') +
          (bill.notes ? '<div class="inv-notes"><span class="inv-box-title">Notes</span>' + U.nl2br(bill.notes) + '</div>' : '') +
        '</div>' +
        '<div class="inv-bottom-right"><table class="inv-totals">' + rows.join('') + '</table></div>' +
      '</section>';
  }

  function footerBlock(settings) {
    return '' +
      (settings.terms ? '<section class="inv-terms"><span class="inv-box-title">Terms &amp; conditions</span><ol>' +
        String(settings.terms).split(/\r?\n/).filter(function (s) { return s.trim(); }).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
        '</ol></section>' : '') +
      '<section class="inv-sign">' +
        '<div class="inv-sign-box"><div class="inv-sign-line"></div>Customer signature</div>' +
        '<div class="inv-sign-box inv-sign-box--auth">' +
          '<div class="inv-for">For <b>' + esc(settings.shopName || '') + '</b></div>' +
          (settings.signature ? '<img class="inv-sign-img" src="' + esc(settings.signature) + '" alt="">' : '<div class="inv-sign-space"></div>') +
          '<div class="inv-sign-line"></div>Authorised signatory' +
        '</div>' +
      '</section>' +
      (settings.footer ? '<footer class="inv-foot">' + esc(settings.footer) + '</footer>' : '') +
      '<div class="inv-generated">Computer generated invoice</div>';
  }

  /**
   * Render invoice HTML.
   * opts: { template: 'classic'|'modern'|'compact', title: string, copy: string,
   *         layout: 'full'|'narrow'|'stacked' }
   * `narrow` (A5) uses fewer item columns; `stacked` (80mm receipts) renders
   * items as a list instead of a table.
   */
  function render(bill, settings, opts) {
    opts = opts || {};
    var r = C.computeBill(bill);
    var title = opts.title || (bill.docType === 'estimate' ? 'ESTIMATE' : bill.tax.type === 'none' ? 'INVOICE' : 'TAX INVOICE');
    var tpl = opts.template || 'classic';
    var stacked = opts.layout === 'stacked' || !!opts.stacked;
    var narrow = opts.layout === 'narrow';
    var html = '<article class="inv inv--' + esc(tpl) + (stacked ? ' inv--stacked' : '') + (narrow ? ' inv--narrow' : '') + '">' +
      (opts.copy ? '<div class="inv-copy-row"><span class="inv-copy">' + esc(opts.copy) + '</span></div>' : '') +
      headerBlock(settings, bill, title, r) +
      partiesBlock(settings, bill, r) +
      (stacked ? itemsStacked(bill, r) : narrow ? itemsTableNarrow(bill, r) : itemsTable(bill, r, opts)) +
      chargesTable(bill, r) +
      oldTable(bill, r, stacked) +
      totalsBlock(settings, bill, r) +
      footerBlock(settings) +
      '</article>';
    return html;
  }

  /** Plain-text summary for WhatsApp / SMS sharing. */
  function toText(bill, settings) {
    var r = C.computeBill(bill);
    var cur = bill.currency;
    var L = [];
    L.push('*' + (settings.shopName || 'Invoice') + '*');
    L.push((bill.docType === 'estimate' ? 'Estimate' : 'Invoice') + ' ' + (bill.invoiceNo || '') + ' · ' + U.formatDate(bill.date));
    if (bill.customer && bill.customer.name) L.push('Customer: ' + bill.customer.name);
    L.push('');
    (bill.items || []).forEach(function (it, i) {
      var l = r.lines[i];
      L.push((i + 1) + '. ' + (it.description || 'Item') + (it.purity ? ' (' + it.purity + ')' : ''));
      L.push('   Net ' + wtPlain(l.netWeight) + 'g × ' + moneyPlain(l.rate, cur) + (l.making ? ' + making ' + moneyPlain(l.making, cur) : '') + ' = ' + moneyPlain(l.amount, cur));
    });
    L.push('');
    L.push('Subtotal: ' + moneyPlain(r.subtotal, cur));
    if (r.discount) L.push('Discount: -' + moneyPlain(r.discount, cur));
    r.taxSplit.forEach(function (t) { L.push(t.label + ': ' + moneyPlain(t.amount, cur)); });
    if (r.chargesTotal) L.push('Charges: ' + moneyPlain(r.chargesTotal, cur));
    if (r.oldTotal) L.push('Old metal exchange: -' + moneyPlain(r.oldTotal, cur));
    L.push('*' + (r.netPayable < 0 ? 'Refund' : 'Net payable') + ': ' + moneyPlain(Math.abs(r.netPayable), cur) + '*');
    if (r.paid) {
      L.push('Paid: ' + moneyPlain(r.paid, cur));
      L.push('Balance: ' + moneyPlain(r.balance, cur));
    }
    if (settings.footer) { L.push(''); L.push(settings.footer); }
    return L.join('\n');
  }

  root.JBInvoice = { render: render, toText: toText };
}(window));
