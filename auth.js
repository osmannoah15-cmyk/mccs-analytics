'use strict';
/**
 * Ask Sage API client.
 *
 * Auth is two steps:
 *   1. POST {ASKSAGE_USER_BASE}/get-token-with-api-key  {email, api_key} -> access token
 *   2. POST {ASKSAGE_SERVER_BASE}/query with header  x-access-tokens: <token>
 *
 * The token is cached in memory and refreshed well before its 24h expiry.
 * The API key never leaves the server.
 */

const USER_BASE = (process.env.ASKSAGE_USER_BASE || 'https://api.asksage.ai/user').replace(/\/$/, '');
const SERVER_BASE = (process.env.ASKSAGE_SERVER_BASE || 'https://api.asksage.ai/server').replace(/\/$/, '');
const API_KEY = process.env.ASKSAGE_API_KEY || '';
const EMAIL = process.env.ASKSAGE_EMAIL || '';
const MODEL = process.env.ASKSAGE_MODEL || 'gpt-4.1-mini';
const TEMPERATURE = Number(process.env.ASKSAGE_TEMPERATURE || 0.2);
const TIMEOUT_MS = Number(process.env.ASKSAGE_TIMEOUT_MS || 45000);

let cachedToken = null;
let cachedAt = 0;
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000; // refresh at 20h, well inside the 24h expiry

const isConfigured = () => Boolean(API_KEY && EMAIL);

async function fetchJson(url, options, timeoutMs = TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const detail = (json && (json.message || json.error || json.detail)) || text.slice(0, 300);
      throw new Error(`Ask Sage ${res.status}: ${detail}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function getToken(force = false) {
  if (!isConfigured()) throw new Error('Ask Sage is not configured (ASKSAGE_API_KEY / ASKSAGE_EMAIL missing)');
  if (!force && cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) return cachedToken;

  const json = await fetchJson(`${USER_BASE}/get-token-with-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: EMAIL, api_key: API_KEY })
  }, 20000);

  // Response shape has varied across Ask Sage versions, so probe the likely fields.
  const token =
    json?.response?.access_token ||
    json?.access_token ||
    json?.response ||
    json?.token ||
    (typeof json === 'string' ? json : null);

  if (!token || typeof token !== 'string') {
    throw new Error('Ask Sage token response did not contain an access token');
  }
  cachedToken = token;
  cachedAt = Date.now();
  return token;
}

/** Pull the assistant text out of whatever shape /server/query returns. */
function extractMessage(json) {
  if (!json) return '';
  if (typeof json === 'string') return json;
  const candidates = [
    json.message,
    json.response,
    json?.response?.message,
    json?.response?.response,
    json?.data?.message,
    json?.choices?.[0]?.message?.content
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  // Last resort: a nested object with a string field named like a message.
  if (typeof json.response === 'object' && json.response) {
    for (const v of Object.values(json.response)) {
      if (typeof v === 'string' && v.trim().length > 20) return v.trim();
    }
  }
  return '';
}

/**
 * Send a grounded prompt to Ask Sage.
 * @param {string} message      user/query content
 * @param {object} opts         { system, model, temperature, dataset, persona }
 * @returns {Promise<{text:string, model:string, latencyMs:number}>}
 */
async function query(message, opts = {}) {
  const started = Date.now();
  const model = opts.model || MODEL;
  const system = opts.system || '';
  const composed = system ? `${system}\n\n---\n\n${message}` : message;

  const body = {
    message: composed,
    model,
    temperature: opts.temperature != null ? opts.temperature : TEMPERATURE,
    // 'none' keeps the model on the numbers we pass in rather than pulling
    // in unrelated indexed content.
    dataset: opts.dataset || 'none',
    limit_references: 0,
    live: 0
  };
  if (opts.persona != null) body.persona = opts.persona;

  const send = async (token) => fetchJson(`${SERVER_BASE}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-tokens': token },
    body: JSON.stringify(body)
  });

  let json;
  try {
    json = await send(await getToken());
  } catch (err) {
    // A stale/expired token shows up as 401/403. Refresh once and retry.
    if (/401|403|token/i.test(err.message)) {
      json = await send(await getToken(true));
    } else {
      throw err;
    }
  }

  const text = extractMessage(json);
  if (!text) throw new Error('Ask Sage returned an empty response');
  return { text, model, latencyMs: Date.now() - started };
}

async function listModels() {
  const token = await getToken();
  const json = await fetchJson(`${SERVER_BASE}/get-models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-tokens': token },
    body: JSON.stringify({})
  }, 20000);
  const list = json?.response || json?.models || json;
  return Array.isArray(list) ? list : [];
}

module.exports = { query, listModels, isConfigured, getToken, extractMessage };
