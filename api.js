'use strict';
const express = require('express');
const multer = require('multer');
const { q, audit } = require('./db');
const M = require('./metrics');
const { requireApiAuth } = require('./auth');

const router = express.Router();
router.use(requireApiAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const canWrite = (req) => ['admin', 'analyst'].includes(req.session.user.role);
const denyReadOnly = (res) => res.status(403).json({ error: 'Your role is read-only' });

/** Shared loader: pulls sales rows with filters applied. */
async function loadSales(filters = {}) {
  const where = [];
  const params = [];
  let i = 1;

  if (filters.installation && filters.installation !== 'all') {
    where.push(`i.name = $${i++}`); params.push(filters.installation);
  }
  if (filters.businessLine && filters.businessLine !== 'all') {
    where.push(`c.business_line = $${i++}`); params.push(filters.businessLine);
  }
  if (filters.category && filters.category !== 'all') {
    where.push(`c.category = $${i++}`); params.push(filters.category);
  }
  if (filters.from) { where.push(`s.period >= $${i++}`); params.push(filters.from); }
  if (filters.to) { where.push(`s.period <= $${i++}`); params.push(filters.to); }

  const sql = `
    SELECT s.id,
           TO_CHAR(s.period,'YYYY-MM-DD') AS period,
           i.name AS installation,
           c.business_line,
           c.category,
           s.transactions,
           s.units_sold,
           s.revenue::float8       AS revenue,
           s.cogs::float8          AS cogs,
           s.gross_margin::float8  AS gross_margin,
           s.inventory_units,
           s.source,
           s.updated_at
    FROM sales_fact s
    JOIN installations i ON i.id = s.installation_id
    JOIN categories    c ON c.id = s.category_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.period, i.name, c.business_line, c.category
  `;
  const { rows } = await q(sql, params);
  return rows;
}

async function loadCampaigns(filters = {}) {
  const where = [];
  const params = [];
  let i = 1;
  if (filters.installation && filters.installation !== 'all') {
    where.push(`(installation = $${i++} OR installation = 'All Installations')`);
    params.push(filters.installation);
  }
  if (filters.businessLine && filters.businessLine !== 'all') {
    where.push(`business_line = $${i++}`); params.push(filters.businessLine);
  }
  if (filters.channel && filters.channel !== 'all') {
    where.push(`channel = $${i++}`); params.push(filters.channel);
  }
  const { rows } = await q(
    `SELECT id, code, name, channel, installation, business_line,
            TO_CHAR(start_date,'YYYY-MM-DD') AS start_date,
            TO_CHAR(end_date,'YYYY-MM-DD') AS end_date,
            spend::float8 AS spend,
            markdown_pct::float8 AS markdown_pct,
            baseline_revenue::float8 AS baseline_revenue,
            promo_revenue::float8 AS promo_revenue,
            margin_rate_pct::float8 AS margin_rate_pct,
            incremental_margin::float8 AS incremental_margin,
            status
     FROM campaigns
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY code`, params);
  return rows;
}

const filtersFrom = (query) => ({
  installation: query.installation || 'all',
  businessLine: query.businessLine || 'all',
  category: query.category || 'all',
  channel: query.channel || 'all',
  from: query.from || null,
  to: query.to || null
});

/** ---------- Reference data for the filter controls ---------- */
router.get('/meta', async (_req, res, next) => {
  try {
    const [insts, cats, chans, periods] = await Promise.all([
      q('SELECT name FROM installations ORDER BY name'),
      q('SELECT DISTINCT business_line, category FROM categories ORDER BY business_line, category'),
      q('SELECT DISTINCT channel FROM campaigns ORDER BY channel'),
      q(`SELECT TO_CHAR(MIN(period),'YYYY-MM-DD') AS first,
                TO_CHAR(MAX(period),'YYYY-MM-DD') AS last,
                COUNT(*)::int AS rows FROM sales_fact`)
    ]);
    res.json({
      installations: insts.rows.map((r) => r.name),
      businessLines: [...new Set(cats.rows.map((r) => r.business_line))],
      categories: cats.rows,
      channels: chans.rows.map((r) => r.channel),
      coverage: periods.rows[0]
    });
  } catch (e) { next(e); }
});

/** ---------- The full analytics payload ---------- */
router.get('/analytics', async (req, res, next) => {
  try {
    const filters = filtersFrom(req.query);
    const [sales, camps] = await Promise.all([loadSales(filters), loadCampaigns(filters)]);
    if (!sales.length) return res.json({ empty: true, filters });

    const months = M.monthsOf(sales);
    const revenue = M.seriesFor(sales, months, 'revenue');
    const margin = M.seriesFor(sales, months, 'gross_margin');
    const f = M.forecast(revenue, 3);
    const digest = M.buildDigest(sales, camps, filters);

    res.json({
      filters,
      months,
      series: { revenue, margin },
      forecast: {
        ...f,
        periods: f.points.map((p, i) => ({ period: M.addMonths(months[months.length - 1], i + 1), ...p }))
      },
      digest,
      heatmap: buildHeatmap(sales, months),
      movers: buildMovers(sales, months)
    });
  } catch (e) { next(e); }
});

/** Revenue by installation and month, indexed to each installation's own average. */
function buildHeatmap(rows, months) {
  const insts = [...new Set(rows.map((r) => r.installation))].sort();
  return insts.map((inst) => {
    const iRows = rows.filter((r) => r.installation === inst);
    const vals = M.seriesFor(iRows, months, 'revenue');
    const avg = vals.length ? M.sum(vals) / vals.length : 0;
    return { installation: inst, values: vals, average: M.round(avg), index: vals.map((v) => (avg ? M.round(v / avg, 3) : 1)) };
  });
}

/** Latest month versus the one before, by category. */
function buildMovers(rows, months) {
  const last = months[months.length - 1];
  const prev = months[months.length - 2];
  if (!prev) return [];
  const keyOf = (r) => `${r.business_line} - ${r.category}`;
  const agg = (period) => {
    const m = new Map();
    rows.filter((r) => r.period === period).forEach((r) => {
      m.set(keyOf(r), (m.get(keyOf(r)) || 0) + r.revenue);
    });
    return m;
  };
  const a = agg(prev), b = agg(last);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  return keys.map((k) => {
    const before = a.get(k) || 0;
    const after = b.get(k) || 0;
    return {
      label: k,
      before: M.round(before),
      after: M.round(after),
      changePct: before ? M.round(((after - before) / before) * 100, 1) : 0,
      changeAbs: M.round(after - before)
    };
  }).sort((x, y) => y.changePct - x.changePct);
}

/** ---------- Sales data explorer: paginated, sortable ---------- */
router.get('/sales', async (req, res, next) => {
  try {
    const filters = filtersFrom(req.query);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(500, Math.max(10, Number(req.query.pageSize) || 50));
    const rows = await loadSales(filters);

    const sortKey = ['period', 'installation', 'business_line', 'category',
      'transactions', 'units_sold', 'revenue', 'cogs', 'gross_margin', 'inventory_units']
      .includes(req.query.sort) ? req.query.sort : 'period';
    const dir = req.query.dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const x = a[sortKey], y = b[sortKey];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });

    const total = rows.length;
    const slice = rows.slice((page - 1) * pageSize, page * pageSize);
    res.json({
      rows: slice,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      totals: {
        revenue: M.round(M.sum(rows.map((r) => r.revenue))),
        cogs: M.round(M.sum(rows.map((r) => r.cogs))),
        margin: M.round(M.sum(rows.map((r) => r.gross_margin))),
        transactions: M.sum(rows.map((r) => r.transactions)),
        unitsSold: M.sum(rows.map((r) => r.units_sold))
      }
    });
  } catch (e) { next(e); }
});

