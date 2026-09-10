import crypto from 'node:crypto';
import { config } from './config.js';

const API = `https://api.telegram.org/bot${config.botToken}`;

export async function callApi(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!data.ok) {
    const err = new Error(`Telegram ${method}: ${data.description || res.status}`);
    err.code = data.error_code;
    err.description = data.description;
    throw err;
  }
  return data.result;
}

/**
 * Проверка подписи initData из Telegram Mini App.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Возвращает разобранные данные или null, если подпись не сошлась / данные протухли.
 */
export function verifyInitData(initData) {
  if (typeof initData !== 'string' || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > config.initDataMaxAgeSec) return null;

  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { /* ignore */ }
  if (!user || !user.id) return null;

  return { user, startParam: params.get('start_param') || null, authDate };
}

const SUBSCRIBED = new Set(['creator', 'administrator', 'member']);

/**
 * Проверяет подписку на канал. Требует, чтобы бот был администратором канала.
 * Возвращает { status, subscribed } либо бросает ошибку, если Telegram недоступен.
 */
export async function checkSubscription(userId) {
  try {
    const m = await callApi('getChatMember', { chat_id: config.channel, user_id: userId });
    const status = m.status;
    const subscribed = SUBSCRIBED.has(status) || (status === 'restricted' && m.is_member === true);
    return { status, subscribed };
  } catch (e) {
    // Пользователя нет в канале — Telegram отвечает ошибкой, а не статусом left.
    if (/user not found|PARTICIPANT_ID_INVALID/i.test(e.description || '')) {
      return { status: 'left', subscribed: false };
    }
    throw e;
  }
}

/* ---------- сессия мини-аппа ---------- */

function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}

export function issueSession(tgId, role = 'user') {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSec;
  const payload = `${tgId}.${role}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [tgId, role, exp, sig] = parts;
  const expected = sign(`${tgId}.${role}.${exp}`);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return { tgId: Number(tgId), role };
}

export function isAdmin(tgId) {
  return config.adminTgIds.includes(Number(tgId));
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
