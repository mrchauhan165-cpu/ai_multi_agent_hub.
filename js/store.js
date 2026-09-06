/*
 * store.js — persistence via localStorage. Holds shop settings, the saved bill
 * list, and the invoice counter. Everything is namespaced under "jbg:".
 */
(function (root) {
  'use strict';

  var U = root.JBUtils;
  var NS = 'jbg:';
  var KEYS = { settings: NS + 'settings', bills: NS + 'bills', counter: NS + 'counter', draft: NS + 'draft' };

  // Sensible defaults for a first run. Rates are meant to be replaced by the
  // shop's live board rate each morning (Settings → Metal rates).
  var DEFAULT_SETTINGS = {
    shopName: 'Your Jewellers',
    tagline: 'Gold • Silver • Diamond',
    address: '',
    phone: '',
    email: '',
    website: '',
    gstin: '',
    pan: '',
    bisLicense: '',
    logo: '',                  // data URL
    signature: '',             // data URL
    currency: 'INR',
    taxType: 'gst_intra',
    taxRate: 3,
    taxInclusive: false,
    roundOff: true,
    invoicePrefix: 'INV-',
    invoiceNext: 1,
    invoicePad: 4,
    estimatePrefix: 'EST-',
    estimateNext: 1,
    defaultMakingType: 'per_gram',
    defaultWastage: 0,
    rates: {                   // per gram
      '24K': 15480,
      '22K': 14190,
      '18K': 11610,
      '14K': 9050,
      '999 Silver': 235,
      '925 Silver': 218,
      '950 Platinum': 4200
    },
    bank: { name: '', account: '', ifsc: '', upi: '' },
    terms: 'Goods once sold will not be taken back. Exchange as per shop policy.\nWeights verified in front of the customer. Rates as per the board rate on the date of sale.\nHallmarked jewellery carries BIS HUID; please keep this invoice for future exchange.',
    footer: 'Thank you for your business!'
  };

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('localStorage write failed', e);
      return false;
    }
  }

  function deepMerge(base, over) {
    var out = U.clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(over).forEach(function (k) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') {
        out[k] = deepMerge(base[k], over[k]);
      } else if (over[k] !== undefined) {
        out[k] = over[k];
      }
    });
    return out;
  }

  /* ---------------------------- settings ----------------------------- */

  function getSettings() {
    return deepMerge(DEFAULT_SETTINGS, read(KEYS.settings, {}));
  }

  function saveSettings(s) {
    return write(KEYS.settings, s);
  }

  /* --------------------------- numbering ----------------------------- */

  /** Next number for the given docType ('invoice' | 'estimate') without consuming it. */
  function peekNumber(docType, settings) {
    settings = settings || getSettings();
    var est = docType === 'estimate';
    var prefix = est ? settings.estimatePrefix : settings.invoicePrefix;
    var next = est ? settings.estimateNext : settings.invoiceNext;
    return (prefix || '') + U.padNumber(next || 1, settings.invoicePad || 4);
  }

  /** Reserve the next number (increments the counter) and return it. */
  function takeNumber(docType) {
    var s = getSettings();
    var no = peekNumber(docType, s);
    if (docType === 'estimate') s.estimateNext = Number(s.estimateNext || 1) + 1;
    else s.invoiceNext = Number(s.invoiceNext || 1) + 1;
    saveSettings(s);
    return no;
  }

  /* ------------------------------ bills ------------------------------ */

  function getBills() {
    var list = read(KEYS.bills, []);
    return Array.isArray(list) ? list : [];
  }

  function getBill(id) {
    return getBills().find(function (b) { return b.id === id; }) || null;
  }

  function saveBill(bill) {
    var list = getBills();
    bill.updatedAt = new Date().toISOString();
    var i = list.findIndex(function (b) { return b.id === bill.id; });
    if (i >= 0) list[i] = bill; else list.unshift(bill);
    return write(KEYS.bills, list);
  }

  function deleteBill(id) {
    return write(KEYS.bills, getBills().filter(function (b) { return b.id !== id; }));
  }

  function invoiceNoExists(no, exceptId) {
    return getBills().some(function (b) { return b.invoiceNo === no && b.id !== exceptId; });
  }

  /* ------------------------------ draft ------------------------------ */

  function getDraft() { return read(KEYS.draft, null); }
  function saveDraft(bill) { return write(KEYS.draft, bill); }
  function clearDraft() { localStorage.removeItem(KEYS.draft); }

  /* --------------------------- import/export -------------------------- */

  function exportAll() {
    return {
      app: 'jewellery-bill-generator',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: getSettings(),
      bills: getBills()
    };
  }

  function importAll(data, mode) {
    if (!data || data.app !== 'jewellery-bill-generator') throw new Error('Not a Jewellery Bill Generator backup file.');
    if (data.settings) saveSettings(deepMerge(DEFAULT_SETTINGS, data.settings));
    var incoming = Array.isArray(data.bills) ? data.bills : [];
    if (mode === 'replace') {
      write(KEYS.bills, incoming);
    } else {
      var existing = getBills();
      var byId = {};
      existing.forEach(function (b) { byId[b.id] = true; });
      incoming.forEach(function (b) { if (!byId[b.id]) existing.push(b); });
      existing.sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
      write(KEYS.bills, existing);
    }
    return { bills: incoming.length };
  }

  function resetAll() {
    Object.keys(KEYS).forEach(function (k) { localStorage.removeItem(KEYS[k]); });
  }

  root.JBStore = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    getSettings: getSettings,
    saveSettings: saveSettings,
    peekNumber: peekNumber,
    takeNumber: takeNumber,
    getBills: getBills,
    getBill: getBill,
    saveBill: saveBill,
    deleteBill: deleteBill,
    invoiceNoExists: invoiceNoExists,
    getDraft: getDraft,
    saveDraft: saveDraft,
    clearDraft: clearDraft,
    exportAll: exportAll,
    importAll: importAll,
    resetAll: resetAll
  };
}(window));