router.post('/sales', async (req, res, next) => {
  if (!canWrite(req)) return denyReadOnly(res);
  try {
    const { period, installation, business_line, category,
            transactions, units_sold, revenue, cogs, inventory_units } = req.body;
    if (!period || !installation || !business_line || !category) {
      return res.status(400).json({ error: 'period, installation, business_line and category are required' });
    }
    const inst = await q('SELECT id FROM installations WHERE name = $1', [installation]);
    if (!inst.rows[0]) return res.status(400).json({ error: `Unknown installation: ${installation}` });
    const cat = await q('SELECT id FROM categories WHERE business_line = $1 AND category = $2',
      [business_line, category]);
    if (!cat.rows[0]) return res.status(400).json({ error: `Unknown category: ${business_line} / ${category}` });

    const rev = Number(revenue) || 0;
    const cost = Number(cogs) || 0;
    const { rows } = await q(
      `INSERT INTO sales_fact
         (period, installation_id, category_id, transactions, units_sold,
          revenue, cogs, gross_margin, inventory_units, source, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10)
       ON CONFLICT (period, installation_id, category_id) DO UPDATE
       SET transactions = EXCLUDED.transactions, units_sold = EXCLUDED.units_sold,
           revenue = EXCLUDED.revenue, cogs = EXCLUDED.cogs,
           gross_margin = EXCLUDED.gross_margin, inventory_units = EXCLUDED.inventory_units,
           source = 'manual', updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING id`,
      [period, inst.rows[0].id, cat.rows[0].id,
       Number(transactions) || 0, Number(units_sold) || 0,
       rev, cost, Number((rev - cost).toFixed(2)),
       inventory_units === '' || inventory_units == null ? null : Number(inventory_units),
       req.session.user.id]
    );
    await audit(req.session.user.id, 'sales_fact', rows[0].id, 'upsert', null, req.body);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.patch('/sales/:id', async (req, res, next) => {
  if (!canWrite(req)) return denyReadOnly(res);
  try {
    const id = Number(req.params.id);
    const before = await q(
      `SELECT transactions, units_sold, revenue::float8, cogs::float8,
              gross_margin::float8, inventory_units
       FROM sales_fact WHERE id = $1`, [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Row not found' });

    const sets = [];
    const vals = [];
    let i = 1;
    for (const f of ['transactions', 'units_sold', 'revenue', 'cogs', 'inventory_units']) {
      if (req.body[f] == null) continue;
      if (f === 'inventory_units' && req.body[f] === '') {
        sets.push(`inventory_units = NULL`);
        continue;
      }
      sets.push(`${f} = $${i++}`);
      vals.push(Number(req.body[f]) || 0);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    // Gross margin is always revenue minus COGS. Recompute it here rather than
    // letting an edit leave the two inconsistent.
    const newRev = req.body.revenue != null ? Number(req.body.revenue) || 0 : before.rows[0].revenue;
    const newCogs = req.body.cogs != null ? Number(req.body.cogs) || 0 : before.rows[0].cogs;
    sets.push(`gross_margin = $${i++}`);
    vals.push(Number((newRev - newCogs).toFixed(2)));

    sets.push(`source = 'manual'`, `updated_by = $${i++}`, `updated_at = NOW()`);
    vals.push(req.session.user.id, id);

    const { rows } = await q(
      `UPDATE sales_fact SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING id, transactions, units_sold, revenue::float8, cogs::float8,
                 gross_margin::float8, inventory_units`, vals);
    await audit(req.session.user.id, 'sales_fact', id, 'update', before.rows[0], rows[0]);
    res.json({ ok: true, row: rows[0] });
  } catch (e) { next(e); }
});

router.delete('/sales/:id', async (req, res, next) => {
  if (!canWrite(req)) return denyReadOnly(res);
  try {
    const id = Number(req.params.id);
    const before = await q('SELECT * FROM sales_fact WHERE id = $1', [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Row not found' });
    await q('DELETE FROM sales_fact WHERE id = $1', [id]);
    await audit(req.session.user.id, 'sales_fact', id, 'delete', before.rows[0], null);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** ---------- CSV export ---------- */
router.get('/sales/export', async (req, res, next) => {
  try {
    const rows = await loadSales(filtersFrom(req.query));
    const header = 'period,installation,business_line,category,transactions,units_sold,revenue,cogs,gross_margin,inventory_units';
    const body = rows.map((r) =>
      [r.period, csvCell(r.installation), csvCell(r.business_line), csvCell(r.category),
       r.transactions, r.units_sold, r.revenue, r.cogs, r.gross_margin,
       r.inventory_units == null ? '' : r.inventory_units].join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="mccs_sales_export.csv"');
    res.send(`${header}\n${body}`);
  } catch (e) { next(e); }
});

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** ---------- CSV import ---------- */
router.post('/sales/import', upload.single('file'), async (req, res, next) => {
  if (!canWrite(req)) return denyReadOnly(res);
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const text = req.file.buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV appears to be empty' });

    const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const need = ['period', 'installation', 'business_line', 'category', 'revenue'];
    // transactions, units_sold, cogs and inventory_units are optional.
    const missing = need.filter((h) => !headers.includes(h));
    if (missing.length) {
      return res.status(400).json({ error: `CSV is missing required column(s): ${missing.join(', ')}` });
    }

    const idxOf = (name) => headers.indexOf(name);
    const [instRows, catRows] = await Promise.all([
      q('SELECT id, name FROM installations'),
      q('SELECT id, business_line, category FROM categories')
    ]);
    const instMap = new Map(instRows.rows.map((r) => [r.name.toLowerCase(), r.id]));
    const catMap = new Map(catRows.rows.map((r) => [`${r.business_line}|${r.category}`.toLowerCase(), r.id]));

    let ok = 0;
    const errors = [];
    for (let n = 1; n < lines.length; n++) {
      const cells = splitCsvLine(lines[n]);
      const period = (cells[idxOf('period')] || '').trim();
      const instName = (cells[idxOf('installation')] || '').trim();
      const bl = (cells[idxOf('business_line')] || '').trim();
      const cat = (cells[idxOf('category')] || '').trim();

      const instId = instMap.get(instName.toLowerCase());
      const catId = catMap.get(`${bl}|${cat}`.toLowerCase());
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period)) { errors.push(`Line ${n + 1}: bad period "${period}"`); continue; }
      if (!instId) { errors.push(`Line ${n + 1}: unknown installation "${instName}"`); continue; }
      if (!catId) { errors.push(`Line ${n + 1}: unknown category "${bl} / ${cat}"`); continue; }

      const normalized = period.length === 7 ? `${period}-01` : period;
      const cell = (name) => (idxOf(name) >= 0 ? cells[idxOf(name)] : undefined);
      const numOr0 = (name) => Number(cell(name)) || 0;

      const rev = numOr0('revenue');
      // Prefer an explicit COGS column. If only gross_margin is supplied,
      // back COGS out of it so the two never disagree.
      const cogs = idxOf('cogs') >= 0
        ? numOr0('cogs')
        : (idxOf('gross_margin') >= 0 ? rev - numOr0('gross_margin') : 0);
      const invRaw = cell('inventory_units');
      const inventory = invRaw === undefined || String(invRaw).trim() === ''
        ? null : Number(invRaw) || 0;

      await q(
        `INSERT INTO sales_fact
           (period, installation_id, category_id, transactions, units_sold,
            revenue, cogs, gross_margin, inventory_units, source, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'import',$10)
         ON CONFLICT (period, installation_id, category_id) DO UPDATE
         SET transactions = EXCLUDED.transactions, units_sold = EXCLUDED.units_sold,
             revenue = EXCLUDED.revenue, cogs = EXCLUDED.cogs,
             gross_margin = EXCLUDED.gross_margin, inventory_units = EXCLUDED.inventory_units,
             source = 'import', updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [normalized, instId, catId,
         numOr0('transactions'), numOr0('units_sold'),
         rev, cogs, Number((rev - cogs).toFixed(2)), inventory,
         req.session.user.id]
      );
      ok++;
    }
    await audit(req.session.user.id, 'sales_fact', null, 'import',
      null, { filename: req.file.originalname, imported: ok, rejected: errors.length });
    res.json({ ok: true, imported: ok, rejected: errors.length, errors: errors.slice(0, 25) });
  } catch (e) { next(e); }
});

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** ---------- Campaigns ---------- */
router.get('/campaigns', async (req, res, next) => {
  try {
    const rows = await loadCampaigns(filtersFrom(req.query));
    const campaigns = rows.map(M.campaignMetrics);
    res.json({ campaigns, channels: M.channelRollup(campaigns) });
  } catch (e) { next(e); }
});

router.patch('/campaigns/:id', async (req, res, next) => {
  if (!canWrite(req)) return denyReadOnly(res);
  try {
    const id = Number(req.params.id);
    const before = await q('SELECT * FROM campaigns WHERE id = $1', [id]);
    if (!before.rows[0]) return res.status(404).json({ error: 'Campaign not found' });

    const allowed = ['spend', 'markdown_pct', 'baseline_revenue', 'promo_revenue', 'incremental_margin', 'status'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const f of allowed) {
      if (req.body[f] != null) {
        sets.push(`${f} = $${i++}`);
        vals.push(f === 'status' ? String(req.body[f]) : Number(req.body[f]) || 0);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push(`updated_by = $${i++}`, 'updated_at = NOW()');
    vals.push(req.session.user.id, id);

    const { rows } = await q(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    await audit(req.session.user.id, 'campaigns', id, 'update', before.rows[0], rows[0]);
    res.json({ ok: true, campaign: M.campaignMetrics(rows[0]) });
  } catch (e) { next(e); }
});

/** ---------- What-if scenarios ---------- */
router.post('/scenario', async (req, res, next) => {
  try {
    const filters = filtersFrom(req.body.filters || {});
    const [sales, camps] = await Promise.all([loadSales(filters), loadCampaigns(filters)]);
    if (!sales.length) return res.status(400).json({ error: 'No data for those filters' });
    const months = M.monthsOf(sales);
    const result = M.scenario(sales, months, camps.map(M.campaignMetrics), req.body.params || {});
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/scenarios', async (req, res, next) => {
  try {
    const { rows } = await q(
      'SELECT id, name, params, created_at FROM scenarios WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.session.user.id]);
    res.json({ scenarios: rows });
  } catch (e) { next(e); }
});

router.post('/scenarios', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await q(
      'INSERT INTO scenarios (user_id, name, params) VALUES ($1,$2,$3) RETURNING id, name, params, created_at',
      [req.session.user.id, name, JSON.stringify(req.body.params || {})]);
    res.status(201).json({ scenario: rows[0] });
  } catch (e) { next(e); }
});

/** ---------- Audit trail ---------- */
router.get('/audit', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT a.id, a.entity, a.entity_id, a.action, a.created_at, u.email
       FROM data_audit a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC LIMIT 100`);
    res.json({ entries: rows });
  } catch (e) { next(e); }
});

module.exports = { router, loadSales, loadCampaigns, filtersFrom };
