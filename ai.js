'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { q } = require('./db');
const M = require('./metrics');
const sage = require('./asksage');
const { requireApiAuth } = require('./auth');
const { loadSales, loadCampaigns, filtersFrom } = require('./api');

const router = express.Router();
router.use(requireApiAuth);

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AI_RATE_LIMIT_PER_MIN || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request limit reached. Wait a moment and try again.' }
}));

const money = M.formatMoney;
const pct = (n) => (n == null ? 'n/a' : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`);

const SYSTEM = `You are the analytics assistant inside MCCS Revenue Intelligence, a decision-support tool for Marine Corps Community Services headquarters.

Hard rules:
- Use ONLY the metrics provided in the JSON payload. Never invent, estimate, or recall a number from anywhere else.
- If the payload does not contain what is needed to answer, say so plainly and name what is missing.
- Write for a senior government executive: direct, specific, no filler and no marketing tone.
- Refer to money in the same rounded form the payload uses.
- Do not use em dashes anywhere in your output.
- Never claim data is real. This is a synthetic prototype dataset.

Framing: MCCS measures itself against three enterprise objectives (leadership embrace, patron relevancy, resource efficiency) and four lines of effort (LOE 1 Innovate for Relevancy, LOE 2 Tell Our Story, LOE 3 Collaborate Effectively, LOE 4 Measure What Matters). When it is genuinely relevant, connect a finding to the objective or line of effort it informs. Do not force the connection.`;

/** Records every call for auditability, then returns the payload. */
async function logAi(userId, kind, prompt, response, engine, model, latency, ok, error) {
  try {
    await q(
      `INSERT INTO ai_log (user_id, kind, prompt, response, model, engine, latency_ms, ok, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId, kind, String(prompt).slice(0, 8000), String(response || '').slice(0, 12000),
       model || null, engine, latency || null, ok, error || null]
    );
  } catch (e) { console.warn('ai_log write failed:', e.message); }
}

/**
 * Runs a prompt through Ask Sage, falling back to a deterministic writer.
 * The fallback is what keeps a live demo safe on a bad network.
 */
async function runAi({ req, kind, prompt, fallback }) {
  const started = Date.now();
  if (!sage.isConfigured()) {
    const text = fallback();
    await logAi(req.session.user.id, kind, prompt, text, 'builtin', null, Date.now() - started, true, 'not configured');
    return { text, engine: 'builtin', note: 'Ask Sage is not configured, using the built-in metrics writer' };
  }
  try {
    const out = await sage.query(prompt, { system: SYSTEM });
    await logAi(req.session.user.id, kind, prompt, out.text, 'asksage', out.model, out.latencyMs, true, null);
    return { text: out.text, engine: 'asksage', model: out.model, latencyMs: out.latencyMs };
  } catch (err) {
    const text = fallback();
    await logAi(req.session.user.id, kind, prompt, text, 'builtin', null, Date.now() - started, false, err.message);
    console.warn(`Ask Sage call failed (${kind}):`, err.message);
    return { text, engine: 'builtin', note: `Ask Sage unavailable: ${err.message}` };
  }
}

async function digestFor(query) {
  const filters = filtersFrom(query || {});
  const [sales, camps] = await Promise.all([loadSales(filters), loadCampaigns(filters)]);
  if (!sales.length) return null;
  return M.buildDigest(sales, camps, filters);
}

/** ---------- Executive briefing ---------- */
router.post('/brief', async (req, res, next) => {
  try {
    const d = await digestFor(req.body.filters);
    if (!d) return res.status(400).json({ error: 'No data for those filters' });

    const prompt = `Write an executive briefing in five short paragraphs covering, in order:
1. Latest month performance against the prior month and the same month last year.
2. The three month forecast, and what the tested accuracy figure implies about confidence. The accuracy figure is measured out of sample, by holding back recent months and scoring against them, so treat it as a real indication rather than a fit statistic.
3. Installation performance, naming the strongest and weakest.
4. Promotion economics, including how much spend sits in campaigns that do not return their cost.
5. The single highest value action to take next, with the dollar figure attached.

Metrics:
${JSON.stringify(d, null, 1)}`;

    const out = await runAi({
      req, kind: 'brief', prompt, fallback: () => fallbackBrief(d)
    });
    res.json({ ...out, digest: d });
  } catch (e) { next(e); }
});

