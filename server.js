'use strict';
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool, initSchema } = require('./db');
const { router: authRouter, requireAuth, bootstrapAdmin } = require('./auth');
const { router: apiRouter } = require('./api');
const aiRouter = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Render terminates TLS at its proxy, so trust it for secure cookies.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Chart.js is loaded from a CDN and the pages use inline handlers.
      // Everything is served from this origin now, so no external hosts.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set. Sessions will not survive a restart.');
}

app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  name: 'mccs.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: Number(process.env.SESSION_HOURS || 8) * 60 * 60 * 1000
  }
}));

// Health check for Render.
app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, uptime: process.uptime() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use('/auth', authRouter);
app.use('/api', apiRouter);
app.use('/api/ai', aiRouter);

// Pages
app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'app.html'));
});

// Client assets.
// Everything sits in one directory here, so each asset is served explicitly.
// Never express.static(__dirname) in a flat layout: it would publish
// server.js, db.js, and any .env sitting next to them.
app.get('/app.css', (_req, res) => {
  res.type('text/css').sendFile(path.join(__dirname, 'app.css'));
});
app.get('/client.js', requireAuth, (_req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'client.js'));
});
/**
 * Vendored assets.
 *
 * Chart.js and the typefaces used to come from public CDNs. On a restricted
 * government network either can be blocked, and a missing Chart.js leaves
 * every chart blank rather than degrading. They are npm dependencies now and
 * are served from node_modules, so the app carries everything it needs.
 */
const VENDOR = [
  ['/vendor/chart.js', 'chart.js/dist/chart.umd.js', 'application/javascript', []],
  ['/vendor/sans', '@fontsource/source-sans-3', null, ['400.css', '600.css']],
  ['/vendor/serif', '@fontsource/source-serif-4', null, ['400.css', '600.css']]
];
for (const [route, pkg, type, expect] of VENDOR) {
  const target = path.join(__dirname, 'node_modules', pkg);
  if (!fs.existsSync(target)) {
    console.warn(`ASSET MISSING: ${pkg} is not installed. Run npm install. ` +
      (type ? 'Charts will not render.' : 'Type will fall back to system fonts.'));
    continue;
  }
  // Confirm the files actually referenced are present, so a packaging change
  // upstream surfaces here rather than as blank charts or fallback type.
  const absent = expect.filter((f) => !fs.existsSync(path.join(target, f)));
  if (absent.length) {
    console.warn(`ASSET LAYOUT CHANGED: ${pkg} is missing ${absent.join(', ')}. ` +
      'Type will fall back to system fonts.');
  }
  if (type) {
    app.get(route, (_req, res) => {
      res.type(type).set('Cache-Control', isProd ? 'public, max-age=604800' : 'no-cache')
         .sendFile(target);
    });
  } else {
    app.use(route, express.static(target, { maxAge: isProd ? '7d' : 0 }));
  }
}

// Icons. Reachable while signed out, since the sign-in page shows them too.
const ICONS = [
  ['/favicon.ico', 'favicon.ico', 'image/x-icon'],
  ['/icon-32.png', 'icon-32.png', 'image/png'],
  ['/icon-180.png', 'icon-180.png', 'image/png'],
  ['/icon-512.png', 'icon-512.png', 'image/png']
];
for (const [route, file, type] of ICONS) {
  app.get(route, (_req, res) => {
    res.type(type).set('Cache-Control', isProd ? 'public, max-age=604800' : 'no-cache')
       .sendFile(path.join(__dirname, file));
  });
}

// The mark is on the sign-in page too, so it stays outside the auth gate.
app.get('/logo.png', (_req, res) => {
  res.type('image/png')
     .set('Cache-Control', isProd ? 'public, max-age=86400' : 'no-cache')
     .sendFile(path.join(__dirname, 'logo-light.png'));
});
app.get('/logo-dark.png', (_req, res) => {
  res.type('image/png')
     .set('Cache-Control', isProd ? 'public, max-age=86400' : 'no-cache')
     .sendFile(path.join(__dirname, 'logo-dark.png'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (8MB limit)' });
  res.status(500).json({ error: isProd ? 'Internal server error' : err.message });
});

async function start() {
  try {
    await initSchema();
    console.log('Schema ready.');
    await bootstrapAdmin();
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }

  // Seeding is deliberately outside the fatal block. An empty dataset is a
  // problem to report, not a reason to refuse to serve: the admin can still
  // sign in and load data from the Admin tab.
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM sales_fact');
    const isEmpty = rows[0].n === 0;

    if (process.env.AUTO_SEED === 'false') {
      console.log('AUTO_SEED=false, skipping the automatic load.');
    } else if (isEmpty || process.env.RESET_DATA === 'true') {
      // An empty database always seeds. Requiring an env var to be set
      // correctly was too easy to get wrong and failed silently.
      console.log(isEmpty ? 'No sales data found, loading dataset...' : 'RESET_DATA=true, reloading dataset...');
      const { seed } = require('./seed');
      await seed();
    } else {
      console.log(`Sales data present (${rows[0].n} rows).`);
    }
  } catch (e) {
    console.error('');
    console.error('  DATA LOAD FAILED:', e.message);
    console.error('  The app will start, but the dashboard will be empty.');
    console.error('  Sign in as an administrator and use Admin > Load data,');
    console.error('  or confirm dataset.json is committed at the repo root.');
    console.error('');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MCCS Revenue Intelligence listening on ${PORT}`);
    console.log(`Ask Sage configured: ${require('./asksage').isConfigured()}`);
  });
}

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing pool.');
  pool.end(() => process.exit(0));
});

start();
