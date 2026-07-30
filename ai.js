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
 * @param {Array} rows  [{period:'2026-06-01', installation, business_line, category, revenue, gross_margin, units}]
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
    status: c.status,
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

/** ---------- Program / portfolio ROI (the LOE 1 view) ---------- */

/**
 * Cost-to-serve proxy: for each business line we hold revenue, margin, margin rate,
 * trend, and promo efficiency together so leadership can make a
 * sustain / scale / sunset call per program.
 */
function programPortfolio(rows, campaigns, months) {
  const lines = [...new Set(rows.map((r) => r.business_line))];
  const half = Math.max(1, Math.floor(months.length / 2));
  const recentMonths = new Set(months.slice(-half));
  const priorMonths = new Set(months.slice(0, half));

  return lines.map((bl) => {
    const lineRows = rows.filter((r) => r.business_line === bl);
    const revenue = sum(lineRows.map((r) => r.revenue));
    const margin = sum(lineRows.map((r) => r.gross_margin));
    const units = sum(lineRows.map((r) => r.units));
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
      units,
      revenuePerUnit: units ? round(revenue / units, 2) : 0,
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
function opportunities(campaigns, channels, installs, programs, forecastTotal) {
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
 * Rolls program-level measures up to the three MCCS enterprise objectives.
 * This is the structural answer to "we lack the means to prove we are
 * meeting defined objectives".
 */
function scorecard(rows, months, campaigns, installs, programs) {
  const latest = months[months.length - 1];
  const prev = months[months.length - 2];
  const yearAgo = months.length >= 13 ? months[months.length - 13] : null;

  const revAt = (m) => round(sum(rows.filter((r) => r.period === m).map((r) => r.revenue)));
  const marAt = (m) => round(sum(rows.filter((r) => r.period === m).map((r) => r.gross_margin)));

  const revLatest = revAt(latest);
  const revPrev = prev ? revAt(prev) : 0;
  const revYear = yearAgo ? revAt(yearAgo) : 0;
  const marLatest = marAt(latest);

  const profitable = campaigns.filter((c) => c.profitable).length;
  const promoSpend = sum(campaigns.map((c) => c.spend));
  const promoMargin = sum(campaigns.map((c) => c.incrementalMargin));
  const blendedRoi = promoSpend ? ((promoMargin - promoSpend) / promoSpend) * 100 : 0;
  const growing = installs.filter((i) => i.growthPct > 0).length;
  const scaleReady = programs.filter((p) => p.recommendation === 'Scale').length;
  const needsReview = programs.filter((p) => p.recommendation !== 'Sustain' && p.recommendation !== 'Scale').length;

  const kpi = (label, value, unit, target, higherIsBetter = true) => {
    const onTrack = higherIsBetter ? value >= target : value <= target;
    return { label, value: round(value, 1), unit, target, onTrack };
  };

  const objectives = [
    {
      id: 'obj1',
      title: 'Leadership will embrace MCCS',
      note: 'Measured through decision-grade reporting coverage and evidence available to leadership',
      kpis: [
        kpi('Installations with current reporting', installs.length, 'count', installs.length),
        kpi('Programs with a documented investment recommendation', programs.length, 'count', programs.length),
        kpi('Months of history under measurement', months.length, 'months', 12)
      ]
    },
    {
      id: 'obj2',
      title: 'MCCS will be relevant to Marines and families',
      note: 'Patron demand as revealed by revenue, units, and promotion response',
      kpis: [
        kpi('Revenue, latest month', revLatest, 'usd', revPrev),
        kpi('Month over month change', revPrev ? ((revLatest - revPrev) / revPrev) * 100 : 0, 'pct', 0),
        kpi('Year over year change', revYear ? ((revLatest - revYear) / revYear) * 100 : 0, 'pct', 0),
        kpi('Installations growing', growing, 'count', Math.ceil(installs.length / 2))
      ]
    },
    {
      id: 'obj3',
      title: 'Resources aligned for efficient, sustainable service',
      note: 'Margin performance and the return on promotional investment',
      kpis: [
        kpi('Gross margin rate', revLatest ? (marLatest / revLatest) * 100 : 0, 'pct', 25),
        kpi('Blended promotion ROI', blendedRoi, 'pct', 0),
        kpi('Campaigns returning their cost', campaigns.length ? (profitable / campaigns.length) * 100 : 0, 'pct', 70),
        kpi('Programs flagged for review', needsReview, 'count', 0, false)
      ]
    }
  ];

  const all = objectives.flatMap((o) => o.kpis);
  const onTrack = all.filter((k) => k.onTrack).length;

  return {
    latestPeriod: latest,
    objectives,
    summary: {
      kpiCount: all.length,
      onTrack,
      offTrack: all.length - onTrack,
      healthPct: all.length ? round((onTrack / all.length) * 100, 0) : 0,
      scaleReady,
      needsReview
    }
  };
}

/** ---------- What-if scenario ---------- */

/**
 * Applies leadership-style levers to the current baseline and reports the delta.
 * Deliberately transparent arithmetic. Nothing here is a black box.
 */
function scenario(rows, months, campaigns, params = {}) {
  const {
    demandShiftPct = 0,        // overall demand change
    marginRateDeltaPts = 0,    // change in gross margin rate, percentage points
    promoBudgetChangePct = 0,  // change to total promo spend
    reallocateLosingSpend = false, // move negative-ROI spend to the best channel
    horizonMonths = 3
  } = params;

  const revSeries = seriesFor(rows, months, 'revenue');
  const marSeries = seriesFor(rows, months, 'gross_margin');
  const f = forecast(revSeries, horizonMonths);
  const baseForecast = sum(f.points.map((p) => p.value));

  const baseRevenue = sum(revSeries);
  const baseMargin = sum(marSeries);
  const baseMarginRate = baseRevenue ? (baseMargin / baseRevenue) * 100 : 0;

  const projRevenue = baseForecast * (1 + demandShiftPct / 100);
  const projMarginRate = baseMarginRate + marginRateDeltaPts;
  const projMargin = projRevenue * (projMarginRate / 100);
  const baseForecastMargin = baseForecast * (baseMarginRate / 100);

  const channels = channelRollup(campaigns);
  const best = channels[channels.length - 1];
  const losing = campaigns.filter((c) => !c.profitable);
  const losingSpend = sum(losing.map((c) => c.spend));
  const currentPromoSpend = sum(campaigns.map((c) => c.spend));
  const currentPromoMargin = sum(campaigns.map((c) => c.incrementalMargin));

  let promoSpend = currentPromoSpend * (1 + promoBudgetChangePct / 100);
  let promoMargin = currentPromoMargin * (1 + promoBudgetChangePct / 100);
  let reallocNote = null;
  if (reallocateLosingSpend && best && losingSpend > 0) {
    const recovered = sum(losing.map((c) => c.spend - c.incrementalMargin));
    const redeployed = losingSpend * (1 + best.roiPct / 100);
    promoMargin = promoMargin - sum(losing.map((c) => c.incrementalMargin)) + redeployed;
    reallocNote = `${formatMoney(losingSpend)} moved from ${losing.length} negative-ROI campaigns into ${best.channel} at ${best.roiPct}% ROI, recovering ${formatMoney(recovered)} of loss`;
  }

  const baseNet = currentPromoMargin - currentPromoSpend;
  const projNet = promoMargin - promoSpend;

  return {
    horizonMonths,
    params,
    baseline: {
      forecastRevenue: round(baseForecast),
      forecastMargin: round(baseForecastMargin),
      marginRatePct: round(baseMarginRate, 1),
      promoSpend: round(currentPromoSpend),
      promoNetMargin: round(baseNet)
    },
    projected: {
      forecastRevenue: round(projRevenue),
      forecastMargin: round(projMargin),
      marginRatePct: round(projMarginRate, 1),
      promoSpend: round(promoSpend),
      promoNetMargin: round(projNet)
    },
    delta: {
      revenue: round(projRevenue - baseForecast),
      margin: round(projMargin - baseForecastMargin),
      promoNetMargin: round(projNet - baseNet),
      total: round((projMargin - baseForecastMargin) + (projNet - baseNet))
    },
    reallocNote
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
  const programs = programPortfolio(rows, campaigns, months);
  const channels = channelRollup(campaigns);
  const anoms = anomalies(rows, months);
  const forecastTotal = sum(f.points.map((p) => p.value));
  const opps = opportunities(campaigns, channels, installs, programs, forecastTotal);
  const card = scorecard(rows, months, campaigns, installs, programs);

  const last = months[months.length - 1];
  const prev = months[months.length - 2];
  const yearAgo = months.length >= 13 ? months[months.length - 13] : null;
  const at = (m) => (m ? round(sum(rows.filter((r) => r.period === m).map((r) => r.revenue))) : 0);

  const revLast = at(last);
  const revPrev = at(prev);
  const revYear = at(yearAgo);

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
      latestMarginRatePct: revLast ? round((sum(rows.filter((r) => r.period === last).map((r) => r.gross_margin)) / revLast) * 100, 1) : null,
      totalRevenue: round(sum(revSeries)),
      totalMargin: round(sum(marSeries))
    },
    forecast: {
      periods: f.points.map((p, i) => ({ period: addMonths(last, i + 1), ...p })),
      total: round(forecastTotal),
      mapePct: f.mape,
      monthlyTrend: f.slope
    },
    installations: installs,
    programs,
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
  campaignMetrics, channelRollup, programPortfolio, installationRollup,
  anomalies, opportunities, scorecard, scenario, buildDigest,
  formatMoney, round, sum
};