/** ---------- Ask the data ---------- */
router.post('/ask', async (req, res, next) => {
  try {
    const question = String(req.body.question || '').trim();
    if (!question) return res.status(400).json({ error: 'A question is required' });
    if (question.length > 800) return res.status(400).json({ error: 'Question is too long' });

    const d = await digestFor(req.body.filters);
    if (!d) return res.status(400).json({ error: 'No data for those filters' });

    const prompt = `Answer the question below using only these metrics. Two to four sentences. Quote the specific figures that support the answer.

Question: ${question}

Metrics:
${JSON.stringify(d, null, 1)}`;

    const out = await runAi({
      req, kind: 'ask', prompt, fallback: () => fallbackAnswer(question, d)
    });
    res.json(out);
  } catch (e) { next(e); }
});

/** ---------- Per-campaign recommendation ---------- */
router.post('/campaign/:id', async (req, res, next) => {
  try {
    const { rows } = await q('SELECT * FROM campaigns WHERE id = $1', [Number(req.params.id)]);
    if (!rows[0]) return res.status(404).json({ error: 'Campaign not found' });

    const c = M.campaignMetrics(rows[0]);
    const all = (await loadCampaigns({})).map(M.campaignMetrics);
    const channels = M.channelRollup(all);
    const peer = channels.find((x) => x.channel === c.channel);
    const best = channels[channels.length - 1];

    const prompt = `Assess this single campaign and give a clear recommendation: continue, rework, or stop. Three or four sentences. Reference its ROI against its channel average and against the best performing channel.

Campaign: ${JSON.stringify(c, null, 1)}
Its channel overall: ${JSON.stringify(peer, null, 1)}
Best channel overall: ${JSON.stringify(best, null, 1)}`;

    const out = await runAi({
      req, kind: 'campaign', prompt,
      fallback: () => {
        const verdict = c.roiPct >= 50 ? 'Continue and consider scaling.'
          : c.roiPct >= 0 ? 'Continue, but rework the offer to lift margin.'
          : 'Stop or rebuild. It is not returning its cost.';
        return `${c.name} (${c.channel}, ${c.installation}) spent ${money(c.spend)} and produced ${money(c.incrementalMargin)} of incremental margin on ${pct(c.liftPct)} lift, for ${pct(c.roiPct)} ROI and a net of ${money(c.netMargin)}. Its channel averages ${pct(peer?.roiPct)} and the strongest channel is ${best?.channel} at ${pct(best?.roiPct)}. ${verdict}`;
      }
    });
    res.json({ ...out, campaign: c });
  } catch (e) { next(e); }
});

/** ---------- Anomaly narrative ---------- */
router.post('/anomalies', async (req, res, next) => {
  try {
    const d = await digestFor(req.body.filters);
    if (!d) return res.status(400).json({ error: 'No data for those filters' });
    if (!d.anomalies.length) return res.json({ text: 'No month over month movements exceeded two standard deviations in this selection.', engine: 'builtin' });

    const prompt = `These are statistically unusual month over month movements. For the three most significant, explain in one sentence each what happened and what a manager should check first. Then give one sentence on whether the pattern looks seasonal or genuinely exceptional.

Anomalies: ${JSON.stringify(d.anomalies, null, 1)}
Seasonal context, monthly index: ${JSON.stringify(d.forecast, null, 1)}`;

    const out = await runAi({
      req, kind: 'anomalies', prompt,
      fallback: () => d.anomalies.slice(0, 3).map((a) =>
        `${a.installation} / ${a.businessLine} in ${a.period}: revenue ${a.direction === 'spike' ? 'rose' : 'fell'} ${pct(a.changePct)} to ${money(a.revenue)} from ${money(a.priorRevenue)}, ${Math.abs(a.zScore)} standard deviations from its own norm.`
      ).join('\n\n')
    });
    res.json({ ...out, anomalies: d.anomalies });
  } catch (e) { next(e); }
});

