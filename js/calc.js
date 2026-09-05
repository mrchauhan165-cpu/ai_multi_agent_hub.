/*
 * calc.js — the pricing engine. Pure functions only: given a bill object it
 * returns a fully computed breakdown. No DOM access, so the same file runs in
 * the browser (window.JBCalc) and under Node for the test-suite.
 *
 * Pricing model (per line item, weights are totals for the line):
 *
 *   netWeight        = grossWeight - lessWeight            (stones / thread / lac)
 *   wastageWeight    = netWeight * wastagePct / 100        (a.k.a. VA / value addition)
 *   chargeableWeight = netWeight + wastageWeight
 *   metalValue       = chargeableWeight * ratePerGram
 *   makingCharge     = per_gram  -> makingValue * netWeight
 *                      percent   -> metalValue * makingValue / 100
 *                      per_piece -> makingValue * qty
 *                      flat      -> makingValue
 *   lineAmount       = metalValue + making + stoneCharges + otherCharges - lineDiscount
 *
 * The bill-level discount is allocated proportionally across lines *before*
 * tax so that the tax base stays correct. Tax may be exclusive (added on top)
 * or inclusive (backed out of the entered figures).
 *
 * Old-metal exchange lines are valued as
 *   net * purityPct/100 * ratePerGram * (1 - deductionPct/100)
 * and deducted from the grand total. Payments are then subtracted to give the
 * balance due.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./utils.js'));
  } else {
    root.JBCalc = factory(root.JBUtils);
  }
}(typeof self !== 'undefined' ? self : this, function (U) {
  'use strict';

  var num = U.num, round2 = U.round2;

  var MAKING_TYPES = [
    { value: 'per_gram', label: 'per gram' },
    { value: 'percent', label: '% of metal value' },
    { value: 'per_piece', label: 'per piece' },
    { value: 'flat', label: 'flat (line)' }
  ];

  var TAX_TYPES = [
    { value: 'gst_intra', label: 'GST (CGST + SGST)' },
    { value: 'gst_inter', label: 'IGST (inter-state)' },
    { value: 'vat', label: 'VAT' },
    { value: 'sales_tax', label: 'Sales tax' },
    { value: 'none', label: 'No tax' }
  ];

  // Purity presets (label => fineness %) shown in the item form.
  var PURITIES = [
    { label: '24K', pct: 99.9, metal: 'Gold' },
    { label: '22K', pct: 91.6, metal: 'Gold' },
    { label: '20K', pct: 83.3, metal: 'Gold' },
    { label: '18K', pct: 75.0, metal: 'Gold' },
    { label: '14K', pct: 58.5, metal: 'Gold' },
    { label: '9K', pct: 37.5, metal: 'Gold' },
    { label: '999 Silver', pct: 99.9, metal: 'Silver' },
    { label: '925 Silver', pct: 92.5, metal: 'Silver' },
    { label: '950 Platinum', pct: 95.0, metal: 'Platinum' },
    { label: '900 Platinum', pct: 90.0, metal: 'Platinum' }
  ];

  var CATEGORIES = ['Gold', 'Silver', 'Platinum', 'Diamond', 'Gemstone', 'Other'];

  /* ------------------------------------------------------------------ */
  /* Factories                                                           */
  /* ------------------------------------------------------------------ */

  function newItem(overrides) {
    var it = {
      id: U.uid(),
      description: '',
      category: 'Gold',
      purity: '22K',
      hsn: '7113',
      qty: 1,
      grossWeight: 0,
      lessWeight: 0,
      wastagePct: 0,
      rate: 0,
      makingType: 'per_gram',
      makingValue: 0,
      stoneCharges: 0,
      otherCharges: 0,
      discount: 0,
      taxRate: null // null => use bill-level rate
    };
    if (overrides) Object.keys(overrides).forEach(function (k) { it[k] = overrides[k]; });
    return it;
  }

  function newOldItem(overrides) {
    var it = {
      id: U.uid(),
      description: '',
      category: 'Gold',
      grossWeight: 0,
      lessWeight: 0,
      purityPct: 100,
      rate: 0,
      deductionPct: 0
    };
    if (overrides) Object.keys(overrides).forEach(function (k) { it[k] = overrides[k]; });
    return it;
  }

  function newCharge(overrides) {
    var c = { id: U.uid(), label: '', amount: 0, taxRate: 0 };
    if (overrides) Object.keys(overrides).forEach(function (k) { c[k] = overrides[k]; });
    return c;
  }

  function newPayment(overrides) {
    var p = { id: U.uid(), mode: 'Cash', amount: 0, ref: '', date: U.todayISO() };
    if (overrides) Object.keys(overrides).forEach(function (k) { p[k] = overrides[k]; });
    return p;
  }

  function newBill(settings) {
    settings = settings || {};
    return {
      version: 1,
      id: U.uid(),
      invoiceNo: '',
      date: U.todayISO(),
      dueDate: '',
      docType: 'invoice', // 'invoice' | 'estimate'
      currency: settings.currency || 'INR',
      customer: { name: '', phone: '', email: '', address: '', gstin: '', pan: '' },
      tax: {
        type: settings.taxType || 'gst_intra',
        rate: settings.taxRate == null ? 3 : settings.taxRate,
        inclusive: !!settings.taxInclusive
      },
      items: [newItem()],
      discountType: 'flat',
      discountValue: 0,
      charges: [],
      oldItems: [],
      payments: [],
      roundOff: settings.roundOff !== false,
      notes: settings.defaultNotes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  /* ------------------------------------------------------------------ */
  /* Line-level computation                                              */
  /* ------------------------------------------------------------------ */

  function computeMaking(it, metalValue, netWeight) {
    var v = num(it.makingValue);
    switch (it.makingType) {
      case 'percent': return metalValue * v / 100;
      case 'per_piece': return v * Math.max(1, num(it.qty) || 1);
      case 'flat': return v;
      case 'per_gram':
      default: return v * netWeight;
    }
  }

  function computeItem(it, bill) {
    var gross = Math.max(0, num(it.grossWeight));
    var less = Math.min(gross, Math.max(0, num(it.lessWeight)));
    var net = gross - less;
    var wastagePct = Math.max(0, num(it.wastagePct));
    var wastageWeight = net * wastagePct / 100;
    var chargeable = net + wastageWeight;
    var rate = Math.max(0, num(it.rate));
    var metalValue = chargeable * rate;
    var making = computeMaking(it, metalValue, net);
    var stones = num(it.stoneCharges);
    var other = num(it.otherCharges);
    var discount = num(it.discount);
    var amount = metalValue + making + stones + other - discount;
    var taxRate = it.taxRate == null || it.taxRate === '' ? num(bill.tax.rate) : num(it.taxRate);
    if (bill.tax.type === 'none') taxRate = 0;

    return {
      id: it.id,
      qty: Math.max(1, num(it.qty) || 1),
      grossWeight: gross,
      lessWeight: less,
      netWeight: net,
      wastageWeight: wastageWeight,
      chargeableWeight: chargeable,
      rate: rate,
      metalValue: metalValue,
      making: making,
      stoneCharges: stones,
      otherCharges: other,
      discount: discount,
      amount: amount,      // before bill discount and tax handling
      taxRate: taxRate
    };
  }

  /* ------------------------------------------------------------------ */
  /* Bill-level computation                                              */
  /* ------------------------------------------------------------------ */

  function computeBill(bill) {
    var inclusive = !!bill.tax.inclusive;
    var lines = (bill.items || []).map(function (it) { return computeItem(it, bill); });

    var subtotal = lines.reduce(function (s, l) { return s + l.amount; }, 0);

    // Bill-level discount
    var discount = 0;
    if (bill.discountType === 'percent') {
      discount = subtotal * U.clamp(num(bill.discountValue), 0, 100) / 100;
    } else {
      discount = U.clamp(num(bill.discountValue), 0, Math.max(0, subtotal));
    }
    var factor = subtotal > 0 ? (subtotal - discount) / subtotal : 1;

    // Allocate discount, then split tax
    var taxByRate = {};
    var totalTax = 0;
    var totalTaxable = 0;
    lines.forEach(function (l) {
      var afterDiscount = l.amount * factor;
      var taxable, tax;
      if (inclusive) {
        taxable = afterDiscount / (1 + l.taxRate / 100);
        tax = afterDiscount - taxable;
      } else {
        taxable = afterDiscount;
        tax = taxable * l.taxRate / 100;
      }
      l.discountShare = l.amount - afterDiscount;
      l.taxable = taxable;
      l.tax = tax;
      l.total = taxable + tax;
      totalTaxable += taxable;
      totalTax += tax;
      if (l.taxRate > 0) taxByRate[l.taxRate] = (taxByRate[l.taxRate] || 0) + tax;
    });

    // Additional bill-level charges (hallmarking, certification, shipping ...)
    var charges = (bill.charges || []).map(function (c) {
      var amt = num(c.amount);
      var r = bill.tax.type === 'none' ? 0 : Math.max(0, num(c.taxRate));
      var taxable, tax;
      if (inclusive) {
        taxable = amt / (1 + r / 100);
        tax = amt - taxable;
      } else {
        taxable = amt;
        tax = amt * r / 100;
      }
      totalTaxable += taxable;
      totalTax += tax;
      if (r > 0) taxByRate[r] = (taxByRate[r] || 0) + tax;
      return { id: c.id, label: c.label, amount: amt, taxRate: r, taxable: taxable, tax: tax, total: taxable + tax };
    });
    var chargesTotal = charges.reduce(function (s, c) { return s + c.total; }, 0);

    // Old metal exchange
    var oldLines = (bill.oldItems || []).map(function (o) {
      var gross = Math.max(0, num(o.grossWeight));
      var less = Math.min(gross, Math.max(0, num(o.lessWeight)));
      var net = gross - less;
      var purity = U.clamp(num(o.purityPct) || 100, 0, 100);
      var fine = net * purity / 100;
      var rate = Math.max(0, num(o.rate));
      var grossValue = fine * rate;
      var deduction = grossValue * U.clamp(num(o.deductionPct), 0, 100) / 100;
      return {
        id: o.id,
        grossWeight: gross,
        lessWeight: less,
        netWeight: net,
        purityPct: purity,
        fineWeight: fine,
        rate: rate,
        grossValue: grossValue,
        deduction: deduction,
        amount: grossValue - deduction
      };
    });
    var oldTotal = oldLines.reduce(function (s, o) { return s + o.amount; }, 0);

    var grandTotal = totalTaxable + totalTax; // includes charges
    var afterExchange = grandTotal - oldTotal;
    var rounded = bill.roundOff ? Math.round(afterExchange) : round2(afterExchange);
    var roundOff = rounded - afterExchange;

    var payments = (bill.payments || []).map(function (p) {
      return { id: p.id, mode: p.mode, ref: p.ref, date: p.date, amount: num(p.amount) };
    });
    var paid = payments.reduce(function (s, p) { return s + p.amount; }, 0);
    var balance = rounded - paid;

    // Tax split
    var taxSplit = [];
    var type = bill.tax.type;
    Object.keys(taxByRate).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      var t = taxByRate[r];
      if (type === 'gst_intra') {
        taxSplit.push({ label: 'CGST @ ' + U.formatPct(r / 2), rate: r / 2, amount: t / 2 });
        taxSplit.push({ label: 'SGST @ ' + U.formatPct(r / 2), rate: r / 2, amount: t / 2 });
      } else if (type === 'gst_inter') {
        taxSplit.push({ label: 'IGST @ ' + U.formatPct(r), rate: r, amount: t });
      } else if (type === 'vat') {
        taxSplit.push({ label: 'VAT @ ' + U.formatPct(r), rate: r, amount: t });
      } else if (type === 'sales_tax') {
        taxSplit.push({ label: 'Sales Tax @ ' + U.formatPct(r), rate: r, amount: t });
      }
    });

    // Metal summary by category (handy for stock/fine-weight bookkeeping)
    var metals = {};
    (bill.items || []).forEach(function (it, i) {
      var l = lines[i];
      var key = it.category || 'Other';
      if (!metals[key]) metals[key] = { category: key, gross: 0, net: 0, fine: 0, pieces: 0 };
      metals[key].gross += l.grossWeight;
      metals[key].net += l.netWeight;
      metals[key].fine += l.netWeight * purityPctFor(it.purity) / 100;
      metals[key].pieces += l.qty;
    });

    return {
      lines: lines,
      subtotal: subtotal,
      discount: discount,
      taxable: totalTaxable,
      tax: totalTax,
      taxSplit: taxSplit,
      charges: charges,
      chargesTotal: chargesTotal,
      grandTotal: grandTotal,
      oldLines: oldLines,
      oldTotal: oldTotal,
      afterExchange: afterExchange,
      roundOff: roundOff,
      netPayable: rounded,
      payments: payments,
      paid: paid,
      balance: balance,
      metals: Object.keys(metals).map(function (k) { return metals[k]; }),
      totalGross: lines.reduce(function (s, l) { return s + l.grossWeight; }, 0),
      totalNet: lines.reduce(function (s, l) { return s + l.netWeight; }, 0),
      totalPieces: lines.reduce(function (s, l) { return s + l.qty; }, 0)
    };
  }

  /** Best-effort fineness % for a purity label ("22K" => 91.6, "916" => 91.6). */
  function purityPctFor(label) {
    var s = String(label || '').trim().toUpperCase();
    for (var i = 0; i < PURITIES.length; i++) {
      if (PURITIES[i].label.toUpperCase() === s) return PURITIES[i].pct;
    }
    var k = /^(\d{1,2})\s*K/.exec(s);
    if (k) return U.clamp(Number(k[1]) / 24 * 100, 0, 100);
    var h = /^(\d{3})$/.exec(s);
    if (h) return Number(h[1]) / 10;
    var p = /(\d+(?:\.\d+)?)\s*%/.exec(s);
    if (p) return U.clamp(Number(p[1]), 0, 100);
    return 100;
  }

  /* ------------------------------------------------------------------ */
  /* Validation                                                          */
  /* ------------------------------------------------------------------ */

  function validate(bill) {
    var errors = [];
    if (!bill.items || !bill.items.length) errors.push('Add at least one item.');
    (bill.items || []).forEach(function (it, i) {
      var n = i + 1;
      if (!String(it.description || '').trim()) errors.push('Item ' + n + ': description is required.');
      if (num(it.lessWeight) > num(it.grossWeight)) errors.push('Item ' + n + ': less weight cannot exceed gross weight.');
      if (num(it.grossWeight) <= 0 && num(it.stoneCharges) <= 0 && num(it.otherCharges) <= 0 && num(it.makingValue) <= 0) {
        errors.push('Item ' + n + ': enter a weight or a charge.');
      }
    });
    (bill.oldItems || []).forEach(function (o, i) {
      if (num(o.lessWeight) > num(o.grossWeight)) errors.push('Old item ' + (i + 1) + ': less weight cannot exceed gross weight.');
    });
    return errors;
  }

  return {
    MAKING_TYPES: MAKING_TYPES,
    TAX_TYPES: TAX_TYPES,
    PURITIES: PURITIES,
    CATEGORIES: CATEGORIES,
    newBill: newBill,
    newItem: newItem,
    newOldItem: newOldItem,
    newCharge: newCharge,
    newPayment: newPayment,
    computeItem: computeItem,
    computeBill: computeBill,
    purityPctFor: purityPctFor,
    validate: validate
  };
}));
