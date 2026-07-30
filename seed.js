'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { q, pool, initSchema } = require('./db');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));

// Sales rows in the source file are [monthIdx, instIdx, catIdx, revenue, grossMargin, units]
const M = 0, I = 1, C = 2, REV = 3, GM = 4, UNITS = 5;

const periodOf = (ym) => `${ym}-01`;

function parseStart(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function seed() {
  await initSchema();

  const { rows: existing } = await q('SELECT COUNT(*)::int AS n FROM sales_fact');
  if (existing[0].n > 0 && process.env.RESET_DATA !== 'true') {
    console.log(`Sales data already present (${existing[0].n} rows). Skipping seed.`);
    console.log('To wipe and reload, run with RESET_DATA=true');
    return;
  }

  if (process.env.RESET_DATA === 'true') {
    console.log('RESET_DATA=true, clearing existing analytics data...');
    await q('TRUNCATE sales_fact, campaigns, categories, installations RESTART IDENTITY CASCADE');
  }

  // Installations
  const instIds = [];
  for (const name of DATA.insts) {
    const { rows } = await q(
      `INSERT INTO installations (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`, [name]);
    instIds.push(rows[0].id);
  }
  console.log(`Installations: ${instIds.length}`);

  // Categories, stored as "Business Line|Category"
  const catIds = [];
  for (const raw of DATA.cats) {
    const [bl, cat] = raw.split('|');
    const { rows } = await q(
      `INSERT INTO categories (business_line, category) VALUES ($1,$2)
       ON CONFLICT (business_line, category) DO UPDATE SET category = EXCLUDED.category
       RETURNING id`, [bl, cat]);
    catIds.push(rows[0].id);
  }
  console.log(`Categories: ${catIds.length}`);

  // Sales facts, inserted in batches to keep the round trips down.
  const BATCH = 200;
  let inserted = 0;
  for (let start = 0; start < DATA.sales.length; start += BATCH) {
    const slice = DATA.sales.slice(start, start + BATCH);
    const values = [];
    const params = [];
    slice.forEach((row, k) => {
      const b = k * 6;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
      params.push(
        periodOf(DATA.months[row[M]]),
        instIds[row[I]],
        catIds[row[C]],
        row[REV],
        row[GM],
        row[UNITS]
      );
    });
    await q(
      `INSERT INTO sales_fact (period, installation_id, category_id, revenue, gross_margin, units)
       VALUES ${values.join(',')}
       ON CONFLICT (period, installation_id, category_id) DO UPDATE
       SET revenue = EXCLUDED.revenue,
           gross_margin = EXCLUDED.gross_margin,
           units = EXCLUDED.units`,
      params
    );
    inserted += slice.length;
  }
  console.log(`Sales rows: ${inserted}`);

  // Campaigns
  for (const p of DATA.promos) {
    await q(
      `INSERT INTO campaigns
         (code, name, channel, installation, business_line, start_date, spend,
          markdown_pct, baseline_revenue, promo_revenue, incremental_margin, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name, channel = EXCLUDED.channel,
         installation = EXCLUDED.installation, business_line = EXCLUDED.business_line,
         start_date = EXCLUDED.start_date, spend = EXCLUDED.spend,
         markdown_pct = EXCLUDED.markdown_pct, baseline_revenue = EXCLUDED.baseline_revenue,
         promo_revenue = EXCLUDED.promo_revenue, incremental_margin = EXCLUDED.incremental_margin`,
      [p.id, p.name, p.ch, p.inst, p.bl, parseStart(p.start), p.spend,
       p.md, p.base, p.promo, p.im]
    );
  }
  console.log(`Campaigns: ${DATA.promos.length}`);
  console.log('Seed complete.');
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((e) => { console.error('Seed failed:', e); process.exit(1); });
}

module.exports = { seed };
