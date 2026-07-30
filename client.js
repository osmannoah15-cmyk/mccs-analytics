/* MCCS Revenue Intelligence - client */
'use strict';

/* ---------------- State and helpers ---------------- */

const S = {
  user: null,
  meta: null,
  analytics: null,
  campaigns: [],
  channels: [],
  metric: 'revenue',
  promoFilter: { channel: new Set(), bl: new Set(), inst: new Set(), result: 'all' },
  selectedCampaign: null,
  charts: {},
  data: { page: 1, pageSize: 50, sort: 'period', dir: 'asc', search: '' },
  scenario: null
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const money = (n) => {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}K`;
  return `${sign}$${Math.round(a)}`;
};
const pct = (n, d = 1) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${Number(n).toFixed(d)}%`);
const num = (n) => (Number(n) || 0).toLocaleString('en-US');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlabel = (p) => {
  if (!p) return '';
  const [y, m] = p.split('-');
  return `${MONTHS[Number(m) - 1]} '${String(y).slice(2)}`;
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body && !(options.body instanceof FormData)
      ? { 'Content-Type': 'application/json' } : undefined,
    ...options
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Not authenticated'); }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const filters = () => ({
  installation: $('fInst').value,
  businessLine: $('fBL').value,
  from: $('fFrom').value || undefined,
  to: $('fTo').value || undefined
});
const qs = (extra = {}) => new URLSearchParams(
  Object.entries({ ...filters(), ...extra }).filter(([, v]) => v != null && v !== '')
).toString();

function canWrite() { return ['admin', 'analyst'].includes(S.user?.role); }

function setEngine(badgeId, txtId, engine, note) {
  const b = $(badgeId), t = $(txtId);
  if (!b) return;
  b.classList.remove('live', 'offline');
  if (engine === 'asksage') { b.classList.add('live'); t.textContent = 'engine: Ask Sage'; }
  else { b.classList.add('offline'); t.textContent = 'engine: built-in metrics'; }
  if (note) b.title = note;
}

function skeleton(node, lines = 5) {
  node.innerHTML = '';
  const widths = [88, 96, 72, 90, 60, 80];
  for (let i = 0; i < lines; i++) {
    node.appendChild(el('div', 'skel')).style.width = `${widths[i % widths.length]}%`;
  }
}

function typeInto(node, text) {
  node.textContent = '';
  const step = Math.max(2, Math.round(text.length / 200));
  let i = 0;
  (function tick() {
    node.textContent = text.slice(0, i);
    i += step;
    if (i < text.length + step) setTimeout(tick, 12);
    else node.textContent = text;
  })();
}

/* ---------------- Tooltip ---------------- */
const tip = $('tip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(x + 14, window.innerWidth - r.width - 12)}px`;
  tip.style.top = `${Math.max(10, y - r.height - 12)}px`;
}
const hideTip = () => { tip.style.display = 'none'; };

/* ---------------- Boot ---------------- */

async function boot() {
  try {
    const me = await api('/auth/me');
    S.user = me.user;
    $('userName').textContent = S.user.name;
    $('userRole').textContent = S.user.role;
    // Analysts need the data tools, admins additionally get accounts and logs.
    if (['admin', 'analyst'].includes(S.user.role)) $('tabAdmin').hidden = false;
    if (S.user.role !== 'admin') {
      ['dataStatusCard', 'usersCard', 'aiLogCard'].forEach((id) => {
        const n = $(id); if (n) n.hidden = true;
      });
    }
  } catch { return; }

  S.meta = await api('/api/meta');
  fillFilters();
  await refresh();
  await checkAiStatus();
  wire();
}

function fillFilters() {
  const m = S.meta;
  // Rebuild rather than append, since this runs again after a data load.
  $('fInst').innerHTML = '<option value="all">All installations</option>';
  $('fBL').innerHTML = '<option value="all">All business lines</option>';
  m.installations.forEach((i) => $('fInst').appendChild(new Option(i, i)));
  m.businessLines.forEach((b) => $('fBL').appendChild(new Option(b, b)));

  // textContent does not decode HTML entities, so use the character directly.
  const rows = Number(m.coverage.rows) || 0;
  $('coverageLine').textContent = rows
    ? `${num(rows)} records \u00b7 ${m.installations.length} installations \u00b7 ${m.businessLines.length} business lines`
    : 'No data loaded yet';

  // Period pickers are built once the analytics response tells us the month list.
}

function fillPeriodPickers(months) {
  const from = $('fFrom'), to = $('fTo');
  const keepFrom = from.value, keepTo = to.value;
  from.innerHTML = '<option value="">Earliest</option>';
  to.innerHTML = '<option value="">Latest</option>';
  months.forEach((p) => {
    from.appendChild(new Option(mlabel(p), p));
    to.appendChild(new Option(mlabel(p), p));
  });
  if (keepFrom) from.value = keepFrom;
  if (keepTo) to.value = keepTo;
}

async function refresh() {
  const data = await api(`/api/analytics?${qs()}`);
  if (data.empty) {
    const anyData = Number(S.meta?.coverage?.rows) || 0;
    $('kpis').innerHTML = anyData
      ? '<div class="empty">No records match these filters. Widen the selection or reset.</div>'
      : `<div class="empty">The database has no sales data yet.${
          S.user?.role === 'admin'
            ? ' Open the <b>Admin</b> tab and choose <b>Load data</b>.'
            : ' Ask an administrator to load it.'}</div>`;
    return;
  }
  S.analytics = data;
  if (!$('fFrom').options.length || $('fFrom').options.length === 1) fillPeriodPickers(data.months);

  renderKpis();
  renderScorecard();
  renderSales();
  await loadCampaigns();
  renderLob();
  renderAnomalies();
}

/* ---------------- KPIs ---------------- */

function renderKpis() {
  const d = S.analytics.digest;
  const h = d.headline;
  const box = $('kpis');
  const items = [
    { v: money(h.latestRevenue), s: pct(h.momPct), l: `REVENUE ${mlabel(d.coverage.latestPeriod).toUpperCase()}` },
    { v: pct(h.yoyPct), s: '', l: 'YEAR OVER YEAR' },
    { v: `${h.latestMarginRatePct}%`, s: '', l: 'GROSS MARGIN RATE' },
    { v: `$${h.avgTransactionValue}`, s: `${num(h.latestTransactions)} txns`, l: 'AVG TRANSACTION VALUE' },
    { v: money(d.forecast.total), s: `${d.forecast.mapePct}% err`, l: 'NEXT 3 MONTHS' },
    { v: `${d.campaigns.profitable}/${d.campaigns.total}`, s: '', l: 'CAMPAIGNS RETURNING COST' },
    { v: money(d.opportunities.totalAddressable), s: '', l: 'ADDRESSABLE OPPORTUNITY' }
  ];
  box.innerHTML = items.map((i) =>
    `<div class="kpi"><div class="v">${esc(i.v)}${i.s ? `<small>${esc(i.s)}</small>` : ''}</div><div class="l">${esc(i.l)}</div></div>`
  ).join('');
}

