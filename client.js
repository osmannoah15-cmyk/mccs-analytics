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
  promoFilter: { channel: 'all', bl: 'all', inst: 'all', result: 'all' },
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

/* ---------------- Boot ---------------- */

async function boot() {
  try {
    const me = await api('/auth/me');
    S.user = me.user;
    $('userName').textContent = S.user.name;
    $('userRole').textContent = S.user.role;
    $('userInitials').textContent = String(S.user.name || S.user.email)
      .split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '--';
    // Analysts need the data tools, admins additionally get accounts and logs.
    if (['admin', 'analyst'].includes(S.user.role)) {
      $('tabAdmin').hidden = false;
      $('railAdminLabel').hidden = false;
    }
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
    ? `${num(rows)} records \u00b7 ${m.installations.length} installations \u00b7 ${m.businessLines.length} lines of business`
    : 'No data loaded';

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
    $('kpis').innerHTML = `<div class="stat" style="border:0"><div class="stat-s">${
      anyData
        ? 'No records match these filters. Widen the selection or reset.'
        : (S.user?.role === 'admin'
            ? 'No sales data loaded. Open Admin and choose Load data.'
            : 'No sales data loaded. Ask an administrator to load it.')
    }</div></div>`;
    return;
  }
  S.analytics = data;
  if (!$('fFrom').options.length || $('fFrom').options.length === 1) fillPeriodPickers(data.months);

  renderKpis();
  renderOpportunities();
  renderSales();
  await loadCampaigns();
  renderLob();
  renderAnomalies();
}

/* ---------------- KPIs ---------------- */

function renderKpis() {
  const d = S.analytics.digest;
  const h = d.headline;
  const dir = (n) => (n == null ? '' : n >= 0 ? 'up' : 'down');

  const items = [
    { l: `Revenue, ${mlabel(d.coverage.latestPeriod)}`, v: money(h.latestRevenue),
      s: `${pct(h.momPct)} on the month`, c: dir(h.momPct) },
    { l: 'Year on year', v: pct(h.yoyPct), s: 'same month last year', c: dir(h.yoyPct) },
    { l: 'Gross margin rate', v: `${h.latestMarginRatePct}%`, s: `${money(h.totalMargin)} to date` },
    { l: 'Average transaction', v: `$${h.avgTransactionValue}`, s: `${num(h.latestTransactions)} transactions` },
    { l: 'Next three months', v: money(d.forecast.total), s: `${d.forecast.mapePct}% model error` },
    { l: 'Campaigns earning', v: `${d.campaigns.profitable}/${d.campaigns.total}`,
      s: `${money(d.campaigns.spendInNegativeRoi)} not returning` }
  ];

  $('kpis').innerHTML = items.map((i) => `
    <div class="stat">
      <div class="stat-l">${esc(i.l)}</div>
      <div class="stat-v">${esc(i.v)}</div>
      <div class="stat-s ${i.c || ''}">${esc(i.s)}</div>
    </div>`).join('');
}

function renderOpportunities() {
  const d = S.analytics.digest;
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
        { label: 'Actual', data: [...actual], borderColor: PALETTE.scarlet,
          backgroundColor: PALETTE.scarletFill, borderWidth: 1.75,
          pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: PALETTE.scarlet,
          tension: .2, fill: true },
        { label: 'Forecast', data: fLine, borderColor: PALETTE.slate, borderWidth: 1.75,
          borderDash: [4, 3], pointRadius: 0, pointHoverRadius: 4, tension: .2 },
        { label: 'High', data: fHigh, borderColor: 'transparent',
          backgroundColor: PALETTE.slateFill, pointRadius: 0, fill: '+1' },
        { label: 'Low', data: fLow, borderColor: 'transparent',
          backgroundColor: PALETTE.slateFill, pointRadius: 0, fill: false }
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
        x: { grid: { display: false }, border: { color: '#E3E5E1' },
          ticks: { maxRotation: 0, autoSkipPadding: 18 } },
        y: { grid: { color: PALETTE.grid }, border: { display: false },
          ticks: { callback: (v) => money(v), padding: 8 } }
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
        const bg = above
          ? `rgba(163,24,43,${(strength * .40).toFixed(3)})`
          : `rgba(58,90,115,${(strength * .16).toFixed(3)})`;
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
  fillPromoFilters();
  renderPromo();
}

function fillPromoFilters() {
  const all = S.campaigns;
  const fill = (id, values, placeholder) => {
    const sel = $(id);
    const keep = sel.value;
    sel.innerHTML = `<option value="all">${placeholder}</option>`;
    values.forEach((v) => sel.appendChild(new Option(v, v)));
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  };
  fill('fChannel', [...new Set(all.map((c) => c.channel))].sort(), 'All channels');
  fill('fLob', [...new Set(all.map((c) => c.businessLine))].sort(), 'All lines of business');
  fill('fBase', [...new Set(all.map((c) => c.installation))].sort(), 'All installations');

  $('resSeg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.res === S.promoFilter.result);
  });
  $('btnClearPromo').hidden = !promoFiltered();
}

function promoFiltered() {
  const f = S.promoFilter;
  return f.channel !== 'all' || f.bl !== 'all' || f.inst !== 'all' || f.result !== 'all';
}

