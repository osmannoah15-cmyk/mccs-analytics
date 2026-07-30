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

    CREATE TABLE IF NOT EXISTS sales_fact (
      id              SERIAL PRIMARY KEY,
      period          DATE NOT NULL,
      installation_id INTEGER NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
      category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      revenue         NUMERIC(14,2) NOT NULL DEFAULT 0,
      gross_margin    NUMERIC(14,2) NOT NULL DEFAULT 0,
      units           INTEGER NOT NULL DEFAULT 0,
      source          TEXT NOT NULL DEFAULT 'seed',
      updated_by      INTEGER REFERENCES users(id),
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
      spend             NUMERIC(14,2) NOT NULL DEFAULT 0,
      markdown_pct      NUMERIC(6,2) NOT NULL DEFAULT 0,
      baseline_revenue  NUMERIC(14,2) NOT NULL DEFAULT 0,
      promo_revenue     NUMERIC(14,2) NOT NULL DEFAULT 0,
      incremental_margin NUMERIC(14,2) NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'active',
      updated_by        INTEGER REFERENCES users(id),
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
