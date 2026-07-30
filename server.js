'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool, initSchema } = require('./src/db');
const { router: authRouter, requireAuth, bootstrapAdmin } = require('./src/auth');
const { router: apiRouter } = require('./src/routes/api');
const aiRouter = require('./src/routes/ai');

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
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
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
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Static assets stay behind auth so the dashboard is not readable when logged out.
app.use('/assets', requireAuth, express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1h' : 0 }));
// The login page's own stylesheet must be reachable while logged out.
app.use('/public', express.static(path.join(__dirname, 'public', 'css')));

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

    if (process.env.AUTO_SEED === 'true') {
      const { seed } = require('./src/seed/seed');
      await seed();
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`MCCS Revenue Intelligence listening on ${PORT}`);
      console.log(`Ask Sage configured: ${require('./src/asksage').isConfigured()}`);
    });
  } catch (e) {
    console.error('Startup failed:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing pool.');
  pool.end(() => process.exit(0));
});

start();
