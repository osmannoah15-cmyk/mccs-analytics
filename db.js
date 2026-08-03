'use strict';
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('FATAL: DATABASE_URL is not set. Add it in Render or your .env file.');
  process.exit(1);
}

// Render's managed Postgres requires SSL. Local dev usually does not.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => console.error('Unexpected Postgres pool error', err));

const q = (text, params) => pool.query(text, params);

/**
 * Creates every table the app needs. Safe to run on every boot.
 */
async function initSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name     TEXT,
      role          TEXT NOT NULL DEFAULT 'analyst',
      is_active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS installations (
      id   SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id            SERIAL PRIMARY KEY,
      business_line TEXT NOT NULL,
      category      TEXT NOT NULL,
      UNIQUE (business_line, category)
    );

    -- Which installations an account may see. No rows for a user means
    -- unrestricted, so accounts created before this existed are unaffected.
    CREATE TABLE IF NOT EXISTS user_installations (
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, installation_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_inst ON user_installations(user_id);

    CREATE TABLE IF NOT EXISTS sales_fact (
      id              SERIAL PRIMARY KEY,
      period          DATE NOT NULL,
      installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
      category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      transactions    INTEGER NOT NULL DEFAULT 0,
      units_sold      INTEGER NOT NULL DEFAULT 0,
      revenue         NUMERIC(14,2) NOT NULL DEFAULT 0,
      cogs            NUMERIC(14,2) NOT NULL DEFAULT 0,
      gross_margin    NUMERIC(14,2) NOT NULL DEFAULT 0,
      inventory_units INTEGER,
      source          TEXT NOT NULL DEFAULT 'seed',
      updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (period, installation_id, category_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sales_period ON sales_fact(period);
    CREATE INDEX IF NOT EXISTS idx_sales_inst   ON sales_fact(installation_id);
    CREATE INDEX IF NOT EXISTS idx_sales_cat    ON sales_fact(category_id);

    CREATE TABLE IF NOT EXISTS campaigns (
      id                SERIAL PRIMARY KEY,
      code              TEXT UNIQUE NOT NULL,
      name              TEXT NOT NULL,
      channel           TEXT NOT NULL,
      installation      TEXT NOT NULL,
      business_line     TEXT NOT NULL,
      start_date        DATE,
      end_date          DATE,
      spend             NUMERIC(14,2) NOT NULL DEFAULT 0,
      markdown_pct      NUMERIC(6,2) NOT NULL DEFAULT 0,
      baseline_revenue  NUMERIC(14,2) NOT NULL DEFAULT 0,
      promo_revenue     NUMERIC(14,2) NOT NULL DEFAULT 0,
      margin_rate_pct   NUMERIC(6,2) NOT NULL DEFAULT 0,
      incremental_margin NUMERIC(14,2) NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active',
      updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Full audit trail of every AI call. Matters for a federal customer.
    CREATE TABLE IF NOT EXISTS ai_log (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind          TEXT NOT NULL,
      prompt        TEXT,
      response      TEXT,
      model         TEXT,
      engine        TEXT,
      latency_ms    INTEGER,
      ok            BOOLEAN NOT NULL DEFAULT TRUE,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Change history for the sales data so edits are traceable.
    CREATE TABLE IF NOT EXISTS data_audit (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      entity     TEXT NOT NULL,
      entity_id  TEXT,
      action     TEXT NOT NULL,
      before_val JSONB,
      after_val  JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Saved what-if scenarios.
    CREATE TABLE IF NOT EXISTS scenarios (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      params     JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await migrate();
}

/**
 * Brings a database created by an earlier version up to the current shape.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
 * deployment made before these columns were added would silently keep the old
 * layout and every insert would fail. Each statement below is idempotent and
 * safe to run on every boot.
 */
async function migrate() {
  const statements = [
    `ALTER TABLE sales_fact ADD COLUMN IF NOT EXISTS transactions INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sales_fact ADD COLUMN IF NOT EXISTS units_sold INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE sales_fact ADD COLUMN IF NOT EXISTS cogs NUMERIC(14,2) NOT NULL DEFAULT 0`,
    `ALTER TABLE sales_fact ADD COLUMN IF NOT EXISTS inventory_units INTEGER`,
    `ALTER TABLE campaigns  ADD COLUMN IF NOT EXISTS end_date DATE`,
    `ALTER TABLE campaigns  ADD COLUMN IF NOT EXISTS margin_rate_pct NUMERIC(6,2) NOT NULL DEFAULT 0`
  ];
  for (const sql of statements) {
    try {
      await q(sql);
    } catch (e) {
      console.warn('migration step skipped:', e.message);
    }
  }

  // Deleting an account must not fail because an old edit points at it, and
  // must not take the edited data with it. These two columns were created
  // without a delete rule, so an existing database needs them replaced.
  for (const [table, constraint, column] of [
    ['sales_fact', 'sales_fact_updated_by_fkey', 'updated_by'],
    ['campaigns', 'campaigns_updated_by_fkey', 'updated_by']
  ]) {
    try {
      const { rows } = await q(`
        SELECT confdeltype FROM pg_constraint
        WHERE conname = $1 AND conrelid = $2::regclass`, [constraint, table]);
      // 'a' is NO ACTION, the default. 'n' is SET NULL, which is what we want.
      if (rows.length && rows[0].confdeltype === 'a') {
        await q(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
        await q(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint}
                 FOREIGN KEY (${column}) REFERENCES users(id) ON DELETE SET NULL`);
        console.log(`Migrated ${table}.${column} to ON DELETE SET NULL.`);
      }
    } catch (e) {
      console.warn(`could not migrate ${constraint}:`, e.message);
    }
  }

  // The original schema called this column "units" while it actually held
  // transaction counts. If that column is still present, move its values into
  // transactions and drop it so the two are never confused again.
  try {
    const { rows } = await q(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'sales_fact' AND column_name = 'units'`);
    if (rows.length) {
      await q(`UPDATE sales_fact SET transactions = units WHERE transactions = 0`);
      await q(`ALTER TABLE sales_fact DROP COLUMN units`);
      console.log('Migrated legacy "units" column into "transactions".');
    }
  } catch (e) {
    console.warn('legacy units migration skipped:', e.message);
  }
}

async function audit(userId, entity, entityId, action, before, after) {
  try {
    await q(
      `INSERT INTO data_audit (user_id, entity, entity_id, action, before_val, after_val)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId || null, entity, entityId ? String(entityId) : null, action,
       before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  } catch (e) {
    console.warn('audit write failed:', e.message);
  }
}

module.exports = { pool, q, initSchema, audit };
