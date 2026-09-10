import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

// tg_id — bigint. Отдаём его в JS как число, а не строку:
// id пользователей Telegram влезают в Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
});

export async function migrate() {
  const sql = await readFile(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await pool.query(sql);
}

export async function upsertUser(u, startParam) {
  const { rows } = await pool.query(
    `insert into users (tg_id, username, first_name, last_name, language_code, is_premium, start_param)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tg_id) do update set
       username      = excluded.username,
       first_name    = excluded.first_name,
       last_name     = excluded.last_name,
       language_code = excluded.language_code,
       is_premium    = excluded.is_premium,
       start_param   = coalesce(users.start_param, excluded.start_param),
       last_seen_at  = now()
     returning *`,
    [u.id, u.username || null, u.first_name || null, u.last_name || null,
     u.language_code || null, !!u.is_premium, startParam || null]
  );
  return rows[0];
}

export async function recordSubscription(tgId, channel, status, subscribed, source) {
  await pool.query(
    `update users set sub_status = $2, sub_checked_at = now() where tg_id = $1`,
    [tgId, status]
  );
  // Пишем в лог только смену состояния, чтобы не раздувать таблицу
  // на каждом открытии мини-аппа.
  const { rows } = await pool.query(
    `select subscribed from subscription_log
     where tg_id = $1 and channel = $2 order by created_at desc limit 1`,
    [tgId, channel]
  );
  if (rows.length && rows[0].subscribed === subscribed) return;
  await pool.query(
    `insert into subscription_log (tg_id, channel, status, subscribed, source)
     values ($1, $2, $3, $4, $5)`,
    [tgId, channel, status, subscribed, source]
  );
}

export async function createTicket({ tgId, source, topic, context, message }) {
  const { rows } = await pool.query(
    `insert into tickets (tg_id, source, topic, context, message)
     values ($1, $2, $3, $4, $5) returning *`,
    [tgId, source, topic || null, context || null, message]
  );
  return rows[0];
}

export async function attachAdminMessage(ticketId, chatId, msgId) {
  await pool.query(
    `update tickets set admin_chat_id = $2, admin_msg_id = $3 where id = $1`,
    [ticketId, chatId, msgId]
  );
}

export async function findTicketByAdminMessage(chatId, msgId) {
  const { rows } = await pool.query(
    `select * from tickets where admin_chat_id = $1 and admin_msg_id = $2 limit 1`,
    [chatId, msgId]
  );
  return rows[0] || null;
}

export async function answerTicket(ticketId, answer) {
  await pool.query(
    `update tickets set answer = $2, answered_at = now(), status = 'answered' where id = $1`,
    [ticketId, answer]
  );
}

export async function logEvent(tgId, type, payload = {}) {
  await pool.query(
    `insert into events (tg_id, type, payload) values ($1, $2, $3)`,
    [tgId, type, JSON.stringify(payload)]
  );
}

export async function stats() {
  const q = (sql) => pool.query(sql).then((r) => r.rows[0]);
  const [users, subs, tickets, today] = await Promise.all([
    q(`select count(*)::int as n from users`),
    q(`select count(*)::int as n from users where sub_status in ('creator','administrator','member')`),
    q(`select count(*) filter (where status = 'new')::int as new, count(*)::int as total from tickets`),
    q(`select count(distinct tg_id)::int as n from events where created_at > now() - interval '24 hours'`),
  ]);
  return { users: users.n, subscribed: subs.n, ticketsNew: tickets.new, ticketsTotal: tickets.total, dau: today.n };
}
