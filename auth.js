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

/**
 * The installations an account may see, or null for unrestricted.
 *
 * Cached on the session so it is not queried on every request, and cleared
 * whenever an administrator changes it. Enforcement happens in the data layer
 * rather than the interface: hiding a filter option would not stop anyone
 * requesting another installation directly.
 */
async function scopeFor(req) {
  if (!req.session?.user) return [];
  if (req.session.scope !== undefined) return req.session.scope;

  const { rows } = await q(
    `SELECT i.name FROM user_installations ui
     JOIN installations i ON i.id = ui.installation_id
     WHERE ui.user_id = $1 ORDER BY i.name`,
    [req.session.user.id]
  );
  req.session.scope = rows.length ? rows.map((r) => r.name) : null;
  return req.session.scope;
}

/** Attaches req.scope so downstream routes can filter without another query. */
async function withScope(req, _res, next) {
  try {
    req.scope = await scopeFor(req);
    next();
  } catch (e) { next(e); }
}

/** Drop the cached scope so the next request re-reads it. */
async function invalidateScope(userId) {
  try {
    await q(`DELETE FROM session WHERE sess::jsonb -> 'user' ->> 'id' = $1`, [String(userId)]);
  } catch (e) {
    // Not fatal: the change simply takes effect at the user's next sign-in.
    console.warn('could not clear sessions for user', userId, e.message);
  }
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

router.get('/me', requireApiAuth, async (req, res, next) => {
  try {
    res.json({ user: req.session.user, scope: await scopeFor(req) });
  } catch (e) { next(e); }
});

/** Admin-only user management. */
router.get('/users', requireApiAuth, requireAdmin, async (_req, res) => {
  const { rows } = await q(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at, u.last_login_at,
            COALESCE(
              ARRAY_AGG(i.name ORDER BY i.name) FILTER (WHERE i.name IS NOT NULL),
              '{}'
            ) AS installations
     FROM users u
     LEFT JOIN user_installations ui ON ui.user_id = u.id
     LEFT JOIN installations i ON i.id = ui.installation_id
     GROUP BY u.id
     ORDER BY u.created_at`
  );
  res.json({ users: rows });
});

/** Every installation, for the assignment dialog. Admin only. */
router.get('/installations', requireApiAuth, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await q('SELECT name FROM installations ORDER BY name');
    res.json({ installations: rows.map((r) => r.name) });
  } catch (e) { next(e); }
});

/** Replace an account's installation scope. An empty list means unrestricted. */
router.put('/users/:id/installations', requireApiAuth, requireAdmin, async (req, res, next) => {
  const id = Number(req.params.id);
  const names = Array.isArray(req.body.installations) ? req.body.installations : [];
  try {
    const target = await q('SELECT id, role FROM users WHERE id = $1', [id]);
    if (!target.rows[0]) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].role === 'admin' && names.length) {
      return res.status(400).json({
        error: 'Administrators always see every installation. Change the role first to restrict access.'
      });
    }

    await q('DELETE FROM user_installations WHERE user_id = $1', [id]);
    if (names.length) {
      const found = await q('SELECT id, name FROM installations WHERE name = ANY($1)', [names]);
      const unknown = names.filter((n) => !found.rows.some((r) => r.name === n));
      if (unknown.length) return res.status(400).json({ error: `Unknown installation: ${unknown[0]}` });
      for (const row of found.rows) {
        await q('INSERT INTO user_installations (user_id, installation_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [id, row.id]);
      }
    }
    await invalidateScope(id);
    res.json({ ok: true, installations: names });
  } catch (e) { next(e); }
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
    // An administrator with a partial view would be misleading, so promotion
    // clears any restriction rather than silently keeping it.
    if (req.body.role === 'admin') await q('DELETE FROM user_installations WHERE user_id = $1', [id]);
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
  await invalidateScope(id);
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

module.exports = { router, requireAuth, requireApiAuth, requireAdmin, bootstrapAdmin, scopeFor, withScope };
