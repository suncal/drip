/* Drip — recurrence and anomaly detection.
 *
 * The core is the same robust-statistics approach used for detecting periodic
 * network callbacks: measure the median gap between events and the *median
 * absolute deviation* of those gaps, rather than the mean and standard
 * deviation. One skipped month, a retry, or a bank posting a charge two days
 * late destroys a standard-deviation score while leaving MAD essentially
 * untouched — and real subscriptions skip, retry and post late constantly.
 *
 * Calendar months are handled separately from day-gaps, because "the 5th of
 * every month" produces gaps of 28, 30 and 31 days that look irregular in days
 * but are perfectly regular in months.
 */
(function (global) {
  'use strict';

  var DAY = 86400000;

  /* ------------------------------------------------------- statistics */

  function median(xs) {
    if (!xs.length) return 0;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function mad(xs) {
    if (!xs.length) return 0;
    var m = median(xs);
    return median(xs.map(function (x) { return Math.abs(x - m); }));
  }

  function percentile(xs, p) {
    if (!xs.length) return 0;
    var s = xs.slice().sort(function (a, b) { return a - b; });
    var k = (s.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k);
    return lo === hi ? s[lo] : s[lo] * (hi - k) + s[hi] * (k - lo);
  }

  function clamp(x, lo, hi) {
    return Math.max(lo === undefined ? 0 : lo, Math.min(hi === undefined ? 1 : hi, x));
  }

  function monthIndex(d) { return d.getUTCFullYear() * 12 + d.getUTCMonth(); }

  function addMonths(d, n) {
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  }

  /* --------------------------------------------------------- cadence */

  var CADENCES = [
    { key: 'weekly',      label: 'Weekly',        days: 7,      tol: 2 },
    { key: 'fortnightly', label: 'Every 2 weeks', days: 14,     tol: 3 },
    { key: 'fourweekly',  label: 'Every 4 weeks', days: 28,     tol: 2.5 },
    { key: 'monthly',     label: 'Monthly',       days: 30.44,  tol: 5 },
    { key: 'bimonthly',   label: 'Every 2 months', days: 60.9,  tol: 8 },
    { key: 'quarterly',   label: 'Quarterly',     days: 91.3,   tol: 10 },
    { key: 'semiannual',  label: 'Twice a year',  days: 182.6,  tol: 16 },
    { key: 'annual',      label: 'Yearly',        days: 365.25, tol: 24 }
  ];

  /* Two charges is not enough to measure regularity — but for long cadences
     it is often all the data there is. An 18-month export contains exactly two
     yearly renewals, and yearly subscriptions are precisely the ones people
     forget. So a pair is accepted when the gap lands on a long cadence and the
     amounts match, with the confidence reduced accordingly and the reasoning
     shown in the UI. */
  function detectPair(dates, amounts) {
    if (dates.length !== 2) return null;
    var gapDays = (dates[1] - dates[0]) / DAY;
    if (gapDays < 150) return null;                 // short cadences need 3+
    var cad = null;
    CADENCES.forEach(function (c) {
      if (c.days < 150) return;
      if (Math.abs(gapDays - c.days) <= c.tol && (!cad || c.days > cad.days)) cad = c;
    });
    if (!cad) return null;

    var a0 = amounts[0], a1 = amounts[1];
    var same = Math.abs(a1 - a0) <= Math.max(0.5, Math.abs(a0) * 0.15);
    if (!same) return null;

    var fit = clamp(1 - Math.abs(gapDays - cad.days) / cad.tol);
    return {
      cadence: cad, medGap: cad.days, gapMad: 0,
      regularity: 0.5 + 0.25 * fit,     // capped: two points can't prove more
      calendar: cad.days > 300,
      dayOfMonth: median(dates.map(function (d) { return d.getUTCDate(); })),
      fromPair: true
    };
  }

  function detectCadence(dates) {
    if (dates.length < 3) return null;

    var gaps = [];
    for (var i = 1; i < dates.length; i++) {
      gaps.push((dates[i] - dates[i - 1]) / DAY);
    }
    var medGap = median(gaps);
    if (medGap < 4 || medGap > 420) return null;
    var gapMad = mad(gaps);

    // Calendar-aware check first: a fixed day-of-month beats day arithmetic.
    var mi = dates.map(monthIndex);
    var miGaps = [];
    for (var j = 1; j < mi.length; j++) miGaps.push(mi[j] - mi[j - 1]);
    var medMi = median(miGaps), miMad = mad(miGaps);
    var doms = dates.map(function (d) { return d.getUTCDate(); });
    var domMad = mad(doms);

    var monthly = { 1: 'monthly', 2: 'bimonthly', 3: 'quarterly',
                    6: 'semiannual', 12: 'annual' };
    if (miMad === 0 && monthly[medMi] && domMad <= 4) {
      var cad = CADENCES.filter(function (c) { return c.key === monthly[medMi]; })[0];
      // Day-of-month consistency is the regularity measure in this branch.
      var reg = clamp(1 - domMad / 5);
      return { cadence: cad, medGap: cad.days, gapMad: gapMad,
               regularity: reg, calendar: true, dayOfMonth: median(doms) };
    }

    var best = null;
    CADENCES.forEach(function (c) {
      var err = Math.abs(medGap - c.days);
      if (err > c.tol) return;
      var reg = clamp(1 - (gapMad / (c.tol * 0.9)));
      var fit = clamp(1 - err / c.tol);
      var score = reg * 0.65 + fit * 0.35;
      if (!best || score > best.score) {
        best = { cadence: c, medGap: medGap, gapMad: gapMad,
                 regularity: reg, calendar: false, score: score };
      }
    });
    return best;
  }

  /* ---------------------------------------------------- price changes */

  /* Cluster amounts into price points. Only meaningful for fixed-price
     series, so the caller checks stability before trusting the result. */
  function pricePoints(amounts) {
    var pts = [];
    amounts.forEach(function (a) {
      var hit = null;
      for (var i = 0; i < pts.length; i++) {
        var ref = pts[i].value;
        if (Math.abs(a - ref) <= Math.max(0.25, Math.abs(ref) * 0.015)) {
          hit = pts[i]; break;
        }
      }
      if (hit) { hit.count++; hit.value = (hit.value * (hit.count - 1) + a) / hit.count; }
      else pts.push({ value: a, count: 1 });
    });
    return pts;
  }

  function detectPriceChange(txns) {
    var amounts = txns.map(function (t) { return Math.abs(t.amount); });
    var pts = pricePoints(amounts);
    if (pts.length < 2 || pts.length > 4) return null;

    // Walk forward; a genuine price change is a step that then persists.
    var runs = [];
    amounts.forEach(function (a, i) {
      var last = runs[runs.length - 1];
      if (last && Math.abs(a - last.value) <= Math.max(0.25, last.value * 0.015)) {
        last.count++;
        last.value = (last.value * (last.count - 1) + a) / last.count;
        last.endIndex = i;
      } else {
        runs.push({ value: a, count: 1, startIndex: i, endIndex: i });
      }
    });
    if (runs.length < 2) return null;

    var first = runs[0], last = runs[runs.length - 1];
    // Require the new price to have held for at least two charges, so a single
    // odd month (proration, a refund, a partial credit) is not called a rise.
    if (last.count < 2) return null;
    var delta = last.value - first.value;
    if (Math.abs(delta) < Math.max(0.5, first.value * 0.02)) return null;

    return {
      from: first.value,
      to: last.value,
      delta: delta,
      pct: first.value ? (delta / first.value) * 100 : 0,
      changedAt: txns[last.startIndex].date,
      steps: runs.length - 1
    };
  }

  /* --------------------------------------------------------- grouping */

  /* Bills you are largely stuck with, versus subscriptions you could cancel
     this afternoon. Mixing them makes the headline number useless: rent will
     always dwarf everything and drown out the actionable part. */
  var ESSENTIAL = new Set(['Housing', 'Utilities', 'Insurance',
    'Phone & internet', 'Loans & credit', 'Childcare & school']);

  function groupByMerchant(txns) {
    var groups = {};
    txns.forEach(function (t) {
      if (t.amount >= 0) return;                    // only money going out
      var r = global.DripMerchants.resolve(t.description);
      t.merchant = r.name;
      t.category = r.category;
      t.known = r.matched;
      (groups[r.name] = groups[r.name] || []).push(t);
    });

    // Merge near-duplicate merchant labels produced by messy descriptors.
    var merged = global.DripMerchants.mergeSimilar(Object.keys(groups));
    var out = {};
    Object.keys(groups).forEach(function (name) {
      var target = merged[name] || name;
      (out[target] = out[target] || []).push.apply(out[target], groups[name]);
      if (target !== name) {
        groups[name].forEach(function (t) { t.merchant = target; });
      }
    });
    Object.keys(out).forEach(function (k) {
      out[k].sort(function (a, b) { return a.date - b.date; });
    });
    return out;
  }

  /* One merchant often bills several different things: Apple, Google and
     PayPal descriptors bundle every subscription behind them, and a service
     may run monthly and yearly plans side by side. Left merged, the amounts
     look erratic and nothing is detected. So a group whose amounts form
     clearly separated clusters is split into independent series. */
  function splitByAmount(txns) {
    if (txns.length < 4) return [txns];

    var clusters = [];
    txns.forEach(function (t) {
      var a = Math.abs(t.amount), hit = null;
      for (var i = 0; i < clusters.length; i++) {
        var ref = clusters[i].value;
        if (Math.abs(a - ref) <= Math.max(0.5, ref * 0.06)) { hit = clusters[i]; break; }
      }
      if (hit) {
        hit.items.push(t);
        hit.value = (hit.value * (hit.items.length - 1) + a) / hit.items.length;
      } else {
        clusters.push({ value: a, items: [t] });
      }
    });

    var solid = clusters.filter(function (c) { return c.items.length >= 2; });
    if (solid.length < 2) return [txns];

    // Only split when the price points are genuinely far apart — otherwise
    // this is just normal variation in a variable-amount charge.
    solid.sort(function (a, b) { return a.value - b.value; });
    for (var j = 1; j < solid.length; j++) {
      if (solid[j].value < solid[j - 1].value * 1.35) return [txns];
    }
    // Strays that matched no cluster join the nearest one.
    clusters.filter(function (c) { return c.items.length < 2; })
      .forEach(function (c) {
        var near = solid.reduce(function (best, s) {
          return Math.abs(s.value - c.value) < Math.abs(best.value - c.value) ? s : best;
        }, solid[0]);
        near.items = near.items.concat(c.items);
      });

    return solid.map(function (c) {
      return c.items.sort(function (a, b) { return a.date - b.date; });
    });
  }

  /* ---------------------------------------------------------- analyse */

  function analyse(txns, opts) {
    opts = opts || {};
    if (!txns.length) throw new Error('No transactions to analyse.');

    var sorted = txns.slice().sort(function (a, b) { return a.date - b.date; });
    var firstDate = sorted[0].date, lastDate = sorted[sorted.length - 1].date;
    var spanDays = Math.max(1, (lastDate - firstDate) / DAY);
    var today = new Date();
    // Predictions run from the later of "today" and the end of the statements,
    // so an old export doesn't produce renewal dates in the past.
    var horizon = today > lastDate ? today : lastDate;

    var groups = groupByMerchant(sorted);
    var recurring = [], oneOff = [];

    var series = [];
    Object.keys(groups).forEach(function (name) {
      var parts = splitByAmount(groups[name]);
      parts.forEach(function (p, i) {
        series.push({ name: name, txns: p, split: parts.length > 1, index: i });
      });
    });

    series.forEach(function (s) {
      var name = s.name;
      var g = s.txns;
      var dates = g.map(function (t) { return t.date; });
      var amounts = g.map(function (t) { return Math.abs(t.amount); });
      var total = amounts.reduce(function (a, b) { return a + b; }, 0);
      var medAmt = median(amounts);
      var amtMad = mad(amounts);
      var stability = medAmt > 0 ? clamp(1 - amtMad / medAmt) : 0;

      var cad = detectCadence(dates) || detectPair(dates, amounts);
      var entry = {
        merchant: name + (s.split ? ' · ' + medAmt.toFixed(2) + ' plan' : ''),
        baseMerchant: name,
        splitPlan: s.split,
        category: g[0].category,
        known: g.some(function (t) { return t.known; }),
        txns: g,
        count: g.length,
        total: total,
        median: medAmt,
        stability: stability,
        first: dates[0],
        last: dates[dates.length - 1],
        sources: Array.from(new Set(g.map(function (t) { return t.source; })))
      };

      if (!cad || cad.regularity < 0.35) {
        entry.recurring = false;
        oneOff.push(entry);
        return;
      }

      // Confidence: how regular the timing is, how stable the price is, and
      // how many charges we have seen. Timing dominates.
      var volume = clamp((g.length - 2) / 8);
      entry.confidence = clamp(0.55 * cad.regularity + 0.25 * stability + 0.20 * volume);
      if (entry.confidence < 0.45) { entry.recurring = false; oneOff.push(entry); return; }

      entry.recurring = true;
      entry.cadence = cad.cadence.key;
      entry.cadenceLabel = cad.cadence.label;
      entry.periodDays = cad.medGap;
      entry.regularity = cad.regularity;
      entry.dayOfMonth = cad.dayOfMonth;
      entry.monthlyCost = medAmt * (30.44 / cad.cadence.days);
      entry.annualCost = medAmt * (365.25 / cad.cadence.days);

      // Next charge, projected forward past the end of the statements.
      var next = cad.calendar
        ? addMonths(entry.last, Math.round(cad.cadence.days / 30.44))
        : new Date(entry.last.getTime() + cad.cadence.days * DAY);
      var guard = 0;
      while (next < horizon && guard++ < 400) {
        next = cad.calendar
          ? addMonths(next, Math.round(cad.cadence.days / 30.44))
          : new Date(next.getTime() + cad.cadence.days * DAY);
      }
      entry.nextCharge = next;
      entry.daysToNext = Math.round((next - horizon) / DAY);

      // Active if the most recent charge is within a period and a half of the
      // end of the data — otherwise it looks cancelled.
      var sinceLast = (lastDate - entry.last) / DAY;
      entry.active = sinceLast <= cad.cadence.days * 1.5 + 7;
      entry.daysSinceLast = Math.round((horizon - entry.last) / DAY);

      if (stability > 0.6) entry.priceChange = detectPriceChange(g);
      entry.startedRecently = (lastDate - entry.first) / DAY <= 100;
      entry.runningMonths = Math.round((entry.last - entry.first) / DAY / 30.44);
      entry.fromPair = !!cad.fromPair;
      entry.essential = ESSENTIAL.has(entry.category);

      recurring.push(entry);
    });

    recurring.sort(function (a, b) { return b.annualCost - a.annualCost; });
    oneOff.sort(function (a, b) { return b.total - a.total; });

    var active = recurring.filter(function (r) { return r.active; });
    var stopped = recurring.filter(function (r) { return !r.active; });
    var subs = active.filter(function (r) { return !r.essential; });
    var bills = active.filter(function (r) { return r.essential; });

    var sum = function (list, key) {
      return list.reduce(function (s, r) { return s + r[key]; }, 0);
    };
    var monthlyTotal = sum(active, 'monthlyCost');
    var annualTotal = sum(active, 'annualCost');
    var subsMonthly = sum(subs, 'monthlyCost');
    var subsAnnual = sum(subs, 'annualCost');
    var billsMonthly = sum(bills, 'monthlyCost');
    var billsAnnual = sum(bills, 'annualCost');

    var hikes = active.filter(function (r) {
      return r.priceChange && r.priceChange.delta > 0;
    }).sort(function (a, b) { return b.priceChange.delta - a.priceChange.delta; });
    var hikeAnnual = hikes.reduce(function (s, r) {
      return s + r.priceChange.delta * (365.25 / (r.periodDays || 30.44));
    }, 0);

    // "Due soon" is only useful if it isn't every monthly subscription you own.
    // What actually catches people out is the infrequent renewal — the yearly
    // one you forgot about — plus anything landing in the next few days.
    var upcoming = active.filter(function (r) {
      if (r.daysToNext < 0 || r.daysToNext > 60) return false;
      var infrequent = r.periodDays > 60;
      return infrequent || r.daysToNext <= 7;
    }).sort(function (a, b) { return a.daysToNext - b.daysToNext; });

    // Cheap and long-running is the profile of the ones people forget.
    // Bills are excluded — nobody forgets the electricity.
    var forgettable = subs.filter(function (r) {
      return r.median <= 25 && r.runningMonths >= 9;
    }).sort(function (a, b) { return b.annualCost - a.annualCost; });

    var byCategory = {};
    subs.forEach(function (r) {
      (byCategory[r.category] = byCategory[r.category] || []).push(r);
    });
    var overlaps = Object.keys(byCategory).filter(function (c) {
      return c !== 'Other' && byCategory[c].length >= 2;
    }).map(function (c) {
      return {
        category: c,
        items: byCategory[c].sort(function (a, b) { return b.annualCost - a.annualCost; }),
        monthly: byCategory[c].reduce(function (s, r) { return s + r.monthlyCost; }, 0)
      };
    }).sort(function (a, b) { return b.monthly - a.monthly; });

    // Outlier one-off charges, measured against this account's own history
    // rather than a fixed threshold.
    var outAmounts = sorted.filter(function (t) { return t.amount < 0; })
      .map(function (t) { return Math.abs(t.amount); });
    var p99 = percentile(outAmounts, 0.99);
    var medOut = median(outAmounts);
    var recurringNames = new Set(recurring.map(function (r) { return r.merchant; }));
    var unusual = sorted.filter(function (t) {
      return t.amount < 0 && Math.abs(t.amount) >= p99 &&
             Math.abs(t.amount) > medOut * 8 && !recurringNames.has(t.merchant);
    }).sort(function (a, b) { return a.amount - b.amount; }).slice(0, 12);

    var totalOut = outAmounts.reduce(function (a, b) { return a + b; }, 0);

    return {
      transactions: sorted,
      firstDate: firstDate, lastDate: lastDate, spanDays: spanDays,
      horizon: horizon,
      recurring: recurring, active: active, stopped: stopped, oneOff: oneOff,
      subs: subs, bills: bills,
      subsMonthly: subsMonthly, subsAnnual: subsAnnual,
      billsMonthly: billsMonthly, billsAnnual: billsAnnual,
      monthlyTotal: monthlyTotal, annualTotal: annualTotal,
      hikes: hikes, hikeAnnual: hikeAnnual,
      upcoming: upcoming, forgettable: forgettable, overlaps: overlaps,
      unusual: unusual,
      totalOut: totalOut,
      recurringShare: totalOut > 0
        ? active.reduce(function (s, r) {
            return s + r.txns.reduce(function (x, t) { return x + Math.abs(t.amount); }, 0);
          }, 0) / totalOut
        : 0,
      stats: { median: medOut, p99: p99, count: sorted.length }
    };
  }

  global.DripAnalyze = {
    analyse: analyse,
    detectCadence: detectCadence,
    detectPriceChange: detectPriceChange,
    median: median, mad: mad, percentile: percentile
  };
})(window);