function visibleCampaigns() {
  const f = S.promoFilter;
  return S.campaigns.filter((c) =>
    (f.channel === 'all' || c.channel === f.channel) &&
    (f.bl === 'all' || c.businessLine === f.bl) &&
    (f.inst === 'all' || c.installation === f.inst) &&
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
          ? 'rgba(163,24,43,.62)'
          : (c.profitable ? 'rgba(47,106,76,.42)' : 'rgba(163,24,43,.34)')),
        borderColor: cs.map((c) => S.selectedCampaign === c.id
          ? PALETTE.scarlet : (c.profitable ? PALETTE.green : '#8E1626')),
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
        x: { title: { display: true, text: 'Spend', font: { size: 11 } }, grid: { color: PALETTE.grid },
          ticks: { callback: (v) => money(v), font: { size: 11 } } },
        y: { title: { display: true, text: 'ROI %', font: { size: 11 } }, grid: { color: PALETTE.grid },
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
        backgroundColor: chans.map((c) => S.promoFilter.channel === c.channel
          ? PALETTE.scarlet
          : (c.roiPct >= 0 ? PALETTE.greenFill : 'rgba(163,24,43,.42)')),
        borderRadius: 1
      }]
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      onClick: (evt, els) => {
        if (!els.length) return;
        const ch = chans[els[0].index].channel;
        S.promoFilter.channel = S.promoFilter.channel === ch ? 'all' : ch;
        S.selectedCampaign = null;
        fillPromoFilters();
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
        x: { grid: { color: PALETTE.grid }, ticks: { callback: (v) => `${v}%`, font: { size: 11 } } },
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

  // Bring the selected campaign into view. Clicking a bubble in the scatter
  // is otherwise easy to miss when the row sits far down a long table.
  if (S.selectedCampaign != null) {
    const row = $('campTbl').querySelector(`tr[data-id="${S.selectedCampaign}"]`);
    const box = $('campScroll');
    if (row && box) {
      const target = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2;
      box.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1200);
    }
  }
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
      datasets: [{ data: p.map((x) => x.revenue), backgroundColor: 'rgba(163,24,43,.62)', borderRadius: 1 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => money(c.parsed.y) } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: PALETTE.grid }, ticks: { callback: (v) => money(v), font: { size: 11 } } }
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
          x.recommendation === 'Scale' ? 'rgba(47,106,76,.62)'
            : x.recommendation === 'Sustain' ? 'rgba(58,90,115,.55)'
              : 'rgba(163,24,43,.55)')
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
        x: { title: { display: true, text: 'Trend %', font: { size: 11 } }, grid: { color: PALETTE.grid },
          ticks: { callback: (v) => `${v}%`, font: { size: 11 } } },
        y: { title: { display: true, text: 'Margin rate %', font: { size: 11 } }, grid: { color: PALETTE.grid },
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
}

function renderScenario(r) {
  const d = r.delta.margin;
  const cls = d > 0 ? 'win' : d < 0 ? 'lose' : '';
  const sign = d > 0 ? '+' : '';

  $('scenHeadline').innerHTML = `
    <div class="resulthead">
      <div class="cap">Change in margin</div>
      <div class="big ${cls}">${sign}${money(d)}</div>
      <div class="sub2">
        Margin goes from ${money(r.baseline.margin)} to ${money(r.projected.margin)}.<br>
        Revenue goes from ${money(r.baseline.revenue)} to ${money(r.projected.revenue)}${
          r.delta.revenue ? ` (${pct(r.delta.revenuePct)})` : ''}.
      </div>
    </div>`;

  if (!r.steps.length) {
    $('waterfall').innerHTML = '<div class="empty">Move a lever to see its effect.</div>';
    $('scenAssume').innerHTML = '';
    return;
  }

  const row = (label, val) => `
    <div class="erow">
      <span class="elabel">${esc(label)}</span>
      <span class="eval ${val > 0 ? 'win' : val < 0 ? 'lose' : ''}">${val > 0 ? '+' : ''}${money(val)}</span>
    </div>`;

  $('waterfall').innerHTML = `
    <div class="effects">
      <div class="ehead"><span>Where it comes from</span><span>Margin</span></div>
      ${r.steps.map((st) => row(st.label, st.margin)).join('')}
      <div class="etotal">
        <span>Total change</span>
        <span class="eval ${cls}">${sign}${money(d)}</span>
      </div>
    </div>`;

  $('scenAssume').innerHTML = `
    <details class="explain">
      <summary>Assumptions behind these figures</summary>
      <dl>${r.steps.map((st) => `<dt>${esc(st.label)}</dt><dd>${esc(st.basis)}</dd>`).join('')}
      <dt>Held constant</dt><dd>${r.assumptions.map(esc).join(' ')}</dd></dl>
    </details>`;
}