/* ---------------- Scorecard ---------------- */

function renderScorecard() {
  const d = S.analytics.digest;
  const sc = d.scorecard;
  const sum = sc.summary;

  $('scoreCompared').textContent = `Latest month compared with ${sc.comparedWith}`;
  $('healthPct').textContent = `${sum.onTrack} of ${sum.kpiCount}`;
  $('instrumented').textContent = `${sum.objectivesInstrumented} of ${sum.objectivesTotal}`;
  $('healthBar').style.width = `${sum.healthPct}%`;
  $('healthMeta').innerHTML = sum.offTrack
    ? `${sum.offTrack} ${sum.offTrack === 1 ? 'measure is' : 'measures are'} behind. Each objective below shows what it is measured against.`
    : 'Every measure is ahead of its own baseline.';

  const fmtVal = (k) => {
    if (k.unit === 'usd') return money(k.value);
    if (k.unit === 'usd2') return `$${k.value.toFixed(2)}`;
    if (k.unit === 'pct') return `${k.value.toFixed(1)}%`;
    return num(Math.round(k.value));
  };

  $('objGrid').innerHTML = sc.objectives.map((o, i) => {
    if (!o.instrumented) {
      return `
        <div class="obj gap">
          <div class="eyebrow">Objective ${i + 1}</div>
          <h3>${esc(o.title)}</h3>
          <div class="badge-gap">Not measurable yet</div>
          <div class="gapnote">${esc(o.gap)}</div>
          <div class="gapnote" style="margin-bottom:6px"><b>What would close the gap</b></div>
          <ul class="needed">${o.needed.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
        </div>`;
    }
    return `
      <div class="obj">
        <div class="eyebrow">Objective ${i + 1}</div>
        <h3>${esc(o.title)}</h3>
        <div class="note">${esc(o.basis)}</div>
        ${o.kpis.map((k) => `
          <div class="kpiblock">
            <div class="row1">
              <span class="klabel">${esc(k.label)}</span>
              <span class="kval">${fmtVal(k)}</span>
            </div>
            <div class="row2">
              <span class="dot ${k.onTrack ? 'ok' : 'off'}"></span>
              <span class="delta ${k.onTrack ? 'win' : 'lose'}">${k.deltaPct == null ? '' : pct(k.deltaPct)}</span>
              <span>vs ${fmtVal({ ...k, value: k.baseline })} &middot; ${esc(k.baselineLabel)}</span>
            </div>
            ${k.note ? `<div class="knote">${esc(k.note)}</div>` : ''}
          </div>`).join('')}
      </div>`;
  }).join('');

  $('oppCards').innerHTML = d.opportunities.items.map((o) => `
    <div class="opp">
      <div class="v">${money(o.value)}</div>
      <div class="l">${esc(o.label)}</div>
      <div class="b">${esc(o.basis)}</div>
      <div class="loe">${esc(o.loe)}</div>
    </div>`).join('');
}

/* ---------------- Sales and forecast ---------------- */

function renderSales() {
  const a = S.analytics;
  const isRev = S.metric === 'revenue';
  const actual = isRev ? a.series.revenue : a.series.margin;
  const labels = [...a.months.map(mlabel), ...a.forecast.periods.map((p) => mlabel(p.period))];

  // Margin forecast is scaled from the revenue forecast by the current margin rate.
  const marginRate = a.series.revenue.reduce((x, y) => x + y, 0)
    ? a.series.margin.reduce((x, y) => x + y, 0) / a.series.revenue.reduce((x, y) => x + y, 0) : 0;
  const scale = isRev ? 1 : marginRate;

  const pad = new Array(a.months.length - 1).fill(null);
  const fLine = [...pad, actual[actual.length - 1], ...a.forecast.periods.map((p) => p.value * scale)];
  const fLow = [...pad, actual[actual.length - 1], ...a.forecast.periods.map((p) => p.low * scale)];
  const fHigh = [...pad, actual[actual.length - 1], ...a.forecast.periods.map((p) => p.high * scale)];

  drawChart('chartMain', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual', data: [...actual], borderColor: '#F26207', backgroundColor: 'rgba(242,98,7,.06)',
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .25, fill: true },
        { label: 'Forecast', data: fLine, borderColor: '#2563EB', borderWidth: 2,
          borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 4, tension: .25 },
        { label: 'High', data: fHigh, borderColor: 'transparent', backgroundColor: 'rgba(37,99,235,.14)',
          pointRadius: 0, fill: '+1' },
        { label: 'Low', data: fLow, borderColor: 'transparent', backgroundColor: 'rgba(37,99,235,.14)',
          pointRadius: 0, fill: false }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (i) => ['Actual', 'Forecast'].includes(i.dataset.label),
          callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16, font: { size: 11 } } },
        y: { grid: { color: '#EFEFEC' }, ticks: { callback: (v) => money(v), font: { size: 11 } } }
      }
    }
  });

  const f = a.forecast;
  $('forecastNote').textContent =
    `Projection totals ${money(f.periods.reduce((x, p) => x + p.value, 0))} over three months. ` +
    `In-sample error ${f.mape}%. Monthly trend ${money(f.slope)} per month.`;

  renderSignals();
  renderMovers();
  renderHeat();
}

function renderSignals() {
  const d = S.analytics.digest;
  const h = d.headline;
  const top = d.installations[0];
  const bottom = d.installations[d.installations.length - 1];
  const sl = (n, dsc, c) => `<div class="sideline ${c}"><div class="n">${n}</div><div class="d">${dsc}</div></div>`;

  $('signals').innerHTML = [
    sl(pct(h.momPct), 'Month over month', h.momPct >= 0 ? 'up' : 'down'),
    sl(pct(h.yoyPct), 'Year over year', h.yoyPct >= 0 ? 'up' : 'down'),
    sl(`${top.installation}`, `Fastest growth at ${pct(top.growthPct)}`, 'up'),
    sl(`${bottom.installation}`, `Slowest at ${pct(bottom.growthPct)}`, 'down')
  ].join('');
}

function renderMovers() {
  const m = S.analytics.movers.slice(0, 8);
  $('movers').innerHTML = m.map((x) => `
    <div class="kpirow">
      <div class="kl">${esc(x.label)}</div>
      <div class="kv ${x.changePct >= 0 ? 'win' : 'lose'}">${pct(x.changePct)}</div>
    </div>`).join('') || '<div class="empty">Not enough history for a comparison.</div>';
}

