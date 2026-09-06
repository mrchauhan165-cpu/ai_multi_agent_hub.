/*
 * utils.js — pure helpers: number parsing/formatting, dates, HTML escaping and
 * "amount in words" (Indian lakh/crore and international systems).
 *
 * Written as a tiny UMD module so the browser gets `window.JBUtils` and the
 * Node test-suite can simply `require()` it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JBUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Currencies                                                          */
  /* ------------------------------------------------------------------ */

  // `system` controls both digit grouping (via locale) and the words used for
  // "amount in words": 'indian' => lakh / crore, 'intl' => million / billion.
  var CURRENCIES = {
    INR: { symbol: '\u20B9', locale: 'en-IN', system: 'indian', major: 'Rupees', minor: 'Paise', label: 'Indian Rupee (\u20B9)' },
    PKR: { symbol: 'Rs ', locale: 'en-IN', system: 'indian', major: 'Rupees', minor: 'Paisa', label: 'Pakistani Rupee (Rs)' },
    NPR: { symbol: 'Rs ', locale: 'en-IN', system: 'indian', major: 'Rupees', minor: 'Paisa', label: 'Nepalese Rupee (Rs)' },
    BDT: { symbol: '\u09F3', locale: 'en-IN', system: 'indian', major: 'Taka', minor: 'Poisha', label: 'Bangladeshi Taka (\u09F3)' },
    LKR: { symbol: 'Rs ', locale: 'en-US', system: 'intl', major: 'Rupees', minor: 'Cents', label: 'Sri Lankan Rupee (Rs)' },
    AED: { symbol: 'AED ', locale: 'en-US', system: 'intl', major: 'Dirhams', minor: 'Fils', label: 'UAE Dirham (AED)' },
    SAR: { symbol: 'SAR ', locale: 'en-US', system: 'intl', major: 'Riyals', minor: 'Halalas', label: 'Saudi Riyal (SAR)' },
    QAR: { symbol: 'QAR ', locale: 'en-US', system: 'intl', major: 'Riyals', minor: 'Dirhams', label: 'Qatari Riyal (QAR)' },
    USD: { symbol: '$', locale: 'en-US', system: 'intl', major: 'Dollars', minor: 'Cents', label: 'US Dollar ($)' },
    GBP: { symbol: '\u00A3', locale: 'en-GB', system: 'intl', major: 'Pounds', minor: 'Pence', label: 'British Pound (\u00A3)' },
    EUR: { symbol: '\u20AC', locale: 'en-IE', system: 'intl', major: 'Euros', minor: 'Cents', label: 'Euro (\u20AC)' },
    AUD: { symbol: 'A$', locale: 'en-AU', system: 'intl', major: 'Dollars', minor: 'Cents', label: 'Australian Dollar (A$)' },
    CAD: { symbol: 'C$', locale: 'en-CA', system: 'intl', major: 'Dollars', minor: 'Cents', label: 'Canadian Dollar (C$)' },
    SGD: { symbol: 'S$', locale: 'en-SG', system: 'intl', major: 'Dollars', minor: 'Cents', label: 'Singapore Dollar (S$)' },
    MYR: { symbol: 'RM ', locale: 'en-MY', system: 'intl', major: 'Ringgit', minor: 'Sen', label: 'Malaysian Ringgit (RM)' }
  };

  function currencyInfo(code) {
    return CURRENCIES[code] || CURRENCIES.INR;
  }

  /* ------------------------------------------------------------------ */
  /* Numbers                                                             */
  /* ------------------------------------------------------------------ */

  /** Lenient numeric parse: '' / null / garbage => 0, "1,234.5" => 1234.5 */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (v == null) return 0;
    var n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function round2(n) {
    return Math.round((num(n) + Number.EPSILON) * 100) / 100;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  var formatterCache = {};
  function getFormatter(locale, decimals) {
    var key = locale + ':' + decimals;
    if (!formatterCache[key]) {
      var opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
      try {
        formatterCache[key] = new Intl.NumberFormat(locale, opts);
      } catch (e) {
        formatterCache[key] = new Intl.NumberFormat('en', opts);
      }
    }
    return formatterCache[key];
  }

  function formatNumber(n, locale, decimals) {
    return getFormatter(locale || 'en-US', decimals == null ? 2 : decimals).format(num(n));
  }

  /** 123456.5, 'INR' => "₹1,23,456.50" */
  function formatMoney(n, currencyCode) {
    var c = currencyInfo(currencyCode);
    var v = round2(n);
    var sign = v < 0 ? '-' : '';
    return sign + c.symbol + formatNumber(Math.abs(v), c.locale, 2);
  }

  /** Weights are shown with 3 decimals (jewellers weigh to the milligram). */
  function formatWeight(n, decimals) {
    return formatNumber(n, 'en-US', decimals == null ? 3 : decimals);
  }

  /** 1.5 => "1.5%", 3 => "3%" */
  function formatPct(n) {
    return String(round2(n)) + '%';
  }

  function padNumber(n, width) {
    return String(n).padStart(width, '0');
  }

  /* ------------------------------------------------------------------ */
  /* Dates                                                               */
  /* ------------------------------------------------------------------ */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Local date as yyyy-mm-dd (what <input type="date"> expects). */
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** "2026-09-05" => "05 Sep 2026" */
  function formatDate(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return String(iso);
    return m[3] + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1];
  }

  /* ------------------------------------------------------------------ */
  /* Strings / misc                                                      */
  /* ------------------------------------------------------------------ */

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return ESC[ch]; });
  }

  function nl2br(s) {
    return escapeHtml(s).replace(/\r?\n/g, '<br>');
  }

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Amount in words                                                     */
  /* ------------------------------------------------------------------ */

  var ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  var TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function belowHundred(n) {
    if (n < 20) return ONES[n];
    var t = Math.floor(n / 10), o = n % 10;
    return TENS[t] + (o ? ' ' + ONES[o] : '');
  }

  function belowThousand(n) {
    var h = Math.floor(n / 100), r = n % 100, parts = [];
    if (h) parts.push(ONES[h] + ' Hundred');
    if (r) parts.push(belowHundred(r));
    return parts.join(' ');
  }

  // Indian system: thousand, lakh (1e5), crore (1e7); crores recurse.
  function wordsIndian(n) {
    if (n === 0) return 'Zero';
    var parts = [];
    var crore = Math.floor(n / 1e7); n %= 1e7;
    var lakh = Math.floor(n / 1e5); n %= 1e5;
    var thousand = Math.floor(n / 1e3); n %= 1e3;
    if (crore) parts.push(wordsIndian(crore) + ' Crore');
    if (lakh) parts.push(belowHundred(lakh) + ' Lakh');
    if (thousand) parts.push(belowHundred(thousand) + ' Thousand');
    if (n) parts.push(belowThousand(n));
    return parts.join(' ');
  }

  var SCALES = [[1e12, 'Trillion'], [1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  function wordsIntl(n) {
    if (n === 0) return 'Zero';
    var parts = [];
    SCALES.forEach(function (scale) {
      var q = Math.floor(n / scale[0]);
      if (q) {
        parts.push(belowThousand(q) + ' ' + scale[1]);
        n %= scale[0];
      }
    });
    if (n) parts.push(belowThousand(n));
    return parts.join(' ');
  }

  /** Integer part of `n` in words. system: 'indian' | 'intl' */
  function numberToWords(n, system) {
    n = Math.floor(Math.abs(num(n)));
    return system === 'indian' ? wordsIndian(n) : wordsIntl(n);
  }

  /** 1234.5, 'INR' => "Rupees One Thousand Two Hundred Thirty Four and Fifty Paise Only" */
  function amountInWords(amount, currencyCode) {
    var c = currencyInfo(currencyCode);
    var v = round2(amount);
    var negative = v < 0;
    v = Math.abs(v);
    var major = Math.floor(v);
    var minor = Math.round((v - major) * 100);
    if (minor === 100) { major += 1; minor = 0; }
    var out = c.major + ' ' + numberToWords(major, c.system);
    if (minor) out += ' and ' + numberToWords(minor, c.system) + ' ' + c.minor;
    out += ' Only';
    return (negative ? 'Minus ' : '') + out;
  }

  return {
    CURRENCIES: CURRENCIES,
    currencyInfo: currencyInfo,
    num: num,
    round2: round2,
    clamp: clamp,
    formatNumber: formatNumber,
    formatMoney: formatMoney,
    formatWeight: formatWeight,
    formatPct: formatPct,
    padNumber: padNumber,
    todayISO: todayISO,
    formatDate: formatDate,
    escapeHtml: escapeHtml,
    nl2br: nl2br,
    titleCase: titleCase,
    uid: uid,
    clone: clone,
    debounce: debounce,
    numberToWords: numberToWords,
    amountInWords: amountInWords
  };
}));