async function explainScenario() {
  const out = $('scenOut');
  $('scenExplainCard').hidden = false;
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


/* ---------------- Report export ----------------
   Assembled as its own document rather than printed from the screen, because
   printing the app drags along the rail, the controls and the clipped scroll
   regions. Sections are numbered and listed in a contents page so the reader
   can navigate it the way they would any other briefing document.
*/

const REPORT_PAGES = {
  sales: 'Sales and forecast',
  promo: 'Promotion return on investment',
  lob: 'Lines of business',
  scenario: 'Scenario'
};

function activeView() {
  const on = $('tabs').querySelector('button.on');
  return on ? on.dataset.v : 'sales';
}

/* The section builders below read from a context rather than global state, so
   the same code produces the enterprise report and each installation's part.
   CTX is null for the enterprise report, which falls back to what is loaded. */
let CTX = null;
const ctx = () => CTX || {
  label: null,
  digest: S.analytics.digest,
  months: S.analytics.months,
  movers: S.analytics.movers,
  campaigns: S.campaigns,
  images: null
};

function filterScope() {
  const f = filters();
  const months = S.analytics?.months || [];
  const from = f.from || months[0];
  const to = f.to || months[months.length - 1];
  const parts = [
    f.installation === 'all' ? 'All installations' : f.installation,
    f.businessLine === 'all' ? 'all lines of business' : f.businessLine
  ];
  if (from && to) parts.push(`${mlabel(from)} to ${mlabel(to)}`);
  return parts.join(', ');
}

function chartPng(id, scale = 3) {
  const c = S.charts[id];
  if (!c) return null;
  let plain = null;
  try { plain = c.toBase64Image('image/png', 1); } catch { return null; }
  const previous = c.options.devicePixelRatio;
  let hi = null;
  try {
    c.options.devicePixelRatio = scale;
    c.options.animation = false;
    c.resize(); c.update('none');
    hi = c.toBase64Image('image/png', 1);
  } catch { hi = null; }
  finally {
    c.options.devicePixelRatio = previous;
    try { c.resize(); c.update('none'); } catch { /* disposed */ }
  }
  return (hi && plain && hi.length > plain.length) ? hi : plain;
}

const repChart = (id, alt) => {
  const c = ctx();
  const src = (c.images && c.images[id]) || (c.images ? null : chartPng(id));
  return src ? `<div class="rep-chart"><img src="${src}" alt="${esc(alt || '')}"></div>` : '';
};

/**
 * Render a chart away from the screen so a report can contain a chart for a
 * slice of data that is not currently displayed. Chart.js sizes itself from
 * layout, so the host is pushed off-canvas rather than hidden.
 */
function offscreenChart(config, w = 780, h = 300, scale = 3) {
  const farm = $('chartFarm');
  const box = document.createElement('div');
  box.style.cssText = `width:${w}px;height:${h}px`;
  const canvas = document.createElement('canvas');
  box.appendChild(canvas);
  farm.appendChild(box);

  let png = null;
  let chart = null;
  try {
    config.options = {
      ...(config.options || {}),
      responsive: true, maintainAspectRatio: false,
      animation: false, devicePixelRatio: scale
    };
    config.options.plugins = { ...(config.options.plugins || {}), legend: { display: false } };
    chart = new Chart(canvas.getContext('2d'), config);
    png = chart.toBase64Image('image/png', 1);
  } catch (e) {
    console.warn('offscreen chart failed:', e.message);
  } finally {
    if (chart) chart.destroy();
    box.remove();
  }
  return png;
}

/** Revenue actuals with the projection appended, for one slice of the data. */
function cfgRevenue(analytics) {
  const actual = analytics.series.revenue;
  const fc = analytics.forecast.periods || [];
  const labels = [...analytics.months.map(mlabel), ...fc.map((p) => mlabel(p.period))];
  const pad = new Array(analytics.months.length - 1).fill(null);
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual', data: [...actual], borderColor: PALETTE.scarlet,
          backgroundColor: PALETTE.scarletFill, borderWidth: 1.75, pointRadius: 0, tension: .2, fill: true },
        { label: 'Forecast', data: [...pad, actual[actual.length - 1], ...fc.map((p) => p.value)],
          borderColor: PALETTE.slate, borderWidth: 1.75, borderDash: [4, 3], pointRadius: 0, tension: .2 }
      ]
    },
    options: {
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 18 } },
        y: { grid: { color: PALETTE.grid }, ticks: { callback: (v) => money(v), padding: 8 } }
      }
    }
  };
}

/** Revenue by line of business, for one slice of the data. */
function cfgLines(digest) {
  const p = digest.linesOfBusiness;
  return {
    type: 'bar',
    data: {
      labels: p.map((x) => x.businessLine),
      datasets: [{ data: p.map((x) => x.revenue), backgroundColor: 'rgba(163,24,43,.62)', borderRadius: 1 }]
    },
    options: {
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: PALETTE.grid }, ticks: { callback: (v) => money(v), padding: 8 } }
      }
    }
  };
}

/** Fetch one installation's slice and pre-render its charts. */
async function installationContext(name) {
  const q = new URLSearchParams(
    Object.entries({ ...filters(), installation: name }).filter(([, v]) => v != null && v !== '')
  ).toString();
  const [analytics, camps] = await Promise.all([
    api(`/api/analytics?${q}`),
    api(`/api/campaigns?${q}`)
  ]);
  if (analytics.empty) return null;
  return {
    label: name,
    digest: analytics.digest,
    months: analytics.months,
    movers: analytics.movers,
    campaigns: camps.campaigns,
    images: {
      chartMain: offscreenChart(cfgRevenue(analytics), 780, 300),
      chartLob: offscreenChart(cfgLines(analytics.digest), 780, 260)
    }
  };
}