function renderHeat() {
  const a = S.analytics;
  const t = $('heatTbl');
  const head = `<thead><tr><th class="plain">Installation</th>${
    a.months.map((m) => `<th class="plain">${mlabel(m)}</th>`).join('')}</tr></thead>`;
  const body = a.heatmap.map((row) => `
    <tr>
      <td class="name">${esc(row.installation)}</td>
      ${row.index.map((ix, i) => {
        const above = ix >= 1;
        const strength = Math.min(1, Math.abs(ix - 1) * 2.6);
        const bg = above ? `rgba(242,98,7,${(strength * .55).toFixed(3)})` : `rgba(110,118,129,${(strength * .18).toFixed(3)})`;
        return `<td style="background:${bg}" title="${esc(mlabel(a.months[i]))}: ${money(row.values[i])}">${(ix).toFixed(2)}</td>`;
      }).join('')}
    </tr>`).join('');
  t.innerHTML = head + `<tbody>${body}</tbody>`;
}

/* ---------------- Promotion ROI ---------------- */

async function loadCampaigns() {
  const data = await api(`/api/campaigns?${qs()}`);
  S.campaigns = data.campaigns;
  S.channels = data.channels;
  renderPromoFilters();
  renderPromo();
}

function chipRow(boxId, values, active, onToggle) {
  const box = $(boxId);
  box.innerHTML = `<button data-v="__all" class="${active.size ? '' : 'on'}">All</button>` +
    values.map((v) => `<button data-v="${esc(v)}" class="${active.has(v) ? 'on' : ''}">${esc(v)}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.v;
      if (v === '__all') active.clear();
      else if (active.has(v)) active.delete(v);
      else active.add(v);
      onToggle();
    };
  });
}

function renderPromoFilters() {
  const f = S.promoFilter;
  const all = S.campaigns;
  const redraw = () => { S.selectedCampaign = null; renderPromoFilters(); renderPromo(); };

  chipRow('chChips', [...new Set(all.map((c) => c.channel))].sort(), f.channel, redraw);
  chipRow('blChips', [...new Set(all.map((c) => c.businessLine))].sort(), f.bl, redraw);
  chipRow('instChips', [...new Set(all.map((c) => c.installation))].sort(), f.inst, redraw);

  $('resChips').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.res === f.result);
    b.onclick = () => { f.result = b.dataset.res; redraw(); };
  });

  const anyActive = f.channel.size || f.bl.size || f.inst.size || f.result !== 'all';
  $('btnClearPromo').hidden = !anyActive;
}

function visibleCampaigns() {
  const f = S.promoFilter;
  return S.campaigns.filter((c) =>
    (!f.channel.size || f.channel.has(c.channel)) &&
    (!f.bl.size || f.bl.has(c.businessLine)) &&
    (!f.inst.size || f.inst.has(c.installation)) &&
    (f.result === 'all' || (f.result === 'win' ? c.profitable : !c.profitable)));
}

function renderPromo() {
  const cs = visibleCampaigns();
  const spend = cs.reduce((a, c) => a + c.spend, 0);
  const net = cs.reduce((a, c) => a + c.netMargin, 0);
  $('promoCount').textContent =
    `${cs.length} of ${S.campaigns.length} campaigns \u00b7 ${money(spend)} spend \u00b7 ` +
    `${cs.filter((c) => c.profitable).length} returned their cost \u00b7 net ${money(net)}`;

  if (!cs.length) {
    $('campTbl').innerHTML = '<tbody><tr><td class="empty">No campaigns match these filters.</td></tr></tbody>';
    ['chartScatter', 'chartChannels'].forEach((id) => { if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; } });
    return;
  }

  drawChart('chartScatter', {
    type: 'bubble',
    data: {
      datasets: [{
        data: cs.map((c) => ({
          x: c.spend, y: c.roiPct,
          r: Math.max(4, Math.min(22, Math.sqrt(Math.abs(c.incrementalMargin)) / 42)),
          c
        })),
        backgroundColor: cs.map((c) => S.selectedCampaign === c.id
          ? 'rgba(242,98,7,.75)'
          : (c.profitable ? 'rgba(22,163,74,.42)' : 'rgba(220,38,38,.38)')),
        borderColor: cs.map((c) => S.selectedCampaign === c.id
          ? '#D95700' : (c.profitable ? '#15803D' : '#B91C1C')),
        borderWidth: cs.map((c) => (S.selectedCampaign === c.id ? 2 : 1))
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      onClick: (evt, els) => {
        if (!els.length) return;
        const c = cs[els[0].index];
        S.selectedCampaign = S.selectedCampaign === c.id ? null : c.id;
        renderPromo();
        if (S.selectedCampaign) explainCampaign(c.id);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const c = ctx.raw.c;
              return [`${c.name} (${c.channel})`, `${c.installation} \u00b7 ${c.businessLine}`,
                `Spend ${money(c.spend)} \u00b7 ROI ${pct(c.roiPct)}`,
                `Incremental margin ${money(c.incrementalMargin)}`, 'Click to inspect'];
            }
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'Spend', font: { size: 11 } }, grid: { color: '#EFEFEC' },
          ticks: { callback: (v) => money(v), font: { size: 11 } } },
        y: { title: { display: true, text: 'ROI %', font: { size: 11 } }, grid: { color: '#EFEFEC' },
          ticks: { callback: (v) => `${v}%`, font: { size: 11 } } }
      }
    }
  });

  // Channel economics are computed from what is visible, so the bars respond
  // to the other filters rather than always showing the whole book.
  const byCh = new Map();
  cs.forEach((c) => {
    if (!byCh.has(c.channel)) byCh.set(c.channel, { channel: c.channel, spend: 0, margin: 0, count: 0 });
    const b = byCh.get(c.channel);
    b.spend += c.spend; b.margin += c.incrementalMargin; b.count++;
  });
  const chans = [...byCh.values()]
    .map((b) => ({ ...b, roiPct: b.spend ? ((b.margin - b.spend) / b.spend) * 100 : 0 }))
    .sort((a, b) => a.roiPct - b.roiPct);

  drawChart('chartChannels', {
    type: 'bar',
    data: {
      labels: chans.map((c) => c.channel),
      datasets: [{
        data: chans.map((c) => Number(c.roiPct.toFixed(1))),
        backgroundColor: chans.map((c) => S.promoFilter.channel.has(c.channel)
          ? 'rgba(242,98,7,.8)'
          : (c.roiPct >= 0 ? 'rgba(22,163,74,.65)' : 'rgba(220,38,38,.6)')),
        borderRadius: 5
      }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      onClick: (evt, els) => {
        if (!els.length) return;
        const ch = chans[els[0].index].channel;
        const set = S.promoFilter.channel;
        if (set.has(ch)) set.delete(ch); else set.add(ch);
        S.selectedCampaign = null;
        renderPromoFilters();
        renderPromo();
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const row = chans[c.dataIndex];
              return [`ROI ${pct(row.roiPct)}`, `Spend ${money(row.spend)} across ${row.count} campaigns`,
                'Click to filter to this channel'];
            }
          }
        }
      },
      scales: {
        x: { grid: { color: '#EFEFEC' }, ticks: { callback: (v) => `${v}%`, font: { size: 11 } } },
        y: { grid: { display: false }, ticks: { font: { size: 11 } } }
      }
    }
  });

  renderCampaignTable(cs);
}

function renderCampaignTable(cs) {
  const sorted = [...cs].sort((a, b) => b.roiPct - a.roiPct);
  $('campTbl').innerHTML = `
    <thead><tr>
      <th class="plain">Campaign</th><th class="plain">Channel</th><th class="plain">Line</th>
      <th class="plain">Spend</th><th class="plain">Lift</th><th class="plain">Incr. margin</th><th class="plain">ROI</th>
    </tr></thead>
    <tbody>${sorted.map((c) => `
      <tr data-id="${c.id}" style="cursor:pointer" class="${S.selectedCampaign === c.id ? 'selected' : ''}">
        <td class="name">${esc(c.name)}<span><br>${esc(c.installation)}</span></td>
        <td>${esc(c.channel)}</td>
        <td>${esc(c.businessLine)}</td>
        <td>${money(c.spend)}</td>
        <td>${pct(c.liftPct)}</td>
        <td>${money(c.incrementalMargin)}</td>
        <td><span class="chip ${c.profitable ? 'win' : 'lose'}">${pct(c.roiPct)}</span></td>
      </tr>`).join('')}</tbody>`;

  $('campTbl').querySelectorAll('tbody tr').forEach((tr) => {
    tr.onclick = () => {
      const id = Number(tr.dataset.id);
      S.selectedCampaign = S.selectedCampaign === id ? null : id;
      renderPromo();
      if (S.selectedCampaign) explainCampaign(id);
    };
  });
}

async function explainCampaign(id) {
  const out = $('campOut');
  out.hidden = false;
  skeleton(out, 3);
  try {
    const r = await api(`/api/ai/campaign/${id}`, { method: 'POST', body: JSON.stringify({}) });
    typeInto(out, r.text);
  } catch (e) {
    out.textContent = `Could not generate an assessment: ${e.message}`;
  }
}

/* ---------------- Programs ---------------- */

function renderLob() {
  const p = S.analytics.digest.linesOfBusiness;
  const chipFor = (r) => ({
    Scale: 'win', Sustain: 'neutral', Review: 'warn', 'Sunset candidate': 'lose'
  }[r] || 'neutral');

  $('lobTbl').innerHTML = `
    <thead><tr>
      <th class="plain">Line of business</th>
      <th class="plain">Revenue</th>
      <th class="plain">Margin rate</th>
      <th class="plain">Trend</th>
      <th class="plain">Avg transaction</th>
      <th class="plain" title="Days of selling the stock on hand would cover">Stock cover</th>
      <th class="plain" title="Times a year stock is sold through and replaced">Stock turns</th>
      <th class="plain">Promotion ROI</th>
      <th class="plain">Recommendation</th>
    </tr></thead>
    <tbody>${p.map((x) => `
      <tr>
        <td class="name">${esc(x.businessLine)}<span><br>${num(x.transactions)} transactions</span></td>
        <td>${money(x.revenue)}</td>
        <td>${x.marginRatePct}%</td>
        <td class="${x.trendPct >= 0 ? 'win' : 'lose'}">${pct(x.trendPct)}</td>
        <td>$${x.avgTransactionValue}</td>
        <td>${x.daysOfSupply == null
              ? '<span class="chip neutral" title="This line holds no physical stock">no stock</span>'
              : `${x.daysOfSupply} days`}</td>
        <td>${x.inventoryTurns == null ? '-' : `${x.inventoryTurns}x a year`}</td>
        <td>${x.promoRoiPct == null ? '-' : pct(x.promoRoiPct)}</td>
        <td><span class="chip ${chipFor(x.recommendation)}">${esc(x.recommendation)}</span></td>
      </tr>`).join('')}</tbody>`;

  drawChart('chartLob', {
    type: 'bar',
    data: {
      labels: p.map((x) => x.businessLine),
      datasets: [{ data: p.map((x) => x.revenue), backgroundColor: 'rgba(242,98,7,.7)', borderRadius: 5 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.y) } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: '#EFEFEC' }, ticks: { callback: (v) => money(v), font: { size: 11 } } }
      }
    }
  });

  drawChart('chartLobScatter', {
    type: 'scatter',
    data: {
      datasets: [{
        data: p.map((x) => ({ x: x.trendPct, y: x.marginRatePct, n: x.businessLine, r: x.revenue })),
        pointRadius: 9, pointHoverRadius: 12,
        backgroundColor: p.map((x) =>
          x.recommendation === 'Scale' ? 'rgba(22,163,74,.6)'
            : x.recommendation === 'Sustain' ? 'rgba(242,98,7,.55)'
              : 'rgba(220,38,38,.5)')
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => [`${c.raw.n}`, `Trend ${pct(c.raw.x)} \u00b7 Margin ${c.raw.y}%`, `Revenue ${money(c.raw.r)}`]
          }
        }
      },
      scales: {
        x: { title: { display: true, text: 'Trend %', font: { size: 11 } }, grid: { color: '#EFEFEC' },
          ticks: { callback: (v) => `${v}%`, font: { size: 11 } } },
        y: { title: { display: true, text: 'Margin rate %', font: { size: 11 } }, grid: { color: '#EFEFEC' },
          ticks: { callback: (v) => `${v}%`, font: { size: 11 } } }
      }
    }
  });
}

function renderAnomalies() {
  const a = S.analytics.digest.anomalies;
  $('anomTbl').innerHTML = a.length ? `
    <thead><tr>
      <th class="plain">Period</th><th class="plain">Installation</th><th class="plain">Business line</th>
      <th class="plain">Reported change</th><th class="plain">Seasonally adjusted</th>
      <th class="plain">Revenue</th><th class="plain">Z score</th>
    </tr></thead>
    <tbody>${a.map((x) => `
      <tr>
        <td>${mlabel(x.period)}</td>
        <td class="name">${esc(x.installation)}</td>
        <td>${esc(x.businessLine)}</td>
        <td class="${x.changePct >= 0 ? 'win' : 'lose'}">${pct(x.changePct)}</td>
        <td class="${x.adjustedChangePct >= 0 ? 'win' : 'lose'}">${pct(x.adjustedChangePct)}</td>
        <td>${money(x.revenue)}</td>
        <td><span class="chip ${Math.abs(x.zScore) >= 2.5 ? 'lose' : 'warn'}">${x.zScore}</span></td>
      </tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="empty">No movements crossed the two standard deviation threshold once seasonality was removed.</td></tr></tbody>';
}

/* ---------------- Scenario ---------------- */

function scenarioParams() {
  return {
    demandShiftPct: Number($('sDemand').value),
    marginRateDeltaPts: Number($('sMargin').value),
    promoBudgetChangePct: Number($('sPromo').value),
    reallocateLosingSpend: $('sRealloc').checked,
    horizonMonths: 3
  };
}

async function runScenario() {
  const btn = $('btnRunScenario');
  btn.disabled = true;
  try {
    const r = await api('/api/scenario', {
      method: 'POST',
      body: JSON.stringify({ filters: filters(), params: scenarioParams() })
    });
    S.scenario = r;
    renderScenario(r);
  } catch (e) {
    $('scenHeadline').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    $('waterfall').innerHTML = '';
  }
  btn.disabled = false;
}

function renderScenario(r) {
  const up = (n) => (n >= 0 ? 'win' : 'lose');

  $('scenHeadline').innerHTML = `
    <div class="scenhead">
      <div class="item">
        <div class="l">Projected revenue</div>
        <div class="v">${money(r.projected.revenue)}</div>
        <div class="c ${up(r.delta.revenue)}">${r.delta.revenue >= 0 ? '+' : ''}${money(r.delta.revenue)} vs no change (${pct(r.delta.revenuePct)})</div>
      </div>
      <div class="item">
        <div class="l">Projected margin</div>
        <div class="v">${money(r.projected.margin)}</div>
        <div class="c ${up(r.delta.margin)}">${r.delta.margin >= 0 ? '+' : ''}${money(r.delta.margin)} vs no change</div>
      </div>
      <div class="item">
        <div class="l">Margin rate</div>
        <div class="v">${r.projected.marginRatePct}%</div>
        <div class="c">from ${r.baseline.marginRatePct}%</div>
      </div>
    </div>`;

  const row = (cls, label, basis, rev, mar) => `
    <div class="wfrow ${cls}">
      <div>
        <div class="wflabel">${esc(label)}</div>
        ${basis ? `<div class="wfbasis">${esc(basis)}</div>` : ''}
      </div>
      <div class="wfval ${rev === 0 ? '' : up(rev)}">${rev === 0 ? '\u2014' : (rev > 0 ? '+' : '') + money(rev)}</div>
      <div class="wfval ${mar === 0 ? '' : up(mar)}">${mar === 0 ? '\u2014' : (mar > 0 ? '+' : '') + money(mar)}</div>
    </div>`;

  $('waterfall').innerHTML = `
    <div class="wf">
      <div class="wfhead"><span>Effect</span><span>Revenue</span><span>Margin</span></div>
      ${row('base', r.baseline.label, `Seasonal trend projection over ${r.horizonMonths} months`,
        r.baseline.revenue, r.baseline.margin)}
      ${r.steps.length
        ? r.steps.map((st) => row('', st.label, st.basis, st.revenue, st.margin)).join('')
        : '<div class="wfrow"><div class="wfbasis">No levers set. Move a slider to see its effect.</div><div></div><div></div></div>'}
      ${row('total', `Projected total`, '', r.projected.revenue, r.projected.margin)}
    </div>`;

  $('scenAssume').innerHTML = '<b>Assumptions:</b> ' + r.assumptions.map(esc).join(' ');
}

async function explainScenario() {
  const out = $('scenOut');
  out.hidden = false;
  skeleton(out, 3);
  try {
    const r = await api('/api/ai/scenario', {
      method: 'POST',
      body: JSON.stringify({ filters: filters(), params: scenarioParams() })
    });
    typeInto(out, r.text);
    if (r.scenario) { S.scenario = r.scenario; renderScenario(r.scenario); }
  } catch (e) {
    out.textContent = `Could not explain the scenario: ${e.message}`;
  }
}

async function loadScenarios() {
  try {
    const r = await api('/api/scenarios');
    $('scenTbl').innerHTML = r.scenarios.length ? `
      <thead><tr><th class="plain">Name</th><th class="plain">Demand</th><th class="plain">Margin</th>
      <th class="plain">Promo</th><th class="plain">Reallocate</th><th class="plain">Saved</th></tr></thead>
      <tbody>${r.scenarios.map((s) => `
        <tr>
          <td class="name">${esc(s.name)}</td>
          <td>${pct(s.params.demandShiftPct, 0)}</td>
          <td>${s.params.marginRateDeltaPts} pts</td>
          <td>${pct(s.params.promoBudgetChangePct, 0)}</td>
          <td>${s.params.reallocateLosingSpend ? 'Yes' : 'No'}</td>
          <td>${new Date(s.created_at).toLocaleDateString()}</td>
        </tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">No saved scenarios yet.</td></tr></tbody>';
  } catch { /* non-critical */ }
}

/* ---------------- Data explorer ---------------- */

async function loadData() {
  const params = qs({
    page: S.data.page, pageSize: S.data.pageSize, sort: S.data.sort, dir: S.data.dir
  });
  const r = await api(`/api/sales?${params}`);
  let rows = r.rows;
  if (S.data.search) {
    const s = S.data.search.toLowerCase();
    rows = rows.filter((x) =>
      x.installation.toLowerCase().includes(s) ||
      x.category.toLowerCase().includes(s) ||
      x.business_line.toLowerCase().includes(s));
  }

  const editable = canWrite();
  const th = (key, label) =>
    `<th data-k="${key}">${label}${S.data.sort === key ? (S.data.dir === 'asc' ? ' \u2191' : ' \u2193') : ''}</th>`;

  $('dataTbl').innerHTML = `
    <thead><tr>
      ${th('period', 'Period')}${th('installation', 'Installation')}
      ${th('business_line', 'Business line')}${th('category', 'Category')}
      ${th('transactions', 'Txns')}${th('units_sold', 'Units')}
      ${th('revenue', 'Revenue')}${th('cogs', 'COGS')}
      <th class="plain">Gross margin</th>${th('inventory_units', 'Inventory')}
      <th class="plain">Source</th>${editable ? '<th class="plain"></th>' : ''}
    </tr></thead>
    <tbody>${rows.map((x) => `
      <tr data-id="${x.id}">
        <td>${mlabel(x.period)}</td>
        <td class="name">${esc(x.installation)}</td>
        <td>${esc(x.business_line)}</td>
        <td>${esc(x.category)}</td>
        <td>${editable ? `<input type="number" data-f="transactions" value="${x.transactions}">` : num(x.transactions)}</td>
        <td>${editable ? `<input type="number" data-f="units_sold" value="${x.units_sold}">` : num(x.units_sold)}</td>
        <td>${editable ? `<input type="number" step="0.01" data-f="revenue" value="${x.revenue}">` : money(x.revenue)}</td>
        <td>${editable ? `<input type="number" step="0.01" data-f="cogs" value="${x.cogs}">` : money(x.cogs)}</td>
        <td title="Always revenue minus COGS">${money(x.gross_margin)}</td>
        <td>${x.inventory_units == null
              ? '<span class="chip neutral" title="This business line does not carry stock">n/a</span>'
              : (editable ? `<input type="number" data-f="inventory_units" value="${x.inventory_units}">` : num(x.inventory_units))}</td>
        <td><span class="chip neutral">${esc(x.source)}</span></td>
        ${editable ? '<td><button class="btn ghost sm" data-del="1">Delete</button></td>' : ''}
      </tr>`).join('')}</tbody>`;

  $('pgInfo').textContent = `Page ${r.page} of ${r.totalPages || 1} \u00b7 ${num(r.total)} records`;
  $('dataTotals').textContent =
    `Filtered totals: revenue ${money(r.totals.revenue)}, COGS ${money(r.totals.cogs)}, ` +
    `gross margin ${money(r.totals.margin)}, ${num(r.totals.transactions)} transactions, ${num(r.totals.unitsSold)} units. ` +
    `Gross margin is computed as revenue minus COGS and cannot be edited directly.`;
  $('pgPrev').disabled = r.page <= 1;
  $('pgNext').disabled = r.page >= r.totalPages;

  $('dataTbl').querySelectorAll('th[data-k]').forEach((h) => {
    h.onclick = () => {
      const k = h.dataset.k;
      if (S.data.sort === k) S.data.dir = S.data.dir === 'asc' ? 'desc' : 'asc';
      else { S.data.sort = k; S.data.dir = 'asc'; }
      loadData();
    };
  });

  if (editable) {
    $('dataTbl').querySelectorAll('input[data-f]').forEach((inp) => {
      inp.onchange = async () => {
        const tr = inp.closest('tr');
        try {
          await api(`/api/sales/${tr.dataset.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ [inp.dataset.f]: inp.value })
          });
          inp.style.borderColor = 'var(--green)';
          setTimeout(() => { inp.style.borderColor = ''; }, 1200);
          await refresh();
          loadAudit();
        } catch (e) {
          inp.style.borderColor = 'var(--red)';
          dataMsg(e.message, 'err');
        }
      };
    });
    $('dataTbl').querySelectorAll('button[data-del]').forEach((b) => {
      b.onclick = async () => {
        const tr = b.closest('tr');
        if (!confirm('Delete this record?')) return;
        try {
          await api(`/api/sales/${tr.dataset.id}`, { method: 'DELETE' });
          await loadData();
          await refresh();
          loadAudit();
          dataMsg('Record deleted.', 'ok');
        } catch (e) { dataMsg(e.message, 'err'); }
      };
    });
  }
}

