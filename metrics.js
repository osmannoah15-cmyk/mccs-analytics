'use strict';
/**
 * All analytics run here, server-side, against rows loaded from Postgres.
 * The AI layer never computes numbers. It only narrates what this file produces,
 * which is what makes "grounded in computed metrics" a true statement.
 */

const round = (n, d = 2) => {
  const f = Math.pow(10, d);
  return Math.round((Number(n) || 0) * f) / f;
};
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

/** ---------- Shaping ---------- */

/**
 * @param {Array} rows  [{period:'2026-06-01', installation, business_line, category,
 *                        transactions, units_sold, revenue, cogs, gross_margin, inventory_units}]
 */
function monthsOf(rows) {
  return [...new Set(rows.map((r) => r.period))].sort();
}

function seriesFor(rows, months, metric = 'revenue') {
  const idx = new Map(months.map((m, i) => [m, i]));
  const out = new Array(months.length).fill(0);
  for (const r of rows) {
    const i = idx.get(r.period);
    if (i == null) continue;
    out[i] += Number(r[metric]) || 0;
  }
  return out.map((v) => round(v, 2));
}

/** ---------- Forecasting ---------- */

/**
 * Seasonal index times linear trend, with an 80% interval from residual spread.
 * Same method as the original prototype, moved server-side and exposed with
 * the diagnostics an analyst would actually want to see.
 */
function forecast(y, ahead = 3) {
  const n = y.length;
  if (n < 4) return { points: [], slope: 0, seasonalIndex: [], mape: null };
  const monthOf = (i) => i % 12;

  const buckets = Array.from({ length: 12 }, () => []);
  y.forEach((v, i) => buckets[monthOf(i)].push(v));
  const overall = sum(y) / n;
  const sIdx = buckets.map((a) => (a.length && overall ? sum(a) / a.length / overall : 1));

  const deseason = y.map((v, i) => (sIdx[monthOf(i)] ? v / sIdx[monthOf(i)] : v));
  const idx = [...Array(n).keys()];
  const mx = sum(idx) / n;
  const my = sum(deseason) / n;
  let num = 0, den = 0;
  idx.forEach((x, i) => { num += (x - mx) * (deseason[i] - my); den += (x - mx) ** 2; });
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;

  const fitted = idx.map((i) => (intercept + slope * i) * sIdx[monthOf(i)]);
  const resid = deseason.map((v, i) => v - (intercept + slope * i));
  const sd = Math.sqrt(sum(resid.map((r) => r * r)) / n);

  // In-sample MAPE gives the room a defensible accuracy statement.
  const ape = y.map((v, i) => (v ? Math.abs(v - fitted[i]) / v : 0));
  const mape = round((sum(ape) / n) * 100, 1);

  const points = [];
  for (let k = 0; k < ahead; k++) {
    const i = n + k;
    const s = sIdx[monthOf(i)];
    const base = intercept + slope * i;
    points.push({
      step: k + 1,
      value: round(base * s, 2),
      low: round((base - 1.28 * sd) * s, 2),
      high: round((base + 1.28 * sd) * s, 2)
    });
  }
  return { points, slope: round(slope, 2), seasonalIndex: sIdx.map((v) => round(v, 3)), mape, fitted };
}

/** Add N months to a 'YYYY-MM-DD' string. */
function addMonths(period, n) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** ---------- Campaign economics ---------- */

function campaignMetrics(c) {
  const spend = Number(c.spend) || 0;
  const baseline = Number(c.baseline_revenue) || 0;
  const promo = Number(c.promo_revenue) || 0;
  const incrRevenue = promo - baseline;
  const incrMargin = Number(c.incremental_margin) || 0;
  const lift = baseline ? (incrRevenue / baseline) * 100 : 0;
  const roi = spend ? ((incrMargin - spend) / spend) * 100 : 0;
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    channel: c.channel,
    installation: c.installation,
    businessLine: c.business_line,
    startDate: c.start_date,
    endDate: c.end_date,
    status: c.status,
    marginRatePct: round(Number(c.margin_rate_pct) || 0, 1),
    spend: round(spend),
    markdownPct: round(Number(c.markdown_pct) || 0, 1),
    baselineRevenue: round(baseline),
    promoRevenue: round(promo),
    incrementalRevenue: round(incrRevenue),
    incrementalMargin: round(incrMargin),
    liftPct: round(lift, 1),
    roiPct: round(roi, 1),
    netMargin: round(incrMargin - spend),
    profitable: incrMargin - spend > 0
  };
}

