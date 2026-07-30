'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { q, pool, initSchema } = require('./db');

const DATASET_PATH = path.join(__dirname, 'dataset.json');

// Sales row layout produced by convert_excel.py:
// [monthIdx, instIdx, catIdx, transactions, unitsSold, revenue, cogs, inventoryUnits|null]
const M = 0, I = 1, C = 2, TXN = 3, UNITS = 4, REV = 5, COGS = 6, INV = 7;

function loadDataset() {
  if (!fs.existsSync(DATASET_PATH)) {
    console.error('');
    console.error('  dataset.json was not found next to seed.js.');
    console.error('  This is the most common reason the app deploys but shows no data.');
    console.error('  Generate it with:  python convert_excel.py MCCS_Sales_Sample_Data.xlsx');
    console.error('  then commit dataset.json and redeploy.');
    console.error('');
    throw new Error('dataset.json missing');
  }
  const raw = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8'));
  for (const key of ['months', 'insts', 'cats', 'sales', 'promos']) {
    if (!Array.isArray(raw[key])) throw new Error(`dataset.json is missing the "${key}" array`);
  }
  return raw;
}

async function seed() {
  await initSchema();
  const DATA = loadDataset();

  console.log(`Dataset: ${DATA.sales.length} sales rows, ${DATA.promos.length} campaigns` +
    (DATA.source ? ` (from ${DATA.source})` : ''));

  const { rows: existing } = await q('SELECT COUNT(*)::int AS n FROM sales_fact');
  if (existing[0].n > 0 && process.env.RESET_DATA !== 'true') {
    console.log(`Sales data already present (${existing[0].n} rows). Skipping seed.`);
    console.log('To wipe and reload, redeploy once with RESET_DATA=true set.');
    return;
  }

  if (process.env.RESET_DATA === 'true') {
    console.log('RESET_DATA=true, clearing existing analytics data...');
    await q('TRUNCATE sales_fact, campaigns, categories, installations RESTART IDENTITY CASCADE');
  }

  const instIds = [];
  for (const name of DATA.insts) {
    const { rows } = await q(
      `INSERT INTO installations (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`, [name]);
    instIds.push(rows[0].id);
  }

  const catIds = [];
  for (const raw of DATA.cats) {
    const [bl, cat] = raw.split('|');
    const { rows } = await q(
      `INSERT INTO categories (business_line, category) VALUES ($1,$2)
       ON CONFLICT (business_line, category) DO UPDATE SET category = EXCLUDED.category
       RETURNING id`, [bl, cat]);
    catIds.push(rows[0].id);
  }

  const BATCH = 150;
  let inserted = 0;
  for (let start = 0; start < DATA.sales.length; start += BATCH) {
    const slice = DATA.sales.slice(start, start + BATCH);
    const values = [];
    const params = [];
    slice.forEach((row, k) => {
      const b = k * 9;
      values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`);
      const revenue = row[REV] || 0;
      const cogs = row[COGS] || 0;
      params.push(
        `${DATA.months[row[M]]}-01`,
        instIds[row[I]],
        catIds[row[C]],
        row[TXN] || 0,
        row[UNITS] || 0,
        revenue,
        cogs,
        Number((revenue - cogs).toFixed(2)),
        row[INV] == null ? null : row[INV]
      );
    });
    await q(
      `INSERT INTO sales_fact
         (period, installation_id, category_id, transactions, units_sold, revenue, cogs, gross_margin, inventory_units)
       VALUES ${values.join(',')}
       ON CONFLICT (period, installation_id, category_id) DO UPDATE
       SET transactions = EXCLUDED.transactions,
           units_sold = EXCLUDED.units_sold,
           revenue = EXCLUDED.revenue,
           cogs = EXCLUDED.cogs,
           gross_margin = EXCLUDED.gross_margin,
           inventory_units = EXCLUDED.inventory_units`,
      params
    );
    inserted += slice.length;
  }

  for (const p of DATA.promos) {
    const incrementalMargin = Number((((p.promo || 0) - (p.base || 0)) * ((p.marginRate || 0) / 100)).toFixed(2));
    await q(
      `INSERT INTO campaigns
         (code, name, channel, installation, business_line, start_date, end_date, spend,
          markdown_pct, baseline_revenue, promo_revenue, margin_rate_pct, incremental_margin, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active')
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, channel = EXCLUDED.channel,
         installation = EXCLUDED.installation, business_line = EXCLUDED.business_line,
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
         spend = EXCLUDED.spend, markdown_pct = EXCLUDED.markdown_pct,
         baseline_revenue = EXCLUDED.baseline_revenue, promo_revenue = EXCLUDED.promo_revenue,
         margin_rate_pct = EXCLUDED.margin_rate_pct,
         incremental_margin = EXCLUDED.incremental_margin`,
      [p.id, p.name, p.ch, p.inst, p.bl, p.start || null, p.end || null, p.spend,
       p.md, p.base, p.promo, p.marginRate || 0, incrementalMargin]
    );
  }

  const { rows: check } = await q(`
    SELECT COUNT(*)::int AS rows,
           TO_CHAR(MIN(period),'YYYY-MM') AS first,
           TO_CHAR(MAX(period),'YYYY-MM') AS last,
           SUM(revenue)::float8 AS revenue
    FROM sales_fact`);
  const c = check[0];

  console.log(`Seed complete: ${c.rows} sales rows (${c.first} to ${c.last}), ` +
    `${DATA.promos.length} campaigns, total revenue $${Math.round(c.revenue).toLocaleString('en-US')}`);
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
}

module.exports = { seed };