function dataMsg(text, kind = 'info') {
  const n = $('dataMsg');
  n.className = `alert ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'info'}`;
  n.textContent = text;
  n.hidden = false;
  setTimeout(() => { n.hidden = true; }, 6000);
}

async function loadAudit() {
  try {
    const r = await api('/api/audit');
    $('auditTbl').innerHTML = r.entries.length ? `
      <thead><tr><th class="plain">When</th><th class="plain">User</th><th class="plain">Entity</th>
      <th class="plain">Action</th></tr></thead>
      <tbody>${r.entries.slice(0, 25).map((e) => `
        <tr>
          <td>${new Date(e.created_at).toLocaleString()}</td>
          <td class="name">${esc(e.email || 'system')}</td>
          <td>${esc(e.entity)}${e.entity_id ? ` #${esc(e.entity_id)}` : ''}</td>
          <td><span class="chip neutral">${esc(e.action)}</span></td>
        </tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">No changes recorded yet.</td></tr></tbody>';
  } catch { /* non-critical */ }
}

function fillAddForm() {
  const p = $('aPeriod'), i = $('aInst'), c = $('aCat');
  p.innerHTML = ''; i.innerHTML = ''; c.innerHTML = '';
  (S.analytics?.months || []).forEach((m) => p.appendChild(new Option(mlabel(m), m)));
  S.meta.installations.forEach((n) => i.appendChild(new Option(n, n)));
  S.meta.categories.forEach((x) =>
    c.appendChild(new Option(`${x.business_line} / ${x.category}`, `${x.business_line}|${x.category}`)));
}