function channelRollup(campaigns) {
  const byCh = new Map();
  for (const c of campaigns) {
    if (!byCh.has(c.channel)) byCh.set(c.channel, { channel: c.channel, spend: 0, incrementalMargin: 0, count: 0 });
    const b = byCh.get(c.channel);
    b.spend += c.spend;
    b.incrementalMargin += c.incrementalMargin;
    b.count += 1;
  }
  return [...byCh.values()]
    .map((b) => ({
      ...b,
      spend: round(b.spend),
      incrementalMargin: round(b.incrementalMargin),
      netMargin: round(b.incrementalMargin - b.spend),
      roiPct: b.spend ? round(((b.incrementalMargin - b.spend) / b.spend) * 100, 1) : 0
    }))
    .sort((a, b) => a.roiPct - b.roiPct);
}

/** ---------- Lines of business (the LOE 1 view) ---------- */

/**
 * Cost-to-serve proxy: for each business line we hold revenue, margin, margin rate,
 * trend, and promo efficiency together so leadership can make a
 * sustain / scale / sunset call per program.
 */
function linesOfBusiness(rows, campaigns, months) {
  const lines = [...new Set(rows.map((r) => r.business_line))];
  const half = Math.max(1, Math.floor(months.length / 2));
  const recentMonths = new Set(months.slice(-half));
  const priorMonths = new Set(months.slice(0, half));

  return lines.map((bl) => {
    const lineRows = rows.filter((r) => r.business_line === bl);
    const revenue = sum(lineRows.map((r) => r.revenue));
    const margin = sum(lineRows.map((r) => r.gross_margin));
    const unitsSold = sum(lineRows.map((r) => r.units_sold));
    const transactions = sum(lineRows.map((r) => r.transactions));
    const cogs = sum(lineRows.map((r) => r.cogs));
    // Inventory is only carried by lines that hold physical stock.
    // Average the TOTAL stock held in each period, not the average of
    // individual rows, or the scale will not match period COGS.
    const invByPeriod = new Map();
    for (const r of lineRows) {
      if (r.inventory_units == null) continue;
      invByPeriod.set(r.period, (invByPeriod.get(r.period) || 0) + r.inventory_units);
    }
    const avgInventory = invByPeriod.size
      ? sum([...invByPeriod.values()]) / invByPeriod.size : null;
    const recent = sum(lineRows.filter((r) => recentMonths.has(r.period)).map((r) => r.revenue));
    const prior = sum(lineRows.filter((r) => priorMonths.has(r.period)).map((r) => r.revenue));
    const trendPct = prior ? ((recent - prior) / prior) * 100 : 0;

    const lineCamps = campaigns.filter((c) => c.businessLine === bl);
    const promoSpend = sum(lineCamps.map((c) => c.spend));
    const promoMargin = sum(lineCamps.map((c) => c.incrementalMargin));
    const promoRoi = promoSpend ? ((promoMargin - promoSpend) / promoSpend) * 100 : null;
    const marginRate = revenue ? (margin / revenue) * 100 : 0;

    // Simple, explainable decision rule. Every input is visible in the row.
    let recommendation = 'Sustain';
    if (trendPct > 6 && marginRate > 25) recommendation = 'Scale';
    else if (trendPct < -3 || marginRate < 15) recommendation = 'Review';
    if (trendPct < -8 && marginRate < 15) recommendation = 'Sunset candidate';

    return {
      businessLine: bl,
      revenue: round(revenue),
      margin: round(margin),
      marginRatePct: round(marginRate, 1),
      unitsSold,
      transactions,
      cogs: round(cogs),
      avgTransactionValue: transactions ? round(revenue / transactions, 2) : 0,
      revenuePerUnit: unitsSold ? round(revenue / unitsSold, 2) : 0,
      unitsPerTransaction: transactions ? round(unitsSold / transactions, 2) : 0,
      avgInventoryUnits: avgInventory == null ? null : round(avgInventory, 0),
      // Annualized turns: COGS over the period against average stock value,
      // approximated with the line's own cost per unit.
      inventoryTurns: (() => {
        if (avgInventory == null || !unitsSold || !cogs) return null;
        const monthsCovered = months.length || 1;
        const costPerUnit = cogs / unitsSold;
        const avgStockValue = avgInventory * costPerUnit;   // dollars held, on average
        if (!avgStockValue) return null;
        const annualCogs = cogs * (12 / monthsCovered);
        return round(annualCogs / avgStockValue, 2);
      })(),
      daysOfSupply: (() => {
        if (avgInventory == null || !unitsSold) return null;
        const monthsCovered = months.length || 1;
        const unitsPerDay = unitsSold / (monthsCovered * 30.44);
        return unitsPerDay ? round(avgInventory / unitsPerDay, 1) : null;
      })(),
      trendPct: round(trendPct, 1),
      promoSpend: round(promoSpend),
      promoRoiPct: promoRoi == null ? null : round(promoRoi, 1),
      campaignCount: lineCamps.length,
      recommendation
    };
  }).sort((a, b) => b.revenue - a.revenue);
}

