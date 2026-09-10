import express from 'express';
import { config } from '../config.js';
import {
  verifyInitData, checkSubscription, issueSession, verifySession, isAdmin,
} from '../telegram.js';
import {
  upsertUser, recordSubscription, createTicket, logEvent,
} from '../db.js';
import { forwardToAdmin } from '../bot.js';

export const api = express.Router();

/* ---------- простой лимитер на память ---------- */
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.session?.tgId ?? req.ip}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now > rec.reset) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return next();
    }
    if (++rec.n > max) return res.status(429).json({ error: 'слишком часто' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60_000).unref();

/* ---------- сессия ---------- */
export function requireSession(req, res, next) {
  const raw = (req.get('authorization') || '').replace(/^Bearer /i, '');
  const s = verifySession(raw);
  if (!s) return res.status(401).json({ error: 'нужна авторизация' });
  req.session = s;
  next();
}

/**
 * Вход в мини-апп: проверяем подпись Telegram, затем подписку на канал.
 * Гайд не отдаём никому, кто не подписан.
 */
api.post('/auth', rateLimit(30, 60_000), async (req, res) => {
  const data = verifyInitData(req.body?.initData);
  if (!data) return res.status(401).json({ error: 'не удалось подтвердить, что запрос из Telegram' });

  const user = await upsertUser(data.user, data.startParam);

  let sub;
  try {
    sub = await checkSubscription(data.user.id);
  } catch (e) {
    console.error('checkSubscription:', e.message);
    return res.status(503).json({ error: 'Telegram не ответил, попробуй ещё раз' });
  }

  await recordSubscription(data.user.id, config.channel, sub.status, sub.subscribed, 'miniapp');

  const admin = isAdmin(data.user.id);

  // Админов гейт не касается — иначе не попасть в админку.
  if (!sub.subscribed && !admin) {
    await logEvent(user.tg_id, 'gate_block', { status: sub.status });
    return res.json({ subscribed: false, channelUrl: config.channelUrl });
  }

  res.json({
    subscribed: true,
    admin,
    token: issueSession(data.user.id, admin ? 'admin' : 'user'),
  });
});

/* ---------- обращения из мини-аппа ---------- */
const TOPICS = new Set(['recipe', 'bug', 'idea', 'other']);

api.post('/tickets', requireSession, rateLimit(5, 10 * 60_000), async (req, res) => {
  const message = String(req.body?.message ?? '').trim();
  if (message.length < 5) return res.status(400).json({ error: 'слишком короткое сообщение' });
  if (message.length > 2000) return res.status(400).json({ error: 'слишком длинное сообщение' });

  const topic = TOPICS.has(req.body?.topic) ? req.body.topic : 'other';
  const context = String(req.body?.context ?? '').slice(0, 120) || null;

  const ticket = await createTicket({
    tgId: req.session.tgId, source: 'miniapp', topic, context, message,
  });

  try {
    await forwardToAdmin(ticket);
  } catch (e) {
    console.error('forwardToAdmin:', e.message); // в базе обращение уже есть
  }

  res.json({ ok: true, id: ticket.id });
});

/* ---------- аналитика ---------- */
const EVENT_TYPES = new Set(['open_app', 'view', 'search']);

api.post('/events', requireSession, rateLimit(60, 60_000), async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
  await Promise.all(
    events
      .filter((e) => EVENT_TYPES.has(e?.type))
      .map((e) => logEvent(req.session.tgId, e.type, e.payload ?? {}).catch(() => {}))
  );
  res.json({ ok: true });
});