/* ---------------- AI ---------------- */

async function checkAiStatus() {
  try {
    const s = await api('/api/ai/status');
    const engine = s.reachable ? 'asksage' : 'builtin';
    const note = s.error || (s.configured ? '' : 'Ask Sage credentials are not set');
    setEngine('engBrief', 'engBriefTxt', engine, note);
    setEngine('engScore', 'engScoreTxt', engine, note);
  } catch { /* non-critical */ }
}

async function generateBrief() {
  const btn = $('btnBrief'), out = $('briefOut');
  btn.disabled = true;
  $('btnCopy').hidden = true;
  skeleton(out, 6);
  try {
    const r = await api('/api/ai/brief', { method: 'POST', body: JSON.stringify({ filters: filters() }) });
    setEngine('engBrief', 'engBriefTxt', r.engine, r.note);
    typeInto(out, r.text);
    $('btnCopy').hidden = false;
    $('btnCopy').onclick = () => navigator.clipboard.writeText(r.text);
  } catch (e) {
    out.textContent = `Could not generate the briefing: ${e.message}`;
  }
  btn.disabled = false;
}

function addMsg(cls, text) {
  const n = el('div', `msg ${cls}`);
  n.textContent = text;
  $('chat').appendChild(n);
  $('chat').scrollTop = $('chat').scrollHeight;
  return n;
}