/** ---------- Installation performance ---------- */

function installationRollup(rows, months) {
  const half = Math.max(1, Math.floor(months.length / 2));
  const recent = new Set(months.slice(-half));
  const prior = new Set(months.slice(0, half));
  const names = [...new Set(rows.map((r) => r.installation))];

  return names.map((inst) => {
    const iRows = rows.filter((r) => r.installation === inst);
    const revenue = sum(iRows.map((r) => r.revenue));
    const margin = sum(iRows.map((r) => r.gross_margin));
    const rNow = sum(iRows.filter((r) => recent.has(r.period)).map((r) => r.revenue));
    const rPrev = sum(iRows.filter((r) => prior.has(r.period)).map((r) => r.revenue));
    return {
      installation: inst,
      revenue: round(revenue),
      margin: round(margin),
      marginRatePct: revenue ? round((margin / revenue) * 100, 1) : 0,
      growthPct: rPrev ? round(((rNow - rPrev) / rPrev) * 100, 1) : 0
    };
  }).sort((a, b) => b.growthPct - a.growthPct);
}

/** ---------- Anomaly detection ---------- */

/**
 * Flags movements that are unusual AFTER seasonality is removed.
 *
 * Without deseasonalizing, every installation trips the detector each January
 * simply because the holiday peak ended. That is a known pattern, not an
 * anomaly, and flagging it would discredit the whole panel. So each group's
 * series is divided by its own seasonal index first, and outliers are scored
 * on the deseasonalized month-over-month change.
 */
function anomalies(rows, months, z = 2) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.installation}||${r.business_line}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const g = groups.get(key);
    g.set(r.period, (g.get(r.period) || 0) + (Number(r.revenue) || 0));
  }

  // Enterprise-wide seasonal index, used when a single group has too few
  // observations to estimate its own reliably.
  const totalByPeriod = months.map((m) =>
    sum(rows.filter((r) => r.period === m).map((r) => r.revenue)));
  const monthNum = (p) => Number(p.split('-')[1]) - 1;
  const globalBuckets = Array.from({ length: 12 }, () => []);
  months.forEach((m, i) => globalBuckets[monthNum(m)].push(totalByPeriod[i]));
  const globalMean = sum(totalByPeriod) / (totalByPeriod.length || 1);
  const globalIdx = globalBuckets.map((a) =>
    a.length && globalMean ? sum(a) / a.length / globalMean : 1);

  const found = [];
  for (const [key, byPeriod] of groups) {
    const [installation, businessLine] = key.split('||');
    const vals = months.map((m) => byPeriod.get(m) || 0);
    if (vals.filter(Boolean).length < 6) continue;

    // Remove the seasonal shape before looking for surprises.
    const adj = vals.map((v, i) => {
      const s = globalIdx[monthNum(months[i])] || 1;
      return s ? v / s : v;
    });

    const deltas = [];
    for (let i = 1; i < adj.length; i++) {
      deltas.push(adj[i - 1] ? (adj[i] - adj[i - 1]) / adj[i - 1] : 0);
    }
    if (deltas.length < 5) continue;

    const mean = sum(deltas) / deltas.length;
    const sd = Math.sqrt(sum(deltas.map((d) => (d - mean) ** 2)) / deltas.length);
    if (!sd || sd < 0.005) continue;

    deltas.forEach((d, i) => {
      const score = (d - mean) / sd;
      if (Math.abs(score) < z) return;
      const rawChange = vals[i] ? (vals[i + 1] - vals[i]) / vals[i] : 0;
      found.push({
        period: months[i + 1],
        installation,
        businessLine,
        changePct: round(rawChange * 100, 1),
        adjustedChangePct: round(d * 100, 1),
        zScore: round(score, 2),
        direction: d > 0 ? 'spike' : 'drop',
        revenue: round(vals[i + 1]),
        priorRevenue: round(vals[i]),
        basis: 'seasonally adjusted'
      });
    });
  }
  return found.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore)).slice(0, 25);
}

