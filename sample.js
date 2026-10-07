/* Drip — sample statement generator.
 *
 * Produces a real CSV string with genuinely messy descriptors, so the demo
 * exercises the actual parser and merchant resolver rather than bypassing
 * them. Deterministic, so the demo looks the same every time.
 */
(function (global) {
  'use strict';

  function LCG(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(d) {
    return pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + '/' + d.getUTCFullYear();
  }
  function addMonths(d, n) {
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  }

  /* Recurring services. `wrap` mimics how each actually appears on a statement. */
  var SUBS = [
    { desc: 'NETFLIX.COM 866-579-7172 CA',        amt: 15.49, every: 1, day: 4 },
    { desc: 'PAYPAL *SPOTIFY USA 4029357733',     amt: 11.99, every: 1, day: 9,
      hike: { at: 8, to: 13.99 } },
    { desc: 'AMZN Mktp US*2K4TY9 AMZN.COM/BILL',  amt: 42.18, every: 0 },
    { desc: 'Amazon Prime*MT8YU2 AMZN.COM/BILL',  amt: 14.99, every: 1, day: 17 },
    { desc: 'APPLE.COM/BILL 866-712-7753 CA',     amt: 2.99,  every: 1, day: 22 },
    { desc: 'ADOBE  *CREATIVE CLOUD 408-536-6000', amt: 59.99, every: 1, day: 12,
      hike: { at: 11, to: 69.99 } },
    { desc: 'POS DEBIT 0912 PLANET FITNESS #4471', amt: 24.99, every: 1, day: 1 },
    { desc: 'RECURRING PAYMENT AUTHORISED ON 04/15 NYTIMES*NYTIMES N', amt: 4.00, every: 1, day: 15 },
    { desc: 'GOOGLE *GOOGLE ONE g.co/helppay#',   amt: 2.99,  every: 1, day: 27 },
    { desc: 'DROPBOX*9RT2K8 DROPBOX.COM',          amt: 11.99, every: 1, day: 6 },
    { desc: 'ACH DEBIT VERIZON WIRELESS PMT',      amt: 88.32, every: 1, day: 20 },
    { desc: 'SQ *CROSSFIT NORTHSIDE 8452113',      amt: 149.00, every: 1, day: 3,
      stopAfter: 9 },
    { desc: 'AUDIBLE*4K9J2 AMZN.COM/BILL',         amt: 14.95, every: 1, day: 24 },
    { desc: 'NORDVPN NORDVPN.COM PANAMA',          amt: 99.00, every: 12, day: 8 },
    { desc: 'AMAZON PRIME MEMBERSHIP RENEWAL',     amt: 139.00, every: 12, day: 2 },
    { desc: 'STATE FARM INSURANCE PMT 8829471',    amt: 412.60, every: 6, day: 14 },
    { desc: 'PAYPAL *PATREON MEMBERSHIP',          amt: 5.00,  every: 1, day: 11 },
    { desc: 'MEDIUM.COM MONTHLY SUBSCRIPTION',     amt: 5.00,  every: 1, day: 19 },
    { desc: 'DD SPECTRUM INTERNET 8004943',        amt: 79.99, every: 1, day: 26 },
    { desc: 'OPENAI *CHATGPT SUBSCR HTTPSOPENAI.C', amt: 20.00, every: 1, day: 7 }
  ];

  /* Everyday spending with realistic descriptor noise. */
  var EVERYDAY = [
    ['SQ *BLUE BOTTLE COFFEE 8452113', 4.5, 8.5],
    ['STARBUCKS STORE #08812 SEATTLE WA', 3.8, 9.2],
    ['TST* THE CORNER BISTRO 445', 18, 74],
    ['WHOLE FOODS MKT #10259 AUSTIN TX', 22, 148],
    ['TRADER JOE S #558 QPS', 14, 96],
    ['POS DEBIT 4471 SHELL OIL 57445871', 32, 78],
    ['UBER   *TRIP HELP.UBER.COM', 8, 42],
    ['DOORDASH*CHIPOTLE 855-431-0459', 16, 48],
    ['TARGET        00021147 AUSTIN TX', 12, 210],
    ['CVS/PHARMACY #04471 Q03', 6, 64],
    ['AMZN Mktp US*RT8823K1 AMZN.COM/BILL', 9, 88],
    ['SQ *FARMERS MARKET STALL 12', 8, 36],
    ['MCDONALD S F8821 AUSTIN TX', 5, 18],
    ['HOME DEPOT #6541 AUSTIN TX', 15, 240],
    ['WALGREENS #04412 AUSTIN', 7, 52]
  ];

  var ONE_OFFS = [
    ['DELTA AIR LINES 0062418872244', 486.40],
    ['MARRIOTT HOTELS AUSTIN TX', 612.18],
    ['BEST BUY #1188 AUSTIN TX', 1249.99],
    ['AUSTIN AUTO REPAIR LLC', 884.22],
    ['APPLE STORE R412 AUSTIN TX', 1099.00]
  ];

  function generate(months) {
    months = months || 18;
    var rnd = LCG(20260809);
    var rows = [];
    var end = new Date();
    end = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    var start = addMonths(end, -months);
    var balance = 8420.55;

    function push(date, desc, amount) {
      if (date < start || date > end) return;
      rows.push({ d: date, desc: desc, amt: amount });
    }

    // Recurring services. Anchored to the first full month in range, so a
    // yearly charge whose billing day precedes the export start date is not
    // silently lost — that would hide exactly the annual subscriptions the
    // tool is meant to surface.
    var anchor = addMonths(new Date(Date.UTC(start.getUTCFullYear(),
                                             start.getUTCMonth(), 1)), 1);
    SUBS.forEach(function (s) {
      if (s.every === 0) return;
      var occurrences = Math.floor(months / s.every) + 1;
      for (var i = 0; i <= occurrences; i++) {
        if (s.stopAfter !== undefined && i >= s.stopAfter) break;
        var base = addMonths(anchor, i * s.every);
        var last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
        var d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(),
                                  Math.min(s.day, last)));
        // Banks post a day early or late fairly often.
        var slip = rnd() < 0.22 ? (rnd() < 0.5 ? -1 : 1) : 0;
        d = new Date(d.getTime() + slip * 86400000);
        var amt = s.amt;
        if (s.hike && i >= s.hike.at) amt = s.hike.to;
        push(d, s.desc, -amt);
      }
    });

    // Everyday spending, denser at weekends
    for (var day = 0; day < months * 30.44; day++) {
      var d = new Date(start.getTime() + day * 86400000);
      var dow = d.getUTCDay();
      var n = (dow === 0 || dow === 6) ? 2 + Math.floor(rnd() * 3)
                                       : Math.floor(rnd() * 3);
      for (var k = 0; k < n; k++) {
        var e = EVERYDAY[Math.floor(rnd() * EVERYDAY.length)];
        var amt = e[1] + rnd() * (e[2] - e[1]);
        push(d, e[0], -Math.round(amt * 100) / 100);
      }
    }

    // Salary, twice a month
    for (var m = 0; m <= months; m++) {
      var b = addMonths(start, m);
      push(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 15)),
           'DIRECT DEPOSIT PAYROLL NORTHWIND LLC', 3180.44);
      var lastD = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + 1, 0)).getUTCDate();
      push(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), lastD)),
           'DIRECT DEPOSIT PAYROLL NORTHWIND LLC', 3180.44);
    }

    // Rent
    for (var r = 0; r <= months; r++) {
      var rb = addMonths(start, r);
      push(new Date(Date.UTC(rb.getUTCFullYear(), rb.getUTCMonth(), 1)),
           'ACH DEBIT OAKRIDGE PROPERTY MGMT RENT', -2150.00);
    }

    // A handful of large one-offs
    ONE_OFFS.forEach(function (o, i) {
      var d = new Date(start.getTime() +
        (0.15 + 0.17 * i) * months * 30.44 * 86400000);
      push(d, o[0], -o[1]);
    });

    rows.sort(function (a, b) { return a.d - b.d; });

    var out = ['Transaction Date,Description,Amount,Running Balance'];
    rows.forEach(function (r) {
      balance += r.amt;
      out.push([
        fmt(r.d),
        '"' + r.desc.replace(/"/g, '""') + '"',
        r.amt.toFixed(2),
        balance.toFixed(2)
      ].join(','));
    });
    return out.join('\n');
  }

  global.DripSample = { generate: generate };
})(window);