async function ask(question) {
  if (!question.trim()) return;
  addMsg('me', question);
  $('askInput').value = '';
  const node = addMsg('ai', '');
  skeleton(node, 2);
  try {
    const r = await api('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({ question, filters: filters() })
    });
    node.innerHTML = '';
    typeInto(node, r.text);
    setTimeout(() => {
      const s = el('span', 'src', r.engine === 'asksage'
        ? `Ask Sage \u00b7 ${esc(r.model || 'model')}` : 'built-in metrics engine');
      node.appendChild(s);
    }, 400);
  } catch (e) {
    node.innerHTML = '';
    node.textContent = `Could not answer: ${e.message}`;
  }
}

async function aiPanel(endpoint, outId, btnId) {
  const out = $(outId), btn = $(btnId);
  btn.disabled = true;
  skeleton(out, 5);
  try {
    const r = await api(endpoint, { method: 'POST', body: JSON.stringify({ filters: filters() }) });
    if (outId === 'scorecardOut') setEngine('engScore', 'engScoreTxt', r.engine, r.note);
    typeInto(out, r.text);
  } catch (e) {
    out.textContent = `Request failed: ${e.message}`;
  }
  btn.disabled = false;
}

/* ---------------- Admin ---------------- */

async function loadUsers() {
  try {
    const r = await api('/auth/users');
    $('userTbl').innerHTML = `
      <thead><tr><th class="plain">Email</th><th class="plain">Name</th><th class="plain">Role</th>
      <th class="plain">Status</th><th class="plain">Last sign in</th><th class="plain"></th></tr></thead>
      <tbody>${r.users.map((u) => `
        <tr data-id="${u.id}">
          <td class="name">${esc(u.email)}</td>
          <td>${esc(u.full_name || '-')}</td>
          <td>
            <select data-role>
              ${['viewer', 'analyst', 'admin'].map((x) =>
                `<option value="${x}" ${u.role === x ? 'selected' : ''}>${x}</option>`).join('')}
            </select>
          </td>
          <td><span class="chip ${u.is_active ? 'win' : 'lose'}">${u.is_active ? 'active' : 'disabled'}</span></td>
          <td>${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'never'}</td>
          <td><button class="btn ghost sm" data-toggle>${u.is_active ? 'Disable' : 'Enable'}</button></td>
        </tr>`).join('')}</tbody>`;

    $('userTbl').querySelectorAll('select[data-role]').forEach((sel) => {
      sel.onchange = async () => {
        const id = sel.closest('tr').dataset.id;
        try {
          await api(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) });
          userMsg('Role updated.', 'ok');
        } catch (e) { userMsg(e.message, 'err'); }
      };
    });
    $('userTbl').querySelectorAll('button[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        const tr = b.closest('tr');
        const enable = b.textContent === 'Enable';
        try {
          await api(`/auth/users/${tr.dataset.id}`, {
            method: 'PATCH', body: JSON.stringify({ is_active: enable })
          });
          loadUsers();
        } catch (e) { userMsg(e.message, 'err'); }
      };
    });
  } catch (e) { userMsg(e.message, 'err'); }
}