const repTable = (headers, rows) => `
  <table class="rep-table">
    <thead><tr>${headers.map((h) => {
      const c = (h && typeof h === 'object') ? h : { t: h };
      return `<th class="${c.r ? 'r' : ''}">${esc(c.t)}</th>`;
    }).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => {
      const cell = (c && typeof c === 'object') ? c : { t: c };
      return `<td class="${cell.r ? 'r' : ''} ${cell.cls || ''}">${esc(cell.t ?? '')}</td>`;
    }).join('')}</tr>`).join('')}</tbody>
  </table>`;

const repBlock = (title, body, note) => `
  <div class="rep-block">
    ${title ? `<h3>${esc(title)}</h3>` : ''}
    ${body}
    ${note ? `<div class="rep-note">${esc(note)}</div>` : ''}
  </div>`;

const repSection = (n, title, body) => `
  <section class="rep-sec">
    <h2><span class="n">${n}</span><span>${esc(title)}</span></h2>
    ${body}
  </section>`;

/* ---- Section 1: summary, always present ---- */
function secSummary(n, summaryText) {
  const d = ctx().digest;
  const h = d.headline;
  const figs = [
    ['Revenue, ' + mlabel(d.coverage.latestPeriod), money(h.latestRevenue), pct(h.momPct) + ' on the month'],
    ['Year on year', pct(h.yoyPct), 'against the same month last year'],
    ['Gross margin rate', `${h.latestMarginRatePct}%`, money(h.totalMargin) + ' of margin to date'],
    ['Average transaction', `$${h.avgTransactionValue}`, num(h.latestTransactions) + ' transactions'],
    ['Next three months', money(d.forecast.total), `${d.forecast.mapePct}% in-sample error`],
    ['Campaigns earning', `${d.campaigns.profitable} of ${d.campaigns.total}`, money(d.campaigns.spendInNegativeRoi) + ' not returning cost']
  ];

  const figsHtml = `<div class="rep-figs">${figs.map(([l, v, sfx]) => `
    <div class="rep-fig"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(sfx)}</div></div>`).join('')}</div>`;

  const findings = `
    <div class="rep-block">
      <h3>Where the money is</h3>
      ${d.opportunities.items.map((o) => `
        <div class="rep-find">
          <div class="v">${money(o.value)}</div>
          <div class="l">${esc(o.label)}</div>
          <div class="b">${esc(o.basis)}</div>
          <div class="t">${esc(o.loe)}</div>
        </div>`).join('')}
      <div class="rep-note">Figures are not additive: the first two describe the same pool of promotional spend seen two ways.</div>
    </div>`;

  return repSection(n, 'Summary',
    figsHtml +
    (summaryText ? repBlock('Assessment', `<div class="rep-prose">${esc(summaryText)}</div>`,
      'Written from the computed figures in this report.') : '') +
    findings);
}

/* ---- Analysis sections ---- */
function secSales(n) {
  const d = ctx().digest;
  const movers = ctx().movers;
  return repSection(n, 'Sales and forecast',
    `<p class="rep-lead">Revenue reached ${money(d.headline.latestRevenue)} in ${mlabel(d.coverage.latestPeriod)}, ${pct(d.headline.momPct)} on the month. The projection below covers the following three months.</p>` +
    repBlock('Monthly performance', repChart('chartMain', 'Monthly revenue with a three month projection'),
      `Actuals with a three month projection and an 80% interval. The projection totals ${money(d.forecast.total)}.`) +
    repBlock('Installations, ranked by growth', repTable(
      ['Installation', { t: 'Revenue', r: 1 }, { t: 'Margin', r: 1 }, { t: 'Margin rate', r: 1 }, { t: 'Growth', r: 1 }],
      d.installations.map((i) => [
        i.installation, { t: money(i.revenue), r: 1 }, { t: money(i.margin), r: 1 },
        { t: i.marginRatePct + '%', r: 1 },
        { t: pct(i.growthPct), r: 1, cls: i.growthPct >= 0 ? 'pos' : 'neg' }])),
      'Growth compares the recent half of the period with the earlier half.') +
    repBlock('Largest movements by category', repTable(
      ['Category', { t: 'Prior month', r: 1 }, { t: 'Latest month', r: 1 }, { t: 'Change', r: 1 }],
      movers.slice(0, 6).concat(movers.slice(-4)).map((m) => [
        m.label, { t: money(m.before), r: 1 }, { t: money(m.after), r: 1 },
        { t: pct(m.changePct), r: 1, cls: m.changePct >= 0 ? 'pos' : 'neg' }])),
      'The six largest increases and four largest decreases.'));
}

function secPromo(n) {
  const cs = CTX ? CTX.campaigns : visibleCampaigns();
  const spend = cs.reduce((a, c) => a + c.spend, 0);
  const net = cs.reduce((a, c) => a + c.netMargin, 0);
  const losing = cs.filter((c) => !c.profitable).sort((a, b) => a.roiPct - b.roiPct);
  const best = [...cs].sort((a, b) => b.roiPct - a.roiPct).slice(0, 10);
  const f = S.promoFilter;
  const applied = [
    f.channel !== 'all' ? `channel ${f.channel}` : null,
    f.bl !== 'all' ? `line of business ${f.bl}` : null,
    f.inst !== 'all' ? `installation ${f.inst}` : null,
    f.result !== 'all' ? (f.result === 'win' ? 'earning campaigns only' : 'losing campaigns only') : null
  ].filter(Boolean);

  return repSection(n, 'Promotion return on investment',
    `<p class="rep-lead">${cs.length} of ${CTX ? cs.length : S.campaigns.length} campaigns are in scope, carrying ${money(spend)} of spend and returning ${money(net)} net.${
      applied.length ? ' Filtered to ' + esc(applied.join(', ')) + '.' : ''} Return is incremental margin less spend, over spend, so zero is break-even.</p>` +
    repBlock('Spend against return', repChart('chartScatter', 'Campaign spend against return'),
      'Each point is a campaign. Anything below zero did not return its cost.') +
    repBlock('Channel economics', repChart('chartChannels', 'Return by channel')) +
    (losing.length ? repBlock('Campaigns not returning their cost', repTable(
      ['Campaign', 'Channel', 'Installation', { t: 'Spend', r: 1 }, { t: 'Incr. margin', r: 1 }, { t: 'ROI', r: 1 }],
      losing.map((c) => [c.name, c.channel, c.installation,
        { t: money(c.spend), r: 1 }, { t: money(c.incrementalMargin), r: 1 },
        { t: pct(c.roiPct), r: 1, cls: 'neg' }])),
      `${losing.length} campaigns, ${money(losing.reduce((a, c) => a + c.spend, 0))} of spend. This is the first place to look for recoverable money.`) : '') +
    repBlock('Ten strongest campaigns', repTable(
      ['Campaign', 'Channel', { t: 'Spend', r: 1 }, { t: 'Lift', r: 1 }, { t: 'ROI', r: 1 }],
      best.map((c) => [c.name, c.channel, { t: money(c.spend), r: 1 },
        { t: pct(c.liftPct), r: 1 }, { t: pct(c.roiPct), r: 1, cls: 'pos' }]))));
}

function secLob(n) {
  const d = ctx().digest;
  return repSection(n, 'Lines of business',
    `<p class="rep-lead">Each line is assessed on margin rate, direction of travel, and the return on its promotional spend. The recommendation is a rule applied to those inputs, all of which appear in the row, so it can be challenged rather than taken on trust.</p>` +
    repBlock('Portfolio', repTable(
      ['Line of business', { t: 'Revenue', r: 1 }, { t: 'Margin rate', r: 1 }, { t: 'Trend', r: 1 },
       { t: 'Avg transaction', r: 1 }, { t: 'Stock cover', r: 1 }, { t: 'Promotion ROI', r: 1 }, 'Recommendation'],
      d.linesOfBusiness.map((x) => [
        x.businessLine, { t: money(x.revenue), r: 1 }, { t: x.marginRatePct + '%', r: 1 },
        { t: pct(x.trendPct), r: 1, cls: x.trendPct >= 0 ? 'pos' : 'neg' },
        { t: '$' + x.avgTransactionValue, r: 1 },
        { t: x.daysOfSupply == null ? 'no stock' : x.daysOfSupply + ' days', r: 1 },
        { t: x.promoRoiPct == null ? '-' : pct(x.promoRoiPct), r: 1 },
        x.recommendation])),
      'Scale where the trend exceeds 6% and margin rate exceeds 25%. Review where the trend is negative or margin rate falls below 15%. Stock cover is the days of selling that stock on hand would cover, and applies only to lines holding physical stock.') +
    repBlock('Revenue by line of business', repChart('chartLob', 'Revenue by line of business')) +
    (d.anomalies.length ? repBlock('Unusual movements', repTable(
      ['Period', 'Installation', 'Line of business', { t: 'Reported', r: 1 }, { t: 'Adjusted', r: 1 }, { t: 'Z score', r: 1 }],
      d.anomalies.slice(0, 10).map((a) => [
        mlabel(a.period), a.installation, a.businessLine,
        { t: pct(a.changePct), r: 1, cls: a.changePct >= 0 ? 'pos' : 'neg' },
        { t: pct(a.adjustedChangePct), r: 1, cls: a.adjustedChangePct >= 0 ? 'pos' : 'neg' },
        { t: String(a.zScore), r: 1 }])),
      'Reported is the raw month on month change. Adjusted removes the seasonal pattern, so a normal post-holiday fall is not reported as an exception. A line can fall in reported terms yet still beat its own seasonal expectation.') : ''));
}

function secScenario(n) {
  const r = S.scenario;
  if (!r) {
    return repSection(n, 'Scenario', repBlock(null,
      '<p class="rep-lead">No scenario was run. Set the levers on the Scenario page and export again to include one.</p>'));
  }
  const lever = (label, value) => [label, { t: value, r: 1 }];
  return repSection(n, 'Scenario',
    `<p class="rep-lead">A projection of the next ${r.horizonMonths} months under the changes below, against the same period with no change. Demand and promotion budget both move revenue, so both feed one projection.</p>` +
    repBlock('Levers applied', repTable(['Lever', { t: 'Setting', r: 1 }], [
      lever('Patron demand', r.params.demandShiftPct ? pct(r.params.demandShiftPct, 0) : 'no change'),
      lever('Promotion budget', r.params.promoBudgetChangePct ? pct(r.params.promoBudgetChangePct, 0) : 'no change'),
      lever('Gross margin rate', r.params.marginRateDeltaPts ? `${r.params.marginRateDeltaPts > 0 ? '+' : ''}${r.params.marginRateDeltaPts} points` : 'no change'),
      lever('Reallocate losing spend', r.params.reallocateLosingSpend ? 'yes' : 'no')
    ])) +
    repBlock('Result', repTable(
      ['Measure', { t: 'No change', r: 1 }, { t: 'Scenario', r: 1 }, { t: 'Difference', r: 1 }], [
      ['Revenue', { t: money(r.baseline.revenue), r: 1 }, { t: money(r.projected.revenue), r: 1 },
        { t: money(r.delta.revenue), r: 1, cls: r.delta.revenue >= 0 ? 'pos' : 'neg' }],
      ['Margin', { t: money(r.baseline.margin), r: 1 }, { t: money(r.projected.margin), r: 1 },
        { t: money(r.delta.margin), r: 1, cls: r.delta.margin >= 0 ? 'pos' : 'neg' }],
      ['Margin rate', { t: r.baseline.marginRatePct + '%', r: 1 }, { t: r.projected.marginRatePct + '%', r: 1 }, { t: '', r: 1 }]
    ])) +
    (r.steps.length ? repBlock('Where the change comes from', repTable(
      ['Effect', { t: 'Margin', r: 1 }, 'Basis'],
      r.steps.map((st) => [st.label,
        { t: money(st.margin), r: 1, cls: st.margin >= 0 ? 'pos' : 'neg' }, st.basis])),
      'The effects sum to the total difference above.') : '') +
    repBlock('Assumptions', `<div class="rep-note" style="margin-top:0">${esc(r.assumptions.join(' '))}</div>`));
}

const SECTION_FN = { sales: secSales, promo: secPromo, lob: secLob, scenario: secScenario };

function secMethod(n) {
  const d = S.analytics.digest;
  return repSection(n, 'Method',
    repBlock('Forecast',
      `<div class="rep-note" style="margin-top:0">A seasonal index is estimated from the monthly history and applied to a linear trend fitted to the deseasonalised series. The interval covers 80% and comes from the spread of in-sample residuals. Reported error is mean absolute percentage error measured in sample, currently ${d.forecast.mapePct}%, which will understate error on months the model has not seen.</div>`) +
    repBlock('Promotion return',
      '<div class="rep-note" style="margin-top:0">Incremental revenue is promotional period sales less the baseline period. Incremental margin applies the margin rate recorded against that campaign. Return is incremental margin less spend, over spend, so zero is break-even rather than a target.</div>') +
    repBlock('Unusual movements',
      '<div class="rep-note" style="margin-top:0">Each installation and line of business series is divided by the enterprise seasonal index before month on month changes are scored, so a routine post-holiday fall is not reported as an exception. Movements beyond two standard deviations of that series own history are listed.</div>') +
    repBlock('Figures',
      '<div class="rep-note" style="margin-top:0">Gross margin is always revenue less cost of goods and is never stored independently. Stock cover and stock turns apply only to lines carrying physical stock. All narrative in this document is written from the computed figures; nothing in it is generated independently of the data.</div>'));
}

/** One installation's part within a pack. */
function partInstallation(part, c) {
  CTX = c;
  const d = c.digest;
  const h = d.headline;
  const worst = [...c.campaigns].sort((a, b) => a.roiPct - b.roiPct);
  const losing = worst.filter((x) => !x.profitable);

  const figs = [
    ['Revenue, ' + mlabel(d.coverage.latestPeriod), money(h.latestRevenue), pct(h.momPct) + ' on the month'],
    ['Year on year', pct(h.yoyPct), 'against the same month last year'],
    ['Gross margin rate', `${h.latestMarginRatePct}%`, money(h.totalMargin) + ' of margin to date'],
    ['Average transaction', `$${h.avgTransactionValue}`, num(h.latestTransactions) + ' transactions'],
    ['Next three months', money(d.forecast.total), `${d.forecast.mapePct}% in-sample error`],
    ['Campaigns earning', `${d.campaigns.profitable} of ${d.campaigns.total}`,
      money(d.campaigns.spendInNegativeRoi) + ' not returning cost']
  ];

  return `
    <div class="rep-part">
      <div class="eyebrow">Part ${part}</div>
      <h2>${esc(c.label)}</h2>
      <p class="sub">${money(d.headline.totalRevenue)} of revenue over ${d.coverage.months} months across ${d.coverage.businessLines} lines of business.</p>
    </div>
    <div class="rep-figs">${figs.map(([l, v, sfx]) => `
      <div class="rep-fig"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(sfx)}</div></div>`).join('')}</div>
    ${repBlock('Monthly performance', repChart('chartMain', `Revenue at ${c.label}`),
      `Actuals with a three month projection totalling ${money(d.forecast.total)}.`)}
    ${repBlock('Lines of business', repTable(
      ['Line of business', { t: 'Revenue', r: 1 }, { t: 'Margin rate', r: 1 }, { t: 'Trend', r: 1 },
       { t: 'Avg transaction', r: 1 }, 'Recommendation'],
      d.linesOfBusiness.map((x) => [
        x.businessLine, { t: money(x.revenue), r: 1 }, { t: x.marginRatePct + '%', r: 1 },
        { t: pct(x.trendPct), r: 1, cls: x.trendPct >= 0 ? 'pos' : 'neg' },
        { t: '$' + x.avgTransactionValue, r: 1 }, x.recommendation])))}
    ${repBlock('Revenue by line of business', repChart('chartLob', `Revenue by line of business at ${c.label}`))}
    ${c.campaigns.length ? repBlock('Campaigns', repTable(
      ['Campaign', 'Channel', { t: 'Spend', r: 1 }, { t: 'Lift', r: 1 }, { t: 'ROI', r: 1 }],
      worst.map((x) => [x.name, x.channel, { t: money(x.spend), r: 1 },
        { t: pct(x.liftPct), r: 1 },
        { t: pct(x.roiPct), r: 1, cls: x.profitable ? 'pos' : 'neg' }])),
      losing.length
        ? `${losing.length} of ${c.campaigns.length} campaigns did not return their cost, carrying ${money(losing.reduce((a, x) => a + x.spend, 0))} of spend.`
        : 'Every campaign in scope returned its cost.') : ''}
    ${repBlock('Where the money is', d.opportunities.items.map((o) => `
      <div class="rep-find">
        <div class="v">${money(o.value)}</div>
        <div class="l">${esc(o.label)}</div>
        <div class="b">${esc(o.basis)}</div>
      </div>`).join(''))}`;
}

function repPackCover(opts, names) {
  const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `
    <div class="rep-cover">
      <img src="/logo-dark.png" alt="Dexian Government Solutions">
      <hr class="rule">
      <div class="rep-kicker">Revenue Intelligence &middot; Installation pack</div>
      <h1>${esc(opts.title)}</h1>
      <p class="rep-sub">One part per installation. Each part covers only that installation's own performance, so it can be read or distributed on its own.</p>
      <table class="rep-meta">
        <tr><th>Prepared for</th><td>${esc(opts.preparedFor)}</td></tr>
        <tr><th>Prepared by</th><td>${esc(S.user.name)}, Dexian Government Solutions</td></tr>
        <tr><th>Date</th><td>${esc(stamp)}</td></tr>
        <tr><th>Installations</th><td>${esc(names.join(', '))}</td></tr>
        <tr><th>Period</th><td>${esc(filterScope().split(', ').pop())}</td></tr>
      </table>
      <div class="rep-notice">
        <b>Prototype on synthetic data.</b> Figures are computed from a representative dataset, not from MCCS systems of record.
      </div>
    </div>`;
}

function repCover(opts, titles) {
  const d = S.analytics.digest;
  const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `
    <div class="rep-cover">
      <img src="/logo-dark.png" alt="Dexian Government Solutions">
      <hr class="rule">
      <div class="rep-kicker">Revenue Intelligence</div>
      <h1>${esc(opts.title)}</h1>
      <p class="rep-sub">${esc(titles.join('. '))}.</p>
      <table class="rep-meta">
        <tr><th>Prepared for</th><td>${esc(opts.preparedFor)}</td></tr>
        <tr><th>Prepared by</th><td>${esc(S.user.name)}, Dexian Government Solutions</td></tr>
        <tr><th>Date</th><td>${esc(stamp)}</td></tr>
        <tr><th>Scope</th><td>${esc(filterScope())}</td></tr>
        <tr><th>Basis</th><td>${num(d.coverage.salesRows)} monthly sales records across ${d.coverage.installations} installations and ${d.coverage.businessLines} lines of business, with ${d.coverage.campaigns} campaigns</td></tr>
      </table>
      <div class="rep-notice">
        <b>Prototype on synthetic data.</b> Figures are computed from a representative dataset, not from MCCS systems of record. Structures and relationships mirror the real environment so the methods can be assessed, but no value here should be treated as an operational fact.
      </div>
    </div>`;
}

const repContents = (entries) => `
  <div class="rep-toc">
    <h2>Contents</h2>
    <ol>${entries.map((e) => `<li>${esc(e.title)}<span>${esc(e.note)}</span></li>`).join('')}</ol>
  </div>`;

async function buildReport(opts) {
  CTX = null;  // the enterprise report always reads live state
  const chosen = opts.pages.filter((v) => SECTION_FN[v]);
  if (!chosen.length) chosen.push('sales');

  // Charts only exist as canvases once their page has rendered, so visit each.
  const current = activeView();
  for (const v of chosen) {
    if (v === current) continue;
    const btn = $('tabs').querySelector(`button[data-v="${v}"]`);
    if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 280)); }
  }
  const back = $('tabs').querySelector(`button[data-v="${current}"]`);
  if (back) { back.click(); await new Promise((r) => setTimeout(r, 220)); }

  let summaryText = '';
  if (opts.brief) {
    try {
      const r = await api('/api/ai/brief', { method: 'POST', body: JSON.stringify({ filters: filters() }) });
      summaryText = r.text;
    } catch { summaryText = ''; }
  }

  const titles = chosen.map((v) => REPORT_PAGES[v]);
  const entries = [{ title: 'Summary', note: 'Headline figures and findings' }]
    .concat(chosen.map((v) => ({ title: REPORT_PAGES[v], note: '' })))
    .concat([{ title: 'Method', note: 'How each figure is calculated' }]);

  let n = 0;
  const body = [
    secSummary(++n, summaryText),
    ...chosen.map((v) => SECTION_FN[v](++n)),
    secMethod(++n)
  ].join('');

  const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  $('report').innerHTML =
    repCover(opts, titles) +
    repContents(entries) +
    body +
    `<div class="rep-end">
       <span>${esc(opts.title)} &middot; prepared for ${esc(opts.preparedFor)}</span>
       <span>Prototype on synthetic data &middot; ${esc(stamp)}</span>
     </div>`;
}

function openReportDialog() {
  if (!S.analytics) { alert('Load data before exporting a report.'); return; }

  const v = activeView();
  $('repPages').querySelectorAll('input').forEach((i) => { i.checked = (i.value === v); });
  if (!$('repPages').querySelector('input:checked')) {
    $('repPages').querySelector('input[value="sales"]').checked = true;
  }

  // Installation list comes from the data, so it tracks whatever is loaded.
  const box = $('repInstalls');
  if (!box.dataset.filled) {
    box.innerHTML = (S.meta?.installations || [])
      .map((n) => `<label class="opt"><input type="checkbox" value="${esc(n)}" checked>
        <span class="tick"></span><span>${esc(n)}</span></label>`).join('');
    box.dataset.filled = '1';
  }

  updateRepCounts();
  $('reportVeil').hidden = false;
  $('repTitleIn').focus();
}

function updateRepCounts() {
  const pages = $('repPages').querySelectorAll('input:checked').length;
  $('repPagesCount').textContent = pages ? `${pages} selected` : 'none selected';
  const box = $('repInstalls');
  const total = box.querySelectorAll('input').length;
  const on = box.querySelectorAll('input:checked').length;
  const head = box.closest('.fieldset').querySelector('.fl');
  if (head) head.textContent = total ? `Installations (${on} of ${total})` : 'Installations';
}

function setReportMode(mode) {
  $('repMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  const pack = mode === 'pack';
  $('repPackOpts').hidden = !pack;
  $('repPagesField').hidden = pack;
  updateRepCounts();
  $('repTitleIn').value = pack
    ? ($('repTitleIn').value.includes('Pack') ? $('repTitleIn').value : 'Installation Performance Pack')
    : ($('repTitleIn').value === 'Installation Performance Pack' ? 'Revenue Intelligence Review' : $('repTitleIn').value);
}

const reportMode = () => ($('repMode').querySelector('button.on') || {}).dataset?.mode || 'single';

/** Wait for the print dialog to close before touching the document again. */
function printAndWait() {
  return new Promise((resolve) => {
    const done = () => { window.removeEventListener('afterprint', done); setTimeout(resolve, 220); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 120);
  });
}

function repProgress(msg) {
  const go = $('repGo');
  go.textContent = msg;
}

async function runReportExport() {
  const go = $('repGo');
  const opts = {
    title: $('repTitleIn').value.trim() || 'Revenue Intelligence Review',
    preparedFor: $('repFor').value.trim() || 'MCCS Headquarters',
    brief: $('repBrief').checked
  };

  go.disabled = true;
  try {
    if (reportMode() === 'pack') {
      const names = [...$('repInstalls').querySelectorAll('input:checked')].map((i) => i.value);
      if (!names.length) { alert('Choose at least one installation.'); go.disabled = false; return; }

      repProgress(`Building 0 of ${names.length}`);
      const built = [];
      let i = 0;
      for (const name of names) {
        repProgress(`Building ${++i} of ${names.length}`);
        const c = await installationContext(name);
        if (c) built.push({ name, c });
      }
      if (!built.length) throw new Error('No data for the installations selected');

      const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      const endNote = (t) => `<div class="rep-end">
          <span>${esc(t)} &middot; prepared for ${esc(opts.preparedFor)}</span>
          <span>Prototype on synthetic data &middot; ${esc(stamp)}</span>
        </div>`;

      if ($('repDelivery').value === 'separate') {
        // One document, one print dialog, one saved file per installation.
        $('reportVeil').hidden = true;
        for (let k = 0; k < built.length; k++) {
          const { name, c } = built[k];
          document.title = `${opts.title} - ${name}`;
          $('report').innerHTML =
            repPackCover({ ...opts, title: `${opts.title}: ${name}` }, [name]) +
            partInstallation(1, c) +
            endNote(`${opts.title}: ${name}`);
          await printAndWait();
        }
        document.title = 'MCCS Revenue Intelligence';
      } else {
        $('report').innerHTML =
          repPackCover(opts, built.map((b) => b.name)) +
          repContents(built.map((b, k) => ({ title: b.name, note: `Part ${k + 1}` }))) +
          built.map((b, k) => partInstallation(k + 1, b.c)).join('') +
          endNote(opts.title);
        $('reportVeil').hidden = true;
        await printAndWait();
      }
      $('report').innerHTML = '';
      CTX = null;
    } else {
      const pages = [...$('repPages').querySelectorAll('input:checked')].map((i) => i.value);
      if (!pages.length) { alert('Choose at least one page to include.'); go.disabled = false; return; }
      repProgress('Building');
      await buildReport({ ...opts, pages });
      $('reportVeil').hidden = true;
      await printAndWait();
      $('report').innerHTML = '';
    }
  } catch (e) {
    alert(`Could not build the report: ${e.message}`);
  }
  go.disabled = false;
  repProgress('Build report');
}

window.addEventListener('afterprint', () => { $('report').innerHTML = ''; });


/* ---------------- Charts ---------------- */

const PALETTE = {
  scarlet: '#A3182B',
  scarletFill: 'rgba(163, 24, 43, .07)',
  green: '#2F6A4C',
  greenFill: 'rgba(47, 106, 76, .45)',
  brass: '#96772C',
  slate: '#3A5A73',
  slateFill: 'rgba(58, 90, 115, .11)',
  grid: '#EFF0ED',
  axis: '#757D82'
};

function drawChart(id, config) {
  const canvas = $(id);
  if (!canvas) return;
  if (S.charts[id]) S.charts[id].destroy();

  Chart.defaults.font.family = "'Source Sans 3', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = PALETTE.axis;

  // Tooltips are set in the interface's own voice rather than Chart.js defaults.
  const tip = {
    backgroundColor: '#14181B',
    titleFont: { family: "'Source Sans 3', sans-serif", size: 11, weight: '600' },
    titleColor: '#8A9299',
    bodyFont: { family: "'Source Sans 3', sans-serif", size: 12.5 },
    bodyColor: '#fff',
    padding: 10,
    cornerRadius: 3,
    displayColors: false,
    borderColor: '#2A3034',
    borderWidth: 1
  };
  config.options = config.options || {};
  config.options.plugins = config.options.plugins || {};
  config.options.plugins.tooltip = { ...tip, ...(config.options.plugins.tooltip || {}) };

  S.charts[id] = new Chart(canvas.getContext('2d'), config);
}

/* ---------------- Wiring ---------------- */

function wire() {
  // Tabs
  const TITLES = {
    sales: 'Sales & forecast',
    promo: 'Promotion ROI',
    lob: 'Lines of business',
    scenario: 'Scenario',
    ai: 'AI analyst',
    admin: 'Admin'
  };

  $('tabs').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `v-${b.dataset.v}`));
      $('pageTitle').textContent = TITLES[b.dataset.v] || '';
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
    S.promoFilter = { channel: 'all', bl: 'all', inst: 'all', result: 'all' };
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
    S.promoFilter = { channel: 'all', bl: 'all', inst: 'all', result: 'all' };
    S.selectedCampaign = null;
    fillPromoFilters();
    renderPromo();
  };

  $('btnLoadData').onclick = () => doLoadData(false);
  $('btnReloadData').onclick = () => {
    if (confirm('Replace all sales, campaign, installation and category data?\n\nAny edits made in the app will be discarded. User accounts are not affected.')) {
      doLoadData(true);
    }
  };
  $('btnRefreshStatus').onclick = loadDataStatus;

  $('btnExportReport').onclick = openReportDialog;
  $('repCancel').onclick = () => { $('reportVeil').hidden = true; };
  $('repMode').querySelectorAll('button').forEach((b) => {
    b.onclick = () => setReportMode(b.dataset.mode);
  });
  $('repAllInst').onclick = () => {
    $('repInstalls').querySelectorAll('input').forEach((i) => { i.checked = true; });
    updateRepCounts();
  };
  $('repNoInst').onclick = () => {
    $('repInstalls').querySelectorAll('input').forEach((i) => { i.checked = false; });
    updateRepCounts();
  };
  $('repPages').onchange = updateRepCounts;
  $('repInstalls').onchange = updateRepCounts;
  $('repClose').onclick = () => { $('reportVeil').hidden = true; };
  $('repGo').onclick = runReportExport;
  $('reportVeil').onclick = (e) => { if (e.target === $('reportVeil')) $('reportVeil').hidden = true; };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('reportVeil').hidden) $('reportVeil').hidden = true;
  });

  $('btnLogout').onclick = async () => {
    await fetch('/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  };

}

boot().catch((e) => console.error('Boot failed:', e));
