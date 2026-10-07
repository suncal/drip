/* Drip — bank file parsing.
 *
 * Every bank exports a different shape, so nothing here is configured by the
 * user: delimiter, header row, column roles, date format and sign convention
 * are all inferred from the data. The two inferences that silently produce
 * wrong answers if you get them lazy are DD/MM vs MM/DD and which sign means
 * "money left the account" — both are decided by scanning the whole file for
 * evidence rather than guessing from the first row.
 *
 * Supports: CSV/TSV (any bank) and OFX/QFX (Quicken/Money exports).
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------ CSV core */

  function detectDelimiter(text) {
    var sample = text.split(/\r?\n/).slice(0, 40).join('\n');
    var best = ',', bestScore = -1;
    [',', ';', '\t', '|'].forEach(function (d) {
      var counts = sample.split(/\r?\n/).filter(function (l) { return l.trim(); })
        .map(function (l) { return splitLine(l, d).length; });
      if (counts.length < 2) return;
      // A real delimiter yields a consistent, greater-than-one column count.
      var mode = {}, top = 0, topN = 0;
      counts.forEach(function (c) { mode[c] = (mode[c] || 0) + 1; });
      Object.keys(mode).forEach(function (k) {
        if (mode[k] > topN) { topN = mode[k]; top = +k; }
      });
      var score = top > 1 ? top * (topN / counts.length) : 0;
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }

  function splitLine(line, delim) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === delim) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  function parseCsvRows(text, delim) {
    // Handle quoted fields containing newlines by walking the whole text.
    var rows = [], row = [], cur = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === delim) {
        row.push(cur.trim()); cur = '';
      } else if (ch === '\n') {
        row.push(cur.trim()); cur = '';
        if (row.some(function (c) { return c !== ''; })) rows.push(row);
        row = [];
      } else if (ch !== '\r') {
        cur += ch;
      }
    }
    row.push(cur.trim());
    if (row.some(function (c) { return c !== ''; })) rows.push(row);
    return rows;
  }

  /* --------------------------------------------------------------- dates */

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7,
                 aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  // Returns {y, m, d} candidates without committing to DD/MM vs MM/DD.
  function dateParts(s) {
    if (!s) return null;
    var t = String(s).trim().replace(/^["']|["']$/g, '');
    var m;

    // ISO: 2026-08-05 (unambiguous)
    m = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) return { y: +m[1], a: +m[2], b: +m[3], iso: true };

    // 05 Aug 2026 / 05-Aug-26 / Aug 5, 2026 (unambiguous)
    m = t.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/](\d{2,4})/);
    if (m && MONTHS[m[2].toLowerCase().slice(0, 4)] || (m && MONTHS[m[2].toLowerCase().slice(0, 3)])) {
      var mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
      return { y: fullYear(+m[3]), a: mo, b: +m[1], iso: true, monthName: true };
    }
    m = t.match(/^([A-Za-z]{3,9})[\s\-\/](\d{1,2}),?[\s\-\/](\d{2,4})/);
    if (m) {
      var mo2 = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)];
      if (mo2) return { y: fullYear(+m[3]), a: mo2, b: +m[2], iso: true, monthName: true };
    }

    // Ambiguous numeric: 05/08/2026 — a and b resolved later, file-wide.
    m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
    if (m) return { y: fullYear(+m[3]), a: +m[1], b: +m[2], iso: false };

    // Compact: 20260805
    m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return { y: +m[1], a: +m[2], b: +m[3], iso: true };

    return null;
  }

  function fullYear(y) {
    if (y >= 1000) return y;
    return y < 70 ? 2000 + y : 1900 + y;
  }

  /* Decide, across the whole file, whether ambiguous numeric dates are
     day-first or month-first. Any value >12 in a position settles it; with no
     evidence either way we fall back to month-first and say so. */
  function resolveDateOrder(partsList) {
    var aOver12 = 0, bOver12 = 0;
    partsList.forEach(function (p) {
      if (!p || p.iso) return;
      if (p.a > 12) aOver12++;
      if (p.b > 12) bOver12++;
    });
    if (aOver12 && !bOver12) return { dayFirst: true, certain: true };
    if (bOver12 && !aOver12) return { dayFirst: false, certain: true };
    if (aOver12 && bOver12) return { dayFirst: false, certain: false, conflict: true };
    return { dayFirst: false, certain: false };
  }

  function toDate(p, dayFirst) {
    if (!p) return null;
    var mo = p.iso ? p.a : (dayFirst ? p.b : p.a);
    var day = p.iso ? p.b : (dayFirst ? p.a : p.b);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    var d = new Date(Date.UTC(p.y, mo - 1, day));
    return isNaN(d.getTime()) ? null : d;
  }

  /* ------------------------------------------------------------- amounts */

  function parseAmount(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;

    var neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/(^|\s)(DR|debit)\b/i.test(s)) neg = true;
    if (/(^|\s)(CR|credit)\b/i.test(s)) neg = false;
    s = s.replace(/\b(DR|CR|debit|credit)\b/gi, '');
    s = s.replace(/[^\d.,\-+]/g, '');           // strip currency symbols/spaces
    if (/^-/.test(s)) { neg = true; s = s.slice(1); }
    if (/^\+/.test(s)) s = s.slice(1);
    if (!s) return null;

    // Decide which separator is the decimal point.
    var lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma > -1) {
      // "1,234" is thousands; "12,34" is European decimal.
      var after = s.length - lastComma - 1;
      s = (after === 3 && s.indexOf(',') === lastComma && s.length > 4)
        ? s.replace(/,/g, '') : s.replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }

    var v = parseFloat(s);
    if (isNaN(v)) return null;
    return neg ? -Math.abs(v) : v;
  }

  /* --------------------------------------------------- column role guess */

  var HDR = {
    date: /^(transaction\s*date|posting\s*date|posted|date|dt|value\s*date|book(ing)?\s*date|completed\s*date|trans\.?\s*date)$/i,
    desc: /^(description|desc|details|narrative|payee|merchant|name|memo|transaction|particulars|reference|to\/from|counterparty)$/i,
    amount: /^(amount|amt|value|transaction\s*amount|sum)$/i,
    debit: /^(debit|withdrawal(s)?|money\s*out|paid\s*out|charge(s)?|spent)$/i,
    credit: /^(credit|deposit(s)?|money\s*in|paid\s*in|received)$/i,
    balance: /^(balance|running\s*balance|bal)$/i,
    currency: /^(currency|ccy|curr)$/i
  };

  function looksLikeHeader(cells) {
    if (!cells) return false;
    var alpha = cells.filter(function (c) { return /[a-z]/i.test(c); }).length;
    var known = cells.filter(function (c) {
      return Object.keys(HDR).some(function (k) { return HDR[k].test(c); });
    }).length;
    var dated = cells.filter(function (c) { return dateParts(c); }).length;
    return known >= 2 || (alpha >= Math.max(2, cells.length - 1) && dated === 0);
  }

  function inferColumns(header, rows) {
    var roles = {};
    if (header) {
      header.forEach(function (h, i) {
        Object.keys(HDR).forEach(function (role) {
          if (roles[role] === undefined && HDR[role].test(h)) roles[role] = i;
        });
      });
    }

    var n = (header || rows[0] || []).length;
    var stats = [];
    for (var c = 0; c < n; c++) {
      var dateHits = 0, numHits = 0, textLen = 0, filled = 0;
      rows.slice(0, 300).forEach(function (r) {
        var v = r[c];
        if (v == null || v === '') return;
        filled++;
        if (dateParts(v)) dateHits++;
        if (parseAmount(v) !== null && /\d/.test(v)) numHits++;
        if (/[a-z]{3,}/i.test(v)) textLen += v.length;
      });
      stats.push({ i: c, dateHits: dateHits, numHits: numHits,
                   textLen: textLen, filled: filled });
    }

    if (roles.date === undefined) {
      var d = stats.slice().sort(function (a, b) { return b.dateHits - a.dateHits; })[0];
      if (d && d.dateHits > 0) roles.date = d.i;
    }
    if (roles.desc === undefined) {
      var t = stats.slice().sort(function (a, b) { return b.textLen - a.textLen; })[0];
      if (t && t.textLen > 0) roles.desc = t.i;
    }
    if (roles.amount === undefined && roles.debit === undefined) {
      var cands = stats.filter(function (s) {
        return s.i !== roles.date && s.i !== roles.desc &&
               s.numHits > s.filled * 0.7 && s.filled > 0;
      });
      // Prefer the column that isn't a monotonic running balance.
      cands.sort(function (a, b) { return b.numHits - a.numHits; });
      if (cands.length) {
        var pick = cands[0];
        if (cands.length > 1 && roles.balance === undefined) {
          var mono = cands.map(function (s) {
            return { i: s.i, score: monotonicity(rows, s.i) };
          }).sort(function (a, b) { return a.score - b.score; });
          pick = { i: mono[0].i };
          roles.balance = mono[mono.length - 1].score > 0.75 ? mono[mono.length - 1].i : roles.balance;
        }
        roles.amount = pick.i;
      }
    }
    return roles;
  }

  function monotonicity(rows, col) {
    var vals = [], prev = null, same = 0, tot = 0;
    rows.slice(0, 200).forEach(function (r) {
      var v = parseAmount(r[col]);
      if (v === null) return;
      vals.push(v);
    });
    for (var i = 1; i < vals.length; i++) {
      tot++;
      if (Math.abs(vals[i] - vals[i - 1]) < Math.abs(vals[i]) * 0.5) same++;
    }
    return tot ? same / tot : 0;
  }

  /* --------------------------------------------------------------- OFX */

  function parseOfx(text, fileName) {
    var txns = [];
    var blocks = text.split(/<STMTTRN>/i).slice(1);
    blocks.forEach(function (b, idx) {
      var body = b.split(/<\/STMTTRN>/i)[0];
      var get = function (tag) {
        var m = body.match(new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i'));
        return m ? m[1].trim() : '';
      };
      var dt = get('DTPOSTED') || get('DTUSER');
      var amt = parseAmount(get('TRNAMT'));
      var name = [get('NAME'), get('MEMO')].filter(Boolean).join(' — ');
      if (!dt || amt === null) return;
      var p = dateParts(dt.slice(0, 8));
      var d = toDate(p, false);
      if (!d) return;
      txns.push({
        date: d, amount: amt, description: name || '(no description)',
        raw: body.replace(/\s+/g, ' ').trim().slice(0, 400),
        source: fileName, line: idx + 1
      });
    });
    return txns;
  }

  /* ------------------------------------------------------------- driver */

  function parseFile(text, fileName) {
    var warnings = [];

    if (/<OFX>|<STMTTRN>/i.test(text.slice(0, 4000))) {
      var t = parseOfx(text, fileName);
      if (!t.length) throw new Error('No transactions found in this OFX/QFX file.');
      return { transactions: t, warnings: warnings, format: 'OFX/QFX' };
    }

    var delim = detectDelimiter(text);
    var rows = parseCsvRows(text, delim);
    if (rows.length < 2) throw new Error('This file has no readable rows.');

    // Skip bank preamble lines until a plausible header or data row.
    var start = 0;
    for (var i = 0; i < Math.min(rows.length, 25); i++) {
      if (rows[i].length >= 2 && (looksLikeHeader(rows[i]) ||
          rows[i].some(function (c) { return dateParts(c); }))) { start = i; break; }
    }

    var header = looksLikeHeader(rows[start]) ? rows[start] : null;
    var body = rows.slice(header ? start + 1 : start).filter(function (r) {
      return r.length >= 2 && r.some(function (c) { return c !== ''; });
    });
    if (!body.length) throw new Error('No data rows found under the header.');

    var roles = inferColumns(header, body);
    if (roles.date === undefined) throw new Error('Could not find a date column.');
    if (roles.amount === undefined && roles.debit === undefined) {
      throw new Error('Could not find an amount column.');
    }

    var partsList = body.map(function (r) { return dateParts(r[roles.date]); });
    var order = resolveDateOrder(partsList);
    if (order.conflict) {
      warnings.push('Dates in ' + fileName + ' are inconsistent — some look ' +
                    'day-first and some month-first. Treating as month-first.');
    } else if (!order.certain) {
      warnings.push('Date order in ' + fileName + ' is ambiguous (no day above ' +
                    '12 anywhere). Assuming month-first (US style).');
    }

    var txns = [];
    body.forEach(function (r, idx) {
      var d = toDate(partsList[idx], order.dayFirst);
      if (!d) return;
      var amt = null;
      if (roles.amount !== undefined) {
        amt = parseAmount(r[roles.amount]);
      }
      if (amt === null && roles.debit !== undefined) {
        var deb = parseAmount(r[roles.debit]);
        var cre = roles.credit !== undefined ? parseAmount(r[roles.credit]) : null;
        if (deb) amt = -Math.abs(deb);
        else if (cre) amt = Math.abs(cre);
      }
      if (amt === null || amt === 0) return;

      var desc = roles.desc !== undefined ? r[roles.desc] : '';
      if (!desc) {
        desc = r.filter(function (c, ci) {
          return ci !== roles.date && ci !== roles.amount &&
                 ci !== roles.balance && /[a-z]{3,}/i.test(c);
        }).join(' ');
      }
      txns.push({
        date: d, amount: amt, description: desc || '(no description)',
        raw: r.join(delim === '\t' ? ' | ' : delim),
        source: fileName, line: idx + (header ? 2 : 1) + start
      });
    });

    if (!txns.length) throw new Error('Rows were found but none could be read as transactions.');

    // Sign convention: in a spending account most transactions are outgoings.
    // If this file has them as positives, flip so negative always means "out".
    var negs = txns.filter(function (t) { return t.amount < 0; }).length;
    if (negs < txns.length * 0.25 && roles.debit === undefined) {
      var hasBalance = roles.balance !== undefined;
      txns.forEach(function (t) { t.amount = -t.amount; });
      warnings.push('Amounts in ' + fileName + ' were mostly positive, so they ' +
                    'were read as money going out.' +
                    (hasBalance ? '' : ' Check a couple of rows if that looks wrong.'));
    }

    return { transactions: txns, warnings: warnings,
             format: 'CSV (delimiter "' + (delim === '\t' ? 'tab' : delim) + '")',
             columns: roles, header: header };
  }

  global.DripParse = {
    parseFile: parseFile,
    parseAmount: parseAmount,
    dateParts: dateParts,
    toDate: toDate,
    detectDelimiter: detectDelimiter
  };
})(window);