function userMsg(text, kind) {
  const n = $('userMsg');
  n.className = `alert ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'info'}`;
  n.textContent = text;
  n.hidden = false;
  setTimeout(() => { n.hidden = true; }, 5000);
}

async function loadAiLog() {
  try {
    const r = await api('/api/ai/log');
    $('aiLogTbl').innerHTML = r.entries.length ? `
      <thead><tr><th class="plain">When</th><th class="plain">User</th><th class="plain">Type</th>
      <th class="plain">Engine</th><th class="plain">Latency</th><th class="plain">Result</th></tr></thead>
      <tbody>${r.entries.slice(0, 30).map((e) => `
        <tr>
          <td>${new Date(e.created_at).toLocaleString()}</td>
          <td class="name">${esc(e.email || '-')}</td>
          <td>${esc(e.kind)}</td>
          <td>${esc(e.engine)}</td>
          <td>${e.latency_ms ? `${e.latency_ms} ms` : '-'}</td>
          <td><span class="chip ${e.ok ? 'win' : 'lose'}">${e.ok ? 'ok' : 'fallback'}</span></td>
        </tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="empty">No AI calls recorded yet.</td></tr></tbody>';
  } catch { /* non-critical */ }
}


/* ---------------- Admin: data status and loading ---------------- */

async function loadDataStatus() {
  const dbBox = $('dbStatus'), fileBox = $('fileStatus');
  try {
    const s = await api('/api/data-status');
    const db = s.database;

    dbBox.innerHTML = db.salesRows
      ? `
        <div class="kpirow"><div class="kl">Sales records</div><div class="kv"><span class="dot ok"></span>${num(db.salesRows)}</div></div>
        <div class="kpirow"><div class="kl">Period covered</div><div class="kv">${mlabel(db.firstPeriod + '-01')} to ${mlabel(db.lastPeriod + '-01')}</div></div>
        <div class="kpirow"><div class="kl">Total revenue</div><div class="kv">${money(db.totalRevenue)}</div></div>
        <div class="kpirow"><div class="kl">Installations / categories</div><div class="kv">${db.installations} / ${db.categories}</div></div>
        <div class="kpirow"><div class="kl">Campaigns</div><div class="kv">${num(db.campaigns)}</div></div>`
      : `<div class="kpirow"><div class="kl">Sales records</div><div class="kv"><span class="dot off"></span>none</div></div>
         <div class="hint" style="margin-top:8px">The dashboard will stay empty until data is loaded.</div>`;

    const f = s.dataset;
    if (!f.present) {
      fileBox.innerHTML = `
        <div class="kpirow"><div class="kl">dataset.json</div><div class="kv"><span class="dot off"></span>missing</div></div>
        <div class="hint" style="margin-top:8px">The file is not on the server. Commit <b>dataset.json</b> at the repo root and redeploy, or import a CSV from the Data tab.</div>`;
    } else if (f.error) {
      fileBox.innerHTML = `<div class="kpirow"><div class="kl">dataset.json</div><div class="kv"><span class="dot off"></span>unreadable</div></div>
        <div class="hint" style="margin-top:8px">${esc(f.error)}</div>`;
    } else {
      fileBox.innerHTML = `
        <div class="kpirow"><div class="kl">dataset.json</div><div class="kv"><span class="dot ok"></span>${f.sizeKb} KB</div></div>
        <div class="kpirow"><div class="kl">Sales rows available</div><div class="kv">${num(f.salesRows)}</div></div>
        <div class="kpirow"><div class="kl">Campaigns available</div><div class="kv">${num(f.campaigns)}</div></div>
        ${f.source ? `<div class="kpirow"><div class="kl">Source</div><div class="kv">${esc(f.source)}</div></div>` : ''}`;
    }
  } catch (e) {
    dbBox.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    fileBox.innerHTML = '';
  }
}

function loadMsg(text, kind = 'info') {
  const n = $('loadMsg');
  n.className = `alert ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : 'info'}`;
  n.innerHTML = text;
  n.hidden = false;
}

async function doLoadData(replace) {
  const btns = [$('btnLoadData'), $('btnReloadData')];
  btns.forEach((b) => { b.disabled = true; });
  loadMsg(replace ? 'Replacing all data...' : 'Loading data...', 'info');
  try {
    const r = await api('/api/load-data', {
      method: 'POST', body: JSON.stringify({ replace: !!replace })
    });
    loadMsg(`Loaded ${num(r.salesRows)} sales records covering ${r.firstPeriod} to ${r.lastPeriod}, ` +
      `total revenue ${money(r.totalRevenue)}.`, 'ok');
    S.meta = await api('/api/meta');
    fillFilters();
    await loadDataStatus();
    await refresh();
  } catch (e) {
    loadMsg(`Load failed: ${esc(e.message)}`, 'err');
  }
  btns.forEach((b) => { b.disabled = false; });
}

/* ---------------- Charts ---------------- */

function drawChart(id, config) {
  const canvas = $(id);
  if (!canvas) return;
  if (S.charts[id]) S.charts[id].destroy();
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.color = '#6E7681';
  S.charts[id] = new Chart(canvas.getContext('2d'), config);
}

/* ---------------- Wiring ---------------- */

