/* Drip — UI.
 *
 * Every number on screen expands to the exact statement rows behind it. If a
 * tool tells you to cancel something, you should be able to see the charges it
 * based that on without leaving the page.
 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  var CUR = '$';
  var STATE = null;

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function money(v, dp) {
    var n = Math.abs(v);
    var s = n.toLocaleString(undefined, {
      minimumFractionDigits: dp === undefined ? 2 : dp,
      maximumFractionDigits: dp === undefined ? 2 : dp
    });
    return (v < 0 ? '-' : '') + CUR + s;
  }
  function money0(v) { return money(v, 0); }

  function fdate(d) {
    if (!d) return '—';
    return d.toLocaleDateString(undefined,
      { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fshort(d) {
    if (!d) return '—';
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  }
  function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }

  function detectCurrency(text) {
    var counts = { '£': 0, '€': 0, '₹': 0, '$': 0 };
    var sample = text.slice(0, 20000);
    Object.keys(counts).forEach(function (c) {
      counts[c] = (sample.split(c).length - 1);
    });
    if (/\bGBP\b/i.test(sample)) counts['£'] += 20;
    if (/\bEUR\b/i.test(sample)) counts['€'] += 20;
    if (/\bINR\b/i.test(sample)) counts['₹'] += 20;
    if (/\bUSD\b/i.test(sample)) counts['$'] += 20;
    var best = '$', bestN = 0;
    Object.keys(counts).forEach(function (c) {
      if (counts[c] > bestN) { bestN = counts[c]; best = c; }
    });
    return bestN > 0 ? best : '$';
  }

  /* ------------------------------------------------------------ intake */

  function readFiles(files) {
    var jobs = Array.prototype.slice.call(files).map(function (f) {
      return new Promise(function (resolve) {
        var r = new FileReader();
        r.onload = function () { resolve({ name: f.name, text: String(r.result) }); };
        r.onerror = function () { resolve({ name: f.name, text: null }); };
        r.readAsText(f);
      });
    });
    Promise.all(jobs).then(function (docs) { ingest(docs); });
  }

  function ingest(docs) {
    var all = [], warnings = [], errors = [], formats = [];
    var currencySample = '';

    docs.forEach(function (d) {
      if (d.text == null) { errors.push(d.name + ': could not be read.'); return; }
      currencySample += d.text.slice(0, 6000);
      try {
        var res = window.DripParse.parseFile(d.text, d.name);
        all = all.concat(res.transactions);
        warnings = warnings.concat(res.warnings || []);
        formats.push(d.name + ' — ' + res.format + ', ' +
                     res.transactions.length + ' transactions');
      } catch (e) {
        errors.push(d.name + ': ' + e.message);
      }
    });

    if (!all.length) {
      render(null, warnings, errors.length ? errors :
        ['No transactions could be read from those files.']);
      return;
    }

    CUR = detectCurrency(currencySample);

    // Drop exact duplicates — people often export overlapping date ranges.
    var seen = {}, deduped = [], dupes = 0;
    all.forEach(function (t) {
      var k = t.date.getTime() + '|' + t.amount.toFixed(2) + '|' +
              t.description.slice(0, 40);
      if (seen[k]) { dupes++; return; }
      seen[k] = 1;
      deduped.push(t);
    });
    if (dupes) {
      warnings.push(dupes + ' duplicate ' + plural(dupes, 'transaction') +
                    ' removed (overlapping date ranges between files).');
    }

    try {
      STATE = window.DripAnalyze.analyse(deduped);
      STATE.formats = formats;
      render(STATE, warnings, errors);
    } catch (e) {
      render(null, warnings, [e.message]);
    }
  }

  /* ------------------------------------------------------------ render */

  function render(a, warnings, errors) {
    var msgs = $('#messages');
    msgs.innerHTML = '';

    (errors || []).forEach(function (e) {
      msgs.appendChild(el('div', { class: 'notice bad', text: e }));
    });
    if ((warnings || []).length) {
      msgs.appendChild(el('div', { class: 'notice warn' }, [
        el('strong', { text: 'Worth a look:' }),
        el('ul', {}, warnings.map(function (w) { return el('li', { text: w }); }))
      ]));
    }

    var out = $('#results');
    out.innerHTML = '';
    if (!a) { $('#drop').classList.remove('compact'); return; }
    // Shrink the drop zone once there are results, but keep it available so a
    // second file (the credit card you forgot) can be added on top.
    $('#drop').classList.add('compact');

    out.appendChild(toolbar(a));
    out.appendChild(headline(a));
    out.appendChild(kpis(a));

    if (a.hikes.length) out.appendChild(hikeSection(a));
    if (a.upcoming.length) out.appendChild(upcomingSection(a));

    out.appendChild(recurringSection(a));

    if (a.forgettable.length) out.appendChild(forgettableSection(a));
    if (a.overlaps.length) out.appendChild(overlapSection(a));
    if (a.stopped.length) out.appendChild(stoppedSection(a));
    if (a.unusual.length) out.appendChild(unusualSection(a));

    out.appendChild(coverage(a));
    out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toolbar(a) {
    var sel = el('select', {
      onchange: function () { CUR = this.value; render(STATE, [], []); }
    }, ['$', '£', '€', '₹', '¥'].map(function (c) {
      return el('option', { value: c, selected: c === CUR ? 'selected' : null, text: c });
    }));

    return el('div', { class: 'toolbar' }, [
      el('span', { class: 'sub2',
        text: a.stats.count.toLocaleString() + ' transactions · ' +
              fdate(a.firstDate) + ' → ' + fdate(a.lastDate) + ' · ' +
              Math.round(a.spanDays / 30.44) + ' months' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'sub2', text: 'Currency' }),
      sel,
      el('button', {
        class: 'btn ghost sm', text: 'Start over',
        onclick: function () {
          STATE = null; $('#results').innerHTML = ''; $('#messages').innerHTML = '';
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      })
    ]);
  }

  function headline(a) {
    var n = a.active.length;
    if (!n) {
      return el('div', { class: 'headline' }, [
        'No recurring charges stood out in this file. That can happen with a ',
        'short date range — most subscriptions need at least three charges to ',
        'be recognised, so try exporting 12 months or more.'
      ]);
    }
    var bits = [];
    bits.push('You have ');
    bits.push(el('strong', { text: a.subs.length + ' ' +
      plural(a.subs.length, 'subscription') }));
    bits.push(' costing ');
    bits.push(el('strong', { text: money0(a.subsMonthly) + ' a month' }));
    bits.push(' — ' + money0(a.subsAnnual) + ' a year. ');
    if (a.bills.length) {
      bits.push('Household bills add another ' + money0(a.billsMonthly) +
                ' a month and are listed separately. ');
    }
    if (a.hikes.length) {
      bits.push(el('strong', { text: a.hikes.length + ' ' +
        plural(a.hikes.length, 'charge') + ' went up in price' }));
      bits.push(', adding ' + money0(a.hikeAnnual) + ' a year. ');
    }
    if (a.upcoming.length) {
      bits.push(a.upcoming.length + ' ' + plural(a.upcoming.length, 'renewal') +
                ' worth watching in the next few weeks.');
    }
    return el('div', { class: 'headline' }, bits);
  }

  function kpis(a) {
    var k = [
      ['Subscriptions per month', money0(a.subsMonthly), ''],
      ['Subscriptions per year', money0(a.subsAnnual), ''],
      ['Active subscriptions', String(a.subs.length), ''],
      ['Bills per month', money0(a.billsMonthly), ''],
      ['Price rises', String(a.hikes.length), a.hikes.length ? 'alert' : ''],
      ['Renewals to watch', String(a.upcoming.length), a.upcoming.length ? 'warn' : '']
    ];
    return el('div', { class: 'kpis' }, k.map(function (p) {
      return el('div', { class: 'kpi ' + p[2] }, [
        el('b', { text: p[1] }), el('span', { text: p[0] })
      ]);
    }));
  }

  /* --------------------------------------------------------- sections */

  function section(title, sub, body) {
    return el('section', {}, [
      el('h2', { class: 'sec', text: title }),
      sub ? el('p', { class: 'sub', text: sub }) : null,
      body
    ]);
  }

  function hikeSection(a) {
    return section(
      'Prices that went up',
      'A charge that stepped up and stayed up. One-off partial or refunded ' +
      'months are ignored.',
      el('div', { class: 'cards' }, a.hikes.map(function (r) {
        var p = r.priceChange;
        var perYear = p.delta * (365.25 / (r.periodDays || 30.44));
        return el('div', { class: 'card flag bad' }, [
          el('h3', { text: r.merchant }),
          el('div', { class: 'meta' }, [
            money(p.from) + ' → ', el('strong', { text: money(p.to) }),
            '  (+' + Math.round(p.pct) + '%)'
          ]),
          el('div', { class: 'meta', text:
            'Since ' + fdate(p.changedAt) + ' · costing you ' +
            money0(perYear) + ' more a year' }),
          el('button', {
            class: 'btn ghost sm', text: 'See the charges',
            style: 'margin-top:10px',
            onclick: function (e) { e.stopPropagation(); openDetail(r); }
          })
        ]);
      }))
    );
  }

  function upcomingSection(a) {
    return section(
      'Renewals worth watching',
      'Infrequent charges due soon — the yearly and quarterly ones that arrive ' +
      'without warning — plus anything landing this week. Predicted from the ' +
      'pattern of past charges, not from your bank.',
      el('div', { class: 'cards' }, a.upcoming.slice(0, 9).map(function (r) {
        var when = r.daysToNext === 0 ? 'today'
          : r.daysToNext === 1 ? 'tomorrow'
          : 'in ' + r.daysToNext + ' days';
        return el('div', { class: 'card flag' }, [
          el('h3', { text: r.merchant }),
          el('div', { class: 'meta' }, [
            el('strong', { text: money(r.median) }), ' ' + when +
            ' · ' + fdate(r.nextCharge)
          ]),
          el('div', { class: 'meta', text: r.cadenceLabel })
        ]);
      }))
    );
  }

  function table(list) {
    var tbody = el('tbody');
    list.forEach(function (r) { tbody.appendChild(itemRow(r)); });
    return el('div', { class: 'tablewrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Merchant' }),
          el('th', { class: 'hide-sm', text: 'How often' }),
          el('th', { class: 'num', text: 'Amount' }),
          el('th', { class: 'num hide-sm', text: 'Per month' }),
          el('th', { class: 'num', text: 'Per year' }),
          el('th', { class: 'hide-sm', text: 'Next' }),
          el('th', { class: 'hide-sm', text: 'Confidence' })
        ])]),
        tbody
      ])
    ]);
  }

  function recurringSection(a) {
    if (!a.active.length) {
      return section('Recurring charges', '', el('p', { class: 'empty',
        text: 'None detected.' }));
    }
    var out = el('div');
    if (a.subs.length) {
      out.appendChild(section(
        'Subscriptions and memberships',
        'The part you could actually change. Sorted by yearly cost — click any ' +
        'row to see the individual charges and the exact statement lines.',
        table(a.subs)));
    }
    if (a.bills.length) {
      out.appendChild(section(
        'Household bills',
        'Rent, utilities, insurance, phone and loans — recurring, but not the ' +
        'kind of thing you cancel on a whim. Kept out of the subscription ' +
        'totals so they don’t drown everything else.',
        table(a.bills)));
    }
    return out;
  }

  function itemRow(r) {
    var tr = el('tr', { class: 'item', onclick: function () { toggle(tr, r); } }, [
      el('td', {}, [
        el('div', { class: 'merchant', text: r.merchant }),
        el('div', { class: 'sub2' }, [
          r.category !== 'Other' ? r.category + ' · ' : '',
          r.count + ' charges',
          r.startedRecently ? el('span', { class: 'pill blue',
            style: 'margin-left:6px', text: 'new' }) : null,
          r.fromPair ? el('span', { class: 'pill amber', style: 'margin-left:6px',
            title: 'Only two charges seen — the pattern is likely but not proven',
            text: 'only 2 charges' }) : null,
          !r.known ? el('span', { class: 'pill', style: 'margin-left:6px',
            text: 'name guessed' }) : null
        ])
      ]),
      el('td', { class: 'hide-sm' }, [
        el('span', { class: 'pill', text: r.cadenceLabel })
      ]),
      el('td', { class: 'num', text: money(r.median) }),
      el('td', { class: 'num hide-sm', text: money(r.monthlyCost) }),
      el('td', { class: 'num', text: money0(r.annualCost) }),
      el('td', { class: 'hide-sm' }, [
        el('div', { text: fshort(r.nextCharge) }),
        el('div', { class: 'sub2', text: r.daysToNext + 'd' })
      ]),
      el('td', { class: 'hide-sm' }, [
        el('div', { class: 'conf' }, [
          el('i', {}, [el('em', { style: 'width:' + Math.round(r.confidence * 100) + '%' })]),
          el('span', { class: 'sub2', text: Math.round(r.confidence * 100) + '%' })
        ])
      ])
    ]);
    return tr;
  }

  function toggle(tr, r) {
    var next = tr.nextSibling;
    if (next && next.classList && next.classList.contains('detail')) {
      next.parentNode.removeChild(next);
      return;
    }
    var row = el('tr', { class: 'detail' }, [
      el('td', { colspan: '7' }, [detailBox(r)])
    ]);
    tr.parentNode.insertBefore(row, tr.nextSibling);
  }

  function openDetail(r) {
    var rows = document.querySelectorAll('tr.item');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].textContent.indexOf(r.merchant) === 0) {
        rows[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (!(rows[i].nextSibling && rows[i].nextSibling.classList &&
              rows[i].nextSibling.classList.contains('detail'))) {
          toggle(rows[i], r);
        }
        return;
      }
    }
  }

  function detailBox(r) {
    var facts = [
      ['Pattern', r.cadenceLabel + (r.dayOfMonth
        ? ' — around the ' + ordinal(Math.round(r.dayOfMonth)) : '')],
      ['Charges seen', r.count + ' over ' + r.runningMonths + ' months'],
      ['First charge', fdate(r.first)],
      ['Latest charge', fdate(r.last) + ' (' + r.daysSinceLast + ' days ago)'],
      ['Typical amount', money(r.median) +
        (r.stability > 0.9 ? ' — same every time' : ' — varies a little')],
      ['Next expected', fdate(r.nextCharge)],
      ['Confidence', Math.round(r.confidence * 100) + '% (timing regularity ' +
        Math.round(r.regularity * 100) + '%)']
    ];
    if (r.sources.length > 1) facts.push(['Seen in', r.sources.join(', ')]);
    if (r.fromPair) {
      facts.push(['Caveat', 'Only two charges are in this file. The gap and the ' +
        'amount both match a ' + r.cadenceLabel.toLowerCase() + ' pattern, but ' +
        'two points cannot prove regularity — export a longer range to confirm.']);
    }

    return el('div', { class: 'detailbox' }, [
      el('h4', { text: 'Why Drip thinks this is recurring' }),
      el('div', { class: 'charges', style: 'margin-bottom:14px' },
        facts.map(function (f) {
          return el('div', { style: 'grid-template-columns:140px 1fr' }, [
            el('span', { class: 'raw', text: f[0] }),
            el('span', { text: f[1] })
          ]);
        })),
      el('h4', { text: 'The charges themselves' }),
      el('div', { class: 'charges' }, r.txns.slice().reverse().map(function (t) {
        return el('div', {}, [
          el('span', { text: fdate(t.date) }),
          el('span', { style: 'text-align:right', text: money(Math.abs(t.amount)) }),
          el('span', { class: 'raw', title: t.source + ' line ' + t.line,
                       text: t.description })
        ]);
      }))
    ]);
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function forgettableSection(a) {
    return section(
      'Easy to forget',
      'Small amounts that have been going out for a long time. Not necessarily ' +
      'waste — just the ones that stop getting noticed.',
      el('div', { class: 'cards' }, a.forgettable.slice(0, 8).map(function (r) {
        return el('div', { class: 'card' }, [
          el('h3', { text: r.merchant }),
          el('div', { class: 'meta', text:
            money(r.median) + ' ' + r.cadenceLabel.toLowerCase() + ' · running ' +
            r.runningMonths + ' months' }),
          el('div', { class: 'meta' }, [
            'Paid so far: ', el('strong', { text: money0(r.total) })
          ])
        ]);
      }))
    );
  }

  function overlapSection(a) {
    return section(
      'More than one of the same thing',
      'Categories where you are paying for several services at once. Sometimes ' +
      'deliberate, sometimes not.',
      el('div', { class: 'cards' }, a.overlaps.slice(0, 6).map(function (o) {
        return el('div', { class: 'card' }, [
          el('h3', { text: o.category }),
          el('div', { class: 'meta', text:
            o.items.length + ' services · ' + money0(o.monthly) + ' a month' }),
          el('div', { class: 'meta', style: 'margin-top:6px' },
            o.items.map(function (r) {
              return el('div', { text: '· ' + r.merchant + ' — ' +
                                       money(r.median) + ' ' +
                                       r.cadenceLabel.toLowerCase() });
            }))
        ]);
      }))
    );
  }

  function stoppedSection(a) {
    return section(
      'Looks like it stopped',
      'Was regular, then the charges ended. Worth a glance in case one stopped ' +
      'by accident — a failed card can silently cancel something you wanted.',
      el('div', { class: 'cards' }, a.stopped.slice(0, 9).map(function (r) {
        return el('div', { class: 'card' }, [
          el('h3', { text: r.merchant }),
          el('div', { class: 'meta', text:
            money(r.median) + ' ' + r.cadenceLabel.toLowerCase() +
            ' · last charged ' + fdate(r.last) }),
          el('div', { class: 'meta', text: r.count + ' charges, ' +
            money0(r.total) + ' in total' })
        ]);
      }))
    );
  }

  function unusualSection(a) {
    return section(
      'Unusually large one-offs',
      'Measured against your own spending, not a fixed threshold — these are ' +
      'in the top 1% of what leaves these accounts.',
      el('div', { class: 'tablewrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Date' }),
            el('th', { text: 'Description' }),
            el('th', { class: 'num', text: 'Amount' })
          ])]),
          el('tbody', {}, a.unusual.map(function (t) {
            return el('tr', {}, [
              el('td', { text: fdate(t.date) }),
              el('td', {}, [
                el('div', { text: t.merchant }),
                el('div', { class: 'sub2', text: t.description })
              ]),
              el('td', { class: 'num', text: money(Math.abs(t.amount)) })
            ]);
          }))
        ])
      ])
    );
  }

  function coverage(a) {
    var known = a.active.filter(function (r) { return r.known; }).length;
    return el('section', {}, [
      el('p', { class: 'sub', style: 'margin-top:10px' , text:
        'Read ' + (a.formats || []).length + ' ' +
        plural((a.formats || []).length, 'file') + ': ' +
        (a.formats || []).join(' · ') + '. ' +
        known + ' of ' + a.active.length +
        ' recurring merchants matched a known name; the rest were named from ' +
        'the statement text, so those labels may look rough.' })
    ]);
  }

  /* ------------------------------------------------------------- wire */

  var drop = $('#drop'), fileInput = $('#file');

  $('#pick').addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    if (this.files && this.files.length) readFiles(this.files);
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation(); drop.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return;
      drop.classList.remove('over');
    });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) readFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  $('#demo').addEventListener('click', function () {
    ingest([{ name: 'sample-statement.csv', text: window.DripSample.generate(18) }]);
  });

  window.Drip = { ingest: ingest, state: function () { return STATE; } };
})();