/** ---------- Scenario interpretation ---------- */
router.post('/scenario', async (req, res, next) => {
  try {
    const filters = filtersFrom(req.body.filters || {});
    const [sales, camps] = await Promise.all([loadSales(filters), loadCampaigns(filters)]);
    if (!sales.length) return res.status(400).json({ error: 'No data for those filters' });

    const months = M.monthsOf(sales);
    const result = M.scenario(sales, months, camps.map(M.campaignMetrics), req.body.params || {});

    const prompt = `Explain what this scenario means for the next ${result.horizonMonths} months in three or four sentences.

State the revenue and margin impact in dollars against the no-change baseline, name which lever contributed most and why, and close with one caution drawn from the assumptions listed. The steps array is a waterfall: each entry is one lever's separate effect on revenue and on margin, and they sum to the projected total.

Scenario: ${JSON.stringify(result, null, 1)}`;

    const out = await runAi({
      req, kind: 'scenario', prompt,
      fallback: () => {
        if (!result.steps.length) {
          return `No levers are set, so the projection is unchanged at ${money(result.baseline.revenue)} of revenue and ${money(result.baseline.margin)} of margin over ${result.horizonMonths} months.`;
        }
        const biggest = [...result.steps].sort((a, b) => Math.abs(b.margin) - Math.abs(a.margin))[0];
        return `This scenario moves projected revenue by ${money(result.delta.revenue)} (${pct(result.delta.revenuePct)}) and margin by ${money(result.delta.margin)} over ${result.horizonMonths} months, ending at ${money(result.projected.revenue)} revenue and ${money(result.projected.margin)} margin.\n\nThe largest single effect is "${biggest.label}" at ${money(biggest.margin)} of margin, ${biggest.basis}.\n\n${result.assumptions.join(' ')}`;
      }
    });
    res.json({ ...out, scenario: result });
  } catch (e) { next(e); }
});

/** ---------- Status and audit ---------- */
router.get('/status', async (_req, res) => {
  const configured = sage.isConfigured();
  if (!configured) return res.json({ configured: false, reachable: false, engine: 'builtin' });
  try {
    await sage.getToken();
    res.json({ configured: true, reachable: true, engine: 'asksage', model: process.env.ASKSAGE_MODEL || 'gpt-4.1-mini' });
  } catch (e) {
    res.json({ configured: true, reachable: false, engine: 'builtin', error: e.message });
  }
});