function wire() {
  // Tabs
  $('tabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${b.dataset.v}`));
      location.hash = b.dataset.v;
      if (b.dataset.v === 'admin') {
        fillAddForm(); loadData(); loadAudit();
        if (S.user.role === 'admin') { loadUsers(); loadAiLog(); loadDataStatus(); }
      }
      if (b.dataset.v === 'scenario') { loadScenarios(); runScenario(); }
    };
  });
  const hash = location.hash.replace('#', '');
  if (hash) {
    const btn = $('tabs').querySelector(`button[data-v="${hash}"]`);
    if (btn && !btn.hidden) btn.click();
  }

  // Filters
  ['fInst', 'fBL', 'fFrom', 'fTo'].forEach((id) => {
    $(id).onchange = async () => {
      await refresh();
      if ($('v-data').classList.contains('on')) loadData();
    };
  });
  $('btnReset').onclick = async () => {
    $('fInst').value = 'all'; $('fBL').value = 'all';
    $('fFrom').value = ''; $('fTo').value = '';
    S.promoFilter = { channel: new Set(), bl: new Set(), inst: new Set(), result: 'all' };
    S.selectedCampaign = null;
    await refresh();
  };

  // Metric toggle
  $('metricSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('metricSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      S.metric = b.dataset.m;
      renderSales();
    };
  });

  // Scenario
  const bind = (slider, label, fmt) => {
    const upd = () => { $(label).textContent = fmt($(slider).value); };
    $(slider).oninput = upd;
    upd();
  };
  const noneIfZero = (v, fmt) => (Number(v) === 0 ? 'no change' : fmt(v));
  bind('sDemand', 'vDemand', (v) => noneIfZero(v, (x) => `${x > 0 ? '+' : ''}${x}%`));
  bind('sMargin', 'vMargin', (v) => noneIfZero(v, (x) => `${x > 0 ? '+' : ''}${Number(x).toFixed(1)} points`));
  bind('sPromo', 'vPromo', (v) => noneIfZero(v, (x) => `${x > 0 ? '+' : ''}${x}%`));
  $('btnRunScenario').onclick = runScenario;
  $('btnExplainScenario').onclick = explainScenario;
  $('btnResetScenario').onclick = () => {
    $('sDemand').value = 0; $('sMargin').value = 0; $('sPromo').value = 0;
    $('sRealloc').checked = false;
    ['sDemand', 'sMargin', 'sPromo'].forEach((id) => $(id).dispatchEvent(new Event('input')));
    runScenario();
  };
  // Live update, so moving a lever shows its effect without a second click.
  ['sDemand', 'sMargin', 'sPromo'].forEach((id) => {
    $(id).addEventListener('change', runScenario);
  });
  $('sRealloc').addEventListener('change', runScenario);
  $('btnSaveScenario').onclick = async () => {
    const name = prompt('Name this scenario');
    if (!name) return;
    try {
      await api('/api/scenarios', {
        method: 'POST', body: JSON.stringify({ name, params: scenarioParams() })
      });
      loadScenarios();
    } catch (e) { alert(e.message); }
  };

  // Data explorer
  $('pgPrev').onclick = () => { if (S.data.page > 1) { S.data.page--; loadData(); } };
  $('pgNext').onclick = () => { S.data.page++; loadData(); };
  $('pageSize').onchange = () => { S.data.pageSize = Number($('pageSize').value); S.data.page = 1; loadData(); };
  let searchTimer;
  $('dataSearch').oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.data.search = $('dataSearch').value; loadData(); }, 250);
  };
  $('btnExport').onclick = () => { window.location.href = `/api/sales/export?${qs()}`; };
  $('btnImport').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async () => {
    const file = $('fileInput').files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    dataMsg('Importing...', 'info');
    try {
      const r = await api('/api/sales/import', { method: 'POST', body: fd });
      dataMsg(`Imported ${r.imported} records. ${r.rejected ? `${r.rejected} rejected: ${r.errors[0]}` : ''}`,
        r.rejected ? 'err' : 'ok');
      await loadData();
      await refresh();
      loadAudit();
    } catch (e) { dataMsg(e.message, 'err'); }
    $('fileInput').value = '';
  };
  $('btnAddRow').onclick = () => { $('addCard').hidden = false; fillAddForm(); };
  $('btnCancelRow').onclick = () => { $('addCard').hidden = true; };
  $('btnSaveRow').onclick = async () => {
    const [bl, cat] = $('aCat').value.split('|');
    try {
      await api('/api/sales', {
        method: 'POST',
        body: JSON.stringify({
          period: $('aPeriod').value,
          installation: $('aInst').value,
          business_line: bl,
          category: cat,
          transactions: $('aTxn').value,
          units_sold: $('aUnits').value,
          revenue: $('aRev').value,
          cogs: $('aCogs').value,
          inventory_units: $('aInv').value
        })
      });
      $('addCard').hidden = true;
      dataMsg('Record saved.', 'ok');
      await loadData();
      await refresh();
      loadAudit();
    } catch (e) { dataMsg(e.message, 'err'); }
  };

  // AI
  $('btnBrief').onclick = generateBrief;
  $('btnAsk').onclick = () => ask($('askInput').value);
  $('askInput').onkeydown = (e) => { if (e.key === 'Enter') ask($('askInput').value); };
  $('chips').querySelectorAll('button').forEach((b) => { b.onclick = () => ask(b.textContent); });
  $('btnScorecardAI').onclick = () => aiPanel('/api/ai/scorecard', 'scorecardOut', 'btnScorecardAI');
  $('btnAnomalies').onclick = () => aiPanel('/api/ai/anomalies', 'anomOut', 'btnAnomalies');

  // Admin
  $('btnAddUser').onclick = async () => {
    try {
      await api('/auth/users', {
        method: 'POST',
        body: JSON.stringify({
          email: $('nuEmail').value,
          full_name: $('nuName').value,
          password: $('nuPass').value,
          role: $('nuRole').value
        })
      });
      $('nuEmail').value = ''; $('nuName').value = ''; $('nuPass').value = '';
      userMsg('User created.', 'ok');
      loadUsers();
    } catch (e) { userMsg(e.message, 'err'); }
  };

  $('btnClearPromo').onclick = () => {
    S.promoFilter = { channel: new Set(), bl: new Set(), inst: new Set(), result: 'all' };
    S.selectedCampaign = null;
    renderPromoFilters();
    renderPromo();
  };

  $('btnLoadData').onclick = () => doLoadData(false);
  $('btnReloadData').onclick = () => {
    if (confirm('Replace all sales, campaign, installation and category data?\n\nAny edits made in the app will be discarded. User accounts are not affected.')) {
      doLoadData(true);
    }
  };
  $('btnRefreshStatus').onclick = loadDataStatus;

  $('btnLogout').onclick = async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  document.addEventListener('scroll', hideTip, { passive: true });
}

boot().catch((e) => console.error('Boot failed:', e));