/** ---------- Quantified opportunity (the ROI headline) ---------- */

/**
 * Turns the analysis into dollars. These are the numbers that justify the
 * engagement, so each one carries its own basis string.
 */
function opportunities(campaigns, channels, installs, lines, forecastTotal) {
  const losing = campaigns.filter((c) => !c.profitable);
  const wastedSpend = sum(losing.map((c) => c.spend - c.incrementalMargin));
  const bestChannel = channels[channels.length - 1];
  const worstChannel = channels[0];

  // Reallocation upside: move the losing spend to the best channel's ROI.
  const reallocSpend = sum(losing.map((c) => c.spend));
  const reallocUpside = bestChannel ? reallocSpend * (bestChannel.roiPct / 100) : 0;

  // Margin-rate convergence: bring bottom-quartile installations up to median.
  const rates = installs.map((i) => i.marginRatePct).sort((a, b) => a - b);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
  const laggards = installs.filter((i) => i.marginRatePct < median);
  const convergenceUpside = sum(
    laggards.map((i) => i.revenue * ((median - i.marginRatePct) / 100))
  );

  const items = [
    {
      key: 'wasted_promo_spend',
      label: 'Promotion spend not returning its cost',
      value: round(wastedSpend),
      basis: `${losing.length} of ${campaigns.length} campaigns have incremental margin below spend`,
      loe: 'LOE 1 - Innovate for Relevancy'
    },
    {
      key: 'channel_reallocation',
      label: 'Upside from reallocating losing spend to the best channel',
      value: round(reallocUpside),
      basis: bestChannel
        ? `${formatMoney(reallocSpend)} currently in negative-ROI campaigns, moved to ${bestChannel.channel} at ${bestChannel.roiPct}% ROI`
        : 'no channel data',
      loe: 'LOE 1 - Innovate for Relevancy'
    },
    {
      key: 'margin_convergence',
      label: 'Margin upside if lagging installations reach the median rate',
      value: round(convergenceUpside),
      basis: `${laggards.length} installations below the ${round(median, 1)}% median margin rate`,
      loe: 'LOE 3 - Collaborate Effectively'
    },
    {
      key: 'forecast_visibility',
      label: 'Revenue now under forward visibility',
      value: round(forecastTotal),
      basis: 'next three months projected with an 80% interval, previously unforecast',
      loe: 'LOE 4 - Measure What Matters'
    }
  ];

  const actionable = items
    .filter((i) => ['wasted_promo_spend', 'channel_reallocation', 'margin_convergence'].includes(i.key))
    .reduce((a, b) => a + b.value, 0);

  return { items, totalAddressable: round(actionable) };
}