router.get('/log', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT l.id, l.kind, l.engine, l.model, l.latency_ms, l.ok, l.error, l.created_at, u.email
       FROM ai_log l LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.created_at DESC LIMIT 100`);
    res.json({ entries: rows });
  } catch (e) { next(e); }
});

/** ---------- Deterministic fallbacks ---------- */

function fallbackBrief(d) {
  const h = d.headline;
  const top = d.installations[0];
  const bottom = d.installations[d.installations.length - 1];
  const worstCh = d.channels[0];
  const bestCh = d.channels[d.channels.length - 1];
  const opp = d.opportunities;

  return `EXECUTIVE BRIEFING: ${d.coverage.latestPeriod}

Revenue for the latest month was ${money(h.latestRevenue)}, ${pct(h.momPct)} against the prior month and ${pct(h.yoyPct)} year over year, at a ${h.latestMarginRatePct}% gross margin rate.

The model projects ${money(d.forecast.total)} across the next three months. Tested against the ${d.forecast.backtest ? d.forecast.backtest.holdoutMonths : 3} most recent months, which it was not trained on, it was off by ${d.forecast.accuracyPct}% on average. Monthly trend is ${d.forecast.monthlyTrend > 0 ? 'positive' : 'negative'} at ${money(Math.abs(d.forecast.monthlyTrend))} per month.

${top.installation} leads growth at ${pct(top.growthPct)}. ${bottom.installation} trails at ${pct(bottom.growthPct)} and is the first place to look for underperformance.

${d.campaigns.profitable} of ${d.campaigns.total} campaigns return their cost. ${money(d.campaigns.spendInNegativeRoi)} of spend sits in campaigns that do not. ${worstCh.channel} is the weakest channel at ${pct(worstCh.roiPct)} and ${bestCh.channel} is the strongest at ${pct(bestCh.roiPct)}.

Recommended action: reallocate the ${money(d.campaigns.spendInNegativeRoi)} in negative-return campaigns toward ${bestCh.channel} and re-measure next cycle. Total addressable opportunity across the analysis is ${money(opp.totalAddressable)}.`;
}

function fallbackAnswer(question, d) {
  const s = question.toLowerCase();
  const has = (...w) => w.some((x) => s.includes(x));

  if (has('opportunity', 'roi', 'worth', 'value', 'save', 'saving')) {
    const items = d.opportunities.items.map((i) => `${i.label}: ${money(i.value)} (${i.basis})`).join('. ');
    return `Total addressable opportunity is ${money(d.opportunities.totalAddressable)}. ${items}.`;
  }
  if (has('scorecard', 'objective', 'measure', 'kpi', 'loe')) {
    const sc = d.scorecard;
    return `Measurement health is ${sc.summary.healthPct}%, with ${sc.summary.onTrack} of ${sc.summary.kpiCount} KPIs on track across the three enterprise objectives. ${sc.summary.scaleReady} lines of business are ready to scale and ${sc.summary.needsReview} need review.`;
  }
  if (has('line of business', 'lines of business', 'program', 'portfolio', 'sunset', 'invest')) {
    const p = d.linesOfBusiness;
    const scale = p.filter((x) => x.recommendation === 'Scale').map((x) => x.businessLine);
    const review = p.filter((x) => x.recommendation !== 'Sustain' && x.recommendation !== 'Scale').map((x) => x.businessLine);
    return `Across ${p.length} lines of business, ${scale.length ? scale.join(' and ') + ' ' + (scale.length > 1 ? 'are' : 'is') + ' recommended to scale' : 'none are flagged to scale'}. ${review.length ? review.join(' and ') + ' ' + (review.length > 1 ? 'need' : 'needs') + ' review.' : 'No lines of business are flagged for review.'} The largest by revenue is ${p[0].businessLine} at ${money(p[0].revenue)} and a ${p[0].marginRatePct}% margin rate.`;
  }
  if (has('anomal', 'unusual', 'spike', 'drop', 'outlier')) {
    if (!d.anomalies.length) return 'No movements exceeded two standard deviations in this selection.';
    const a = d.anomalies[0];
    return `The most significant movement is ${a.installation} / ${a.businessLine} in ${a.period}, ${a.direction === 'spike' ? 'up' : 'down'} ${pct(a.changePct)} to ${money(a.revenue)}, at ${a.zScore} standard deviations. ${d.anomalies.length} movements crossed the threshold in total.`;
  }
  if (has('channel')) {
    const w = d.channels[0], b = d.channels[d.channels.length - 1];
    return `${w.channel} is the weakest channel at ${pct(w.roiPct)} spend-weighted ROI across ${w.count} campaigns and ${money(w.spend)} of spend. ${b.channel} is the strongest at ${pct(b.roiPct)}.`;
  }
  if (has('install', 'grew', 'growth', 'base', 'fastest', 'slowest')) {
    const t = d.installations[0], b = d.installations[d.installations.length - 1];
    return `${t.installation} grew fastest at ${pct(t.growthPct)} comparing the recent half of the period to the earlier half. ${b.installation} is slowest at ${pct(b.growthPct)}. Across ${d.coverage.installations} installations, total revenue is ${money(d.headline.totalRevenue)}.`;
  }
  if (has('forecast', 'holiday', 'season', 'expect', 'next', 'project')) {
    const periods = d.forecast.periods.map((p) => `${p.period}: ${money(p.value)}`).join(', ');
    return `The three month projection totals ${money(d.forecast.total)} (${periods}). Accuracy is measured by holding out the most recent months and scoring against them: ${d.forecast.accuracyPct}% average error, ${d.forecast.backtest ? d.forecast.backtest.worstMonthPct + '% in the worst month' : ''}. The seasonal pattern puts the strongest months in November and December.`;
  }
  if (has('campaign', 'promo', 'worst', 'best')) {
    const w = d.campaigns.worst[0], b = d.campaigns.best[0];
    return `${d.campaigns.profitable} of ${d.campaigns.total} campaigns return their cost, on ${money(d.campaigns.totalSpend)} of total spend. Weakest is ${w.name} at ${pct(w.roiPct)} on ${money(w.spend)}. Strongest is ${b.name} at ${pct(b.roiPct)}.`;
  }
  return `Latest month revenue was ${money(d.headline.latestRevenue)} (${pct(d.headline.momPct)} month over month, ${pct(d.headline.yoyPct)} year over year), with ${d.campaigns.profitable} of ${d.campaigns.total} campaigns returning their cost and ${money(d.opportunities.totalAddressable)} of addressable opportunity identified. Ask about installations, channels, campaigns, lines of business, anomalies, the forecast, or the enterprise objectives for specifics.`;
}

module.exports = router;
