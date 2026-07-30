'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { q } = require('./db');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' }
});

/** Gate for page routes: bounce to the login screen. */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.accepts('html') && !req.xhr && !req.path.startsWith('/api/')) {
    return res.redirect('/login');
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

/** Gate for API routes: always JSON. */
function requireApiAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Administrator access required' });
}

/**
 * Creates the first admin from env vars if the users table is empty.
 * Lets you deploy without shelling into the database.
 */
async function bootstrapAdmin() {
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return;

  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) {
    console.warn('No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set. Set them and redeploy to create the first account.');
    return;
  }
  if (password.length < 10) {
    console.warn('ADMIN_PASSWORD is shorter than 10 characters. Choose a longer one.');
  }
  const hash = await bcrypt.hash(password, 12);
  await q(
    `INSERT INTO users (email, password_hash, full_name, role)
     VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO NOTHING`,
    [email, hash, process.env.ADMIN_NAME || 'Administrator']
  );
  console.log(`Bootstrapped admin account: ${email}`);
}

router.post('/login', loginLimiter, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    const { rows } = await q(
      'SELECT id, email, password_hash, full_name, role, is_active FROM users WHERE email = $1',
      [email]
    );
    const user = rows[0];
    // Same message either way so the form cannot be used to enumerate accounts.
    const fail = () => res.status(401).json({ error: 'Invalid email or password' });
    if (!user || !user.is_active) return fail();

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return fail();

    await q('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'Session error' });
      req.session.user = {
        id: user.id,
        email: user.email,
        name: user.full_name || user.email,
        role: user.role
      };
      req.session.save(() => res.json({ ok: true, user: req.session.user }));
    });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mccs.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireApiAuth, (req, res) => res.json({ user: req.session.user }));

/** Admin-only user management. */
router.get('/users', requireApiAuth, requireAdmin, async (_req, res) => {
  const { rows } = await q(
    `SELECT id, email, full_name, role, is_active, created_at, last_login_at
     FROM users ORDER BY created_at`
  );
  res.json({ users: rows });
});

router.post('/users', requireApiAuth, requireAdmin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const fullName = String(req.body.full_name || '').trim();
  const role = ['admin', 'analyst', 'viewer'].includes(req.body.role) ? req.body.role : 'viewer';

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await q(
      `INSERT INTO users (email, password_hash, full_name, role)
       VALUES ($1,$2,$3,$4)
       RETURNING id, email, full_name, role, is_active, created_at`,
      [email, hash, fullName || null, role]
    );
    res.status(201).json({ user: rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That email already exists' });
    console.error(e);
    res.status(500).json({ error: 'Could not create user' });
  }
});

router.patch('/users/:id', requireApiAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const sets = [];
  const vals = [];
  let i = 1;

  if (req.body.role && ['admin', 'analyst', 'viewer'].includes(req.body.role)) {
    sets.push(`role = $${i++}`); vals.push(req.body.role);
  }
  if (typeof req.body.is_active === 'boolean') {
    sets.push(`is_active = $${i++}`); vals.push(req.body.is_active);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters' });
    }
    sets.push(`password_hash = $${i++}`); vals.push(await bcrypt.hash(String(req.body.password), 12));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  vals.push(id);
  const { rows } = await q(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i}
     RETURNING id, email, full_name, role, is_active`,
    vals
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ user: rows[0] });
});

router.post('/change-password', requireApiAuth, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  if (next.length < 10) return res.status(400).json({ error: 'New password must be at least 10 characters' });

  const { rows } = await q('SELECT password_hash FROM users WHERE id = $1', [req.session.user.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (!(await bcrypt.compare(current, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  await q('UPDATE users SET password_hash = $1 WHERE id = $2',
    [await bcrypt.hash(next, 12), req.session.user.id]);
  res.json({ ok: true });
});

module.exports = { router, requireAuth, requireApiAuth, requireAdmin, bootstrapAdmin };