function formatMoney(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/** ---------- Enterprise scorecard (the LOE 4 anchor) ---------- */

/**
 * Every measure here is compared against a baseline drawn from the data
 * itself: the same month a year ago, the trailing twelve month average, or
 * break-even. No target is invented, because an invented target is the first
 * thing a room full of analysts will challenge and the hardest to defend.
 *
 * Objective 1 is deliberately left uninstrumented. Leadership endorsement
 * cannot be measured from sales data, and showing it as a gap is more honest,
 * and a stronger argument for the engagement, than inventing a proxy.
 */
function scorecard(rows, months, campaigns, installs, lines) {
  const latest = months[months.length - 1];
  const prior = months[months.length - 2] || null;
  const yearAgo = months.length >= 13 ? months[months.length - 13] : null;

  const inMonth = (m) => rows.filter((r) => r.period === m);
  const agg = (m, field) => round(sum(inMonth(m).map((r) => r[field])));

  // Trailing twelve months, excluding the latest, so a month is never
  // compared against a window that already contains it.
  const trailing = months.slice(Math.max(0, months.length - 13), months.length - 1);
  const trailingAvg = (field) => {
    if (!trailing.length) return null;
    return round(sum(trailing.map((m) => agg(m, field))) / trailing.length);
  };

  const revLatest = agg(latest, 'revenue');
  const marLatest = agg(latest, 'gross_margin');
  const txnLatest = agg(latest, 'transactions');
  const unitsLatest = agg(latest, 'units_sold');

  const kpi = ({ label, value, unit, baseline, baselineLabel, higherIsBetter = true, note = null }) => {
    const hasBaseline = baseline != null && !Number.isNaN(baseline);
    const deltaPct = hasBaseline && baseline !== 0
      ? round(((value - baseline) / Math.abs(baseline)) * 100, 1) : null;
    return {
      label,
      value: round(value, 2),
      unit,
      baseline: hasBaseline ? round(baseline, 2) : null,
      baselineLabel,
      deltaPct,
      higherIsBetter,
      note,
      onTrack: hasBaseline ? (higherIsBetter ? value >= baseline : value <= baseline) : null
    };
  };

  const objectives = [];

  // ---- Objective 1: not measurable from this data ----
  objectives.push({
    id: 'obj1',
    title: 'Leadership will embrace MCCS',
    instrumented: false,
    gap: 'No data source in this system measures leadership attitudes or endorsement.',
    needed: [
      'A recurring command survey of leadership perception',
      'Endorsement or referral tracking through command channels',
      'Programs briefed to leadership, with outcomes recorded'
    ],
    kpis: []
  });

  // ---- Objective 2: patron relevancy ----
  const atvLatest = txnLatest ? revLatest / txnLatest : 0;
  const trailingRev = trailingAvg('revenue');
  const trailingTxn = trailingAvg('transactions');
  const avgAtv = (() => {
    if (!trailing.length) return null;
    const r = sum(trailing.map((m) => agg(m, 'revenue')));
    const t = sum(trailing.map((m) => agg(m, 'transactions')));
    return t ? r / t : null;
  })();

  objectives.push({
    id: 'obj2',
    title: 'MCCS will be relevant to Marines and families',
    instrumented: true,
    basis: 'Patron demand as revealed by revenue, visit volume, and basket size',
    kpis: [
      kpi({
        label: 'Revenue',
        value: revLatest,
        unit: 'usd',
        baseline: yearAgo ? agg(yearAgo, 'revenue') : trailingRev,
        baselineLabel: yearAgo ? `same month last year (${yearAgo.slice(0, 7)})` : 'trailing 12 month average'
      }),
      kpi({
        label: 'Transactions',
        value: txnLatest,
        unit: 'count',
        baseline: trailingTxn,
        baselineLabel: 'trailing 12 month average',
        note: 'Visit volume, independent of price'
      }),
      kpi({
        label: 'Average transaction value',
        value: atvLatest,
        unit: 'usd2',
        baseline: avgAtv,
        baselineLabel: 'trailing 12 month average',
        note: 'What a patron spends per visit'
      })
    ]
  });

  // ---- Objective 3: resource efficiency ----
  const marginRate = revLatest ? (marLatest / revLatest) * 100 : 0;
  const trailingMarginRate = (() => {
    if (!trailing.length) return null;
    const r = sum(trailing.map((m) => agg(m, 'revenue')));
    const g = sum(trailing.map((m) => agg(m, 'gross_margin')));
    return r ? (g / r) * 100 : null;
  })();

  const promoSpend = sum(campaigns.map((c) => c.spend));
  const promoMargin = sum(campaigns.map((c) => c.incrementalMargin));
  const blendedRoi = promoSpend ? ((promoMargin - promoSpend) / promoSpend) * 100 : 0;
  const earningSpend = sum(campaigns.filter((c) => c.profitable).map((c) => c.spend));
  const earningShare = promoSpend ? (earningSpend / promoSpend) * 100 : 0;

  objectives.push({
    id: 'obj3',
    title: 'Resources aligned for efficient, sustainable service',
    instrumented: true,
    basis: 'Margin performance and the return on promotional investment',
    kpis: [
      kpi({
        label: 'Gross margin rate',
        value: marginRate,
        unit: 'pct',
        baseline: trailingMarginRate,
        baselineLabel: 'trailing 12 month average'
      }),
      kpi({
        label: 'Blended promotion ROI',
        value: blendedRoi,
        unit: 'pct',
        baseline: 0,
        baselineLabel: 'break-even, where margin equals spend',
        note: 'Below zero means promotions cost more than they returned'
      }),
      kpi({
        label: 'Promotion spend that returned its cost',
        value: earningShare,
        unit: 'pct',
        baseline: 100,
        baselineLabel: 'all spend earning its cost',
        note: `${formatMoney(promoSpend - earningSpend)} did not`
      })
    ]
  });

  const measured = objectives.flatMap((o) => o.kpis);
  const onTrack = measured.filter((k) => k.onTrack).length;
  const instrumented = objectives.filter((o) => o.instrumented).length;

  return {
    latestPeriod: latest,
    priorPeriod: prior,
    comparedWith: yearAgo ? `${yearAgo.slice(0, 7)} and the trailing 12 months` : 'the trailing 12 months',
    objectives,
    summary: {
      kpiCount: measured.length,
      onTrack,
      offTrack: measured.length - onTrack,
      healthPct: measured.length ? round((onTrack / measured.length) * 100, 0) : 0,
      objectivesInstrumented: instrumented,
      objectivesTotal: objectives.length,
      scaleReady: lines.filter((p) => p.recommendation === 'Scale').length,
      needsReview: lines.filter((p) => p.recommendation !== 'Sustain' && p.recommendation !== 'Scale').length
    }
  };
}

/** ---------- What-if scenario ---------- */

/**
 * One revenue line, built up from named contributions.
 *
 * Demand and promotion both move revenue, so they are added to the same
 * projection rather than reported in separate columns. The result is a
 * waterfall the reader can follow: baseline, then each lever's effect on
 * revenue and on margin, then the total.
 *
 * Promotion effect is derived from the campaigns' own revenue return per
 * dollar of spend, so it is grounded in observed performance rather than an
 * assumed multiplier.
 */
function scenario(rows, months, campaigns, params = {}) {
  const {
    demandShiftPct = 0,
    marginRateDeltaPts = 0,
    promoBudgetChangePct = 0,
    reallocateLosingSpend = false,
    horizonMonths = 3
  } = params;

  const revSeries = seriesFor(rows, months, 'revenue');
  const marSeries = seriesFor(rows, months, 'gross_margin');
  const f = forecast(revSeries, horizonMonths);

  const baseRevenue = sum(f.points.map((p) => p.value));
  const histRevenue = sum(revSeries);
  const histMargin = sum(marSeries);
  const baseMarginRate = histRevenue ? (histMargin / histRevenue) * 100 : 0;
  const baseMargin = baseRevenue * (baseMarginRate / 100);

  // Observed promotion economics, expressed per month so they can be scaled
  // to the forecast horizon.
  const monthsCovered = months.length || 1;
  const promoSpendTotal = sum(campaigns.map((c) => c.spend));
  const promoIncrRevenue = sum(campaigns.map((c) => c.incrementalRevenue));
  const promoIncrMargin = sum(campaigns.map((c) => c.incrementalMargin));
  const revenuePerPromoDollar = promoSpendTotal ? promoIncrRevenue / promoSpendTotal : 0;
  const marginPerPromoDollar = promoSpendTotal ? promoIncrMargin / promoSpendTotal : 0;

  const promoSpendHorizon = (promoSpendTotal / monthsCovered) * horizonMonths;

  const steps = [];

  // 1. Demand
  const demandRevenue = baseRevenue * (demandShiftPct / 100);
  const demandMargin = demandRevenue * (baseMarginRate / 100);
  if (demandShiftPct !== 0) {
    steps.push({
      key: 'demand',
      label: `Demand ${demandShiftPct > 0 ? 'up' : 'down'} ${Math.abs(demandShiftPct)}%`,
      revenue: round(demandRevenue),
      margin: round(demandMargin),
      basis: `applied to the ${formatMoney(baseRevenue)} baseline projection`
    });
  }

  // 2. Promotion budget. Extra spend buys extra revenue at the rate the
  //    existing campaigns actually achieved.
  const extraSpend = promoSpendHorizon * (promoBudgetChangePct / 100);
  const promoRevenue = extraSpend * revenuePerPromoDollar;
  const promoMarginGross = extraSpend * marginPerPromoDollar;
  const promoMarginNet = promoMarginGross - extraSpend;
  if (promoBudgetChangePct !== 0) {
    steps.push({
      key: 'promo',
      label: `Promotion budget ${promoBudgetChangePct > 0 ? 'up' : 'down'} ${Math.abs(promoBudgetChangePct)}%`,
      revenue: round(promoRevenue),
      margin: round(promoMarginNet),
      basis: `${formatMoney(Math.abs(extraSpend))} ${extraSpend >= 0 ? 'added to' : 'removed from'} promotion spend, at the ${revenuePerPromoDollar.toFixed(2)} revenue per dollar these campaigns returned`
    });
  }

  // 3. Reallocation. Spend does not change, only where it goes.
  const losing = campaigns.filter((c) => !c.profitable);
  const losingSpend = sum(losing.map((c) => c.spend));
  const losingMargin = sum(losing.map((c) => c.incrementalMargin));
  const channels = channelRollup(campaigns);
  const best = channels[channels.length - 1];
  let reallocRevenue = 0;
  let reallocMargin = 0;
  if (reallocateLosingSpend && best && losingSpend > 0) {
    const bestCamps = campaigns.filter((c) => c.channel === best.channel);
    const bestSpend = sum(bestCamps.map((c) => c.spend));
    const bestRevPerDollar = bestSpend ? sum(bestCamps.map((c) => c.incrementalRevenue)) / bestSpend : 0;
    const bestMarginPerDollar = bestSpend ? sum(bestCamps.map((c) => c.incrementalMargin)) / bestSpend : 0;

    const share = promoSpendTotal ? losingSpend / promoSpendTotal : 0;
    const losingSpendHorizon = promoSpendHorizon * share;
    const losingRevenueHorizon = (sum(losing.map((c) => c.incrementalRevenue)) / monthsCovered) * horizonMonths;
    const losingMarginHorizon = (losingMargin / monthsCovered) * horizonMonths;

    reallocRevenue = losingSpendHorizon * bestRevPerDollar - losingRevenueHorizon;
    reallocMargin = losingSpendHorizon * bestMarginPerDollar - losingMarginHorizon;

    steps.push({
      key: 'realloc',
      label: `Move losing spend into ${best.channel}`,
      revenue: round(reallocRevenue),
      margin: round(reallocMargin),
      basis: `${formatMoney(losingSpendHorizon)} currently in ${losing.length} campaigns that do not return their cost, redirected at ${best.channel}'s observed return`
    });
  }

  const projRevenue = baseRevenue + demandRevenue + promoRevenue + reallocRevenue;

  // 4. Margin rate change applies to the whole projected revenue line.
  const rateMargin = projRevenue * (marginRateDeltaPts / 100);
  if (marginRateDeltaPts !== 0) {
    steps.push({
      key: 'rate',
      label: `Margin rate ${marginRateDeltaPts > 0 ? 'up' : 'down'} ${Math.abs(marginRateDeltaPts)} points`,
      revenue: 0,
      margin: round(rateMargin),
      basis: `applied to ${formatMoney(projRevenue)} of projected revenue`
    });
  }

  const projMargin = baseMargin + demandMargin + promoMarginNet + reallocMargin + rateMargin;

  return {
    horizonMonths,
    params,
    baseline: {
      revenue: round(baseRevenue),
      margin: round(baseMargin),
      marginRatePct: round(baseMarginRate, 1),
      promoSpend: round(promoSpendHorizon),
      label: `Projected ${horizonMonths} months with no change`
    },
    steps,
    projected: {
      revenue: round(projRevenue),
      margin: round(projMargin),
      marginRatePct: projRevenue ? round((projMargin / projRevenue) * 100, 1) : 0,
      promoSpend: round(promoSpendHorizon + extraSpend)
    },
    delta: {
      revenue: round(projRevenue - baseRevenue),
      margin: round(projMargin - baseMargin),
      revenuePct: baseRevenue ? round(((projRevenue - baseRevenue) / baseRevenue) * 100, 1) : 0
    },
    assumptions: [
      'Promotion return per dollar is taken from the campaigns in this selection and held constant.',
      'Cost structure, staffing, and patron mix are unchanged.',
      'Directional planning figures, not a budget.'
    ]
  };
}

/** ---------- The digest handed to the AI ---------- */

/**
 * One compact, fully computed object. The AI receives only this, which is why
 * it cannot invent a number.
 */
function buildDigest(rows, campaignRows, filters = {}) {
  const months = monthsOf(rows);
  const campaigns = campaignRows.map(campaignMetrics);
  const revSeries = seriesFor(rows, months, 'revenue');
  const marSeries = seriesFor(rows, months, 'gross_margin');
  const f = forecast(revSeries, 3);
  const installs = installationRollup(rows, months);
  const lines = linesOfBusiness(rows, campaigns, months);
  const channels = channelRollup(campaigns);
  const anoms = anomalies(rows, months);
  const forecastTotal = sum(f.points.map((p) => p.value));
  const opps = opportunities(campaigns, channels, installs, lines, forecastTotal);
  const card = scorecard(rows, months, campaigns, installs, lines);

  const last = months[months.length - 1];
  const prev = months[months.length - 2];
  const yearAgo = months.length >= 13 ? months[months.length - 13] : null;
  const at = (m) => (m ? round(sum(rows.filter((r) => r.period === m).map((r) => r.revenue))) : 0);

  const revLast = at(last);
  const revPrev = at(prev);
  const revYear = at(yearAgo);

  const lastRows = rows.filter((r) => r.period === last);
  const txnLast = sum(lastRows.map((r) => r.transactions));
  const unitsLast = sum(lastRows.map((r) => r.units_sold));

  const sorted = [...campaigns].sort((a, b) => a.roiPct - b.roiPct);

  return {
    filters,
    coverage: {
      months: months.length,
      firstPeriod: months[0],
      latestPeriod: last,
      installations: [...new Set(rows.map((r) => r.installation))].length,
      businessLines: [...new Set(rows.map((r) => r.business_line))].length,
      salesRows: rows.length,
      campaigns: campaigns.length
    },
    headline: {
      latestRevenue: revLast,
      momPct: revPrev ? round(((revLast - revPrev) / revPrev) * 100, 1) : null,
      yoyPct: revYear ? round(((revLast - revYear) / revYear) * 100, 1) : null,
      latestMarginRatePct: revLast ? round((sum(lastRows.map((r) => r.gross_margin)) / revLast) * 100, 1) : null,
      latestTransactions: txnLast,
      latestUnitsSold: unitsLast,
      avgTransactionValue: txnLast ? round(revLast / txnLast, 2) : null,
      unitsPerTransaction: txnLast ? round(unitsLast / txnLast, 2) : null,
      totalRevenue: round(sum(revSeries)),
      totalMargin: round(sum(marSeries)),
      totalCogs: round(sum(rows.map((r) => r.cogs)))
    },
    forecast: {
      periods: f.points.map((p, i) => ({ period: addMonths(last, i + 1), ...p })),
      total: round(forecastTotal),
      mapePct: f.mape,
      monthlyTrend: f.slope
    },
    installations: installs,
    linesOfBusiness: lines,
    channels,
    campaigns: {
      total: campaigns.length,
      profitable: campaigns.filter((c) => c.profitable).length,
      totalSpend: round(sum(campaigns.map((c) => c.spend))),
      spendInNegativeRoi: round(sum(campaigns.filter((c) => !c.profitable).map((c) => c.spend))),
      worst: sorted.slice(0, 5),
      best: sorted.slice(-5).reverse()
    },
    anomalies: anoms.slice(0, 8),
    opportunities: opps,
    scorecard: card
  };
}

module.exports = {
  monthsOf, seriesFor, forecast, addMonths,
  campaignMetrics, channelRollup, linesOfBusiness, installationRollup,
  anomalies, opportunities, scorecard, scenario, buildDigest,
  formatMoney, round, sum
};
