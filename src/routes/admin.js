import express from 'express';
import { pool, answerTicket } from '../db.js';
import { callApi } from '../telegram.js';
import { requireSession } from './api.js';

export const admin = express.Router();

admin.use(requireSession, (req, res, next) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'нет доступа' });
  next();
});

/* ---------- сводка ---------- */
admin.get('/overview', async (req, res) => {
  const one = (sql, params = []) => pool.query(sql, params).then((r) => r.rows[0]);

  const [totals, funnel, daily, topViews, topSearch] = await Promise.all([
    one(`select
           count(*)::int                                                          as users,
           count(*) filter (where sub_status in ('creator','administrator','member'))::int as subscribed,
           count(*) filter (where first_seen_at > now() - interval '7 days')::int  as new_week
         from users`),
    one(`select
           count(*) filter (where status = 'new')::int      as new,
           count(*) filter (where status = 'answered')::int as answered,
           count(*)::int                                    as total
         from tickets`),
    pool.query(
      `select date_trunc('day', created_at)::date as day,
              count(distinct tg_id)::int          as users,
              count(*) filter (where type = 'view')::int as views
       from events
       where created_at > now() - interval '14 days'
       group by 1 order by 1`
    ).then((r) => r.rows),
    pool.query(
      `select payload->>'title' as title, payload->>'id' as id, count(*)::int as n
       from events
       where type = 'view' and created_at > now() - interval '30 days'
         and coalesce(payload->>'title', '') <> ''
       group by 1, 2 order by n desc limit 15`
    ).then((r) => r.rows),
    pool.query(
      `select payload->>'q' as q, count(*)::int as n
       from events
       where type = 'search' and created_at > now() - interval '30 days'
       group by 1 order by n desc limit 15`
    ).then((r) => r.rows),
  ]);

  res.json({ totals, funnel, daily, topViews, topSearch });
});

/* ---------- обращения ---------- */
admin.get('/tickets', async (req, res) => {
  const status = ['new', 'answered'].includes(req.query.status) ? req.query.status : null;
  const { rows } = await pool.query(
    `select t.*, u.username, u.first_name, u.last_name
     from tickets t join users u on u.tg_id = t.tg_id
     ${status ? 'where t.status = $1' : ''}
     order by t.created_at desc limit 100`,
    status ? [status] : []
  );
  res.json({ tickets: rows });
});

admin.post('/tickets/:id/reply', async (req, res) => {
  const answer = String(req.body?.answer ?? '').trim();
  if (answer.length < 2) return res.status(400).json({ error: 'пустой ответ' });

  const { rows } = await pool.query('select * from tickets where id = $1', [req.params.id]);
  const ticket = rows[0];
  if (!ticket) return res.status(404).json({ error: 'обращение не найдено' });

  try {
    await callApi('sendMessage', {
      chat_id: ticket.tg_id,
      text: `Ответ на твой вопрос:\n\n${answer}`,
    });
  } catch (e) {
    return res.status(502).json({ error: e.description || e.message });
  }

  await answerTicket(ticket.id, answer);
  res.json({ ok: true });
});

/* ---------- пользователи ---------- */
admin.get('/users', async (req, res) => {
  const { rows } = await pool.query(
    `select u.*,
            (select count(*)::int from tickets t where t.tg_id = u.tg_id) as tickets,
            (select max(created_at) from events e where e.tg_id = u.tg_id) as last_event
     from users u order by u.last_seen_at desc limit 200`
  );
  res.json({ users: rows });
});
