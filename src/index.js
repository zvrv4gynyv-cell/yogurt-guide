import express from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { loadGuide, getGuide } from './guide.js';
import { verifySession, callApi } from './telegram.js';
import { handleUpdate } from './bot.js';
import { api } from './routes/api.js';
import { admin } from './routes/admin.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));

app.get('/health', (req, res) => res.type('text').send('ok'));

/* ---------- вебхук Telegram ---------- */
app.post(`/tg/${config.webhookSecret}`, async (req, res) => {
  if (req.get('x-telegram-bot-api-secret-token') !== config.webhookSecret) {
    return res.sendStatus(403);
  }
  // Отвечаем сразу: Telegram не должен ждать нашу обработку.
  res.sendStatus(200);
  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error('update failed:', e.stack || e.message);
  }
});

app.use('/api', api);
app.use('/api/admin', admin);

/* ---------- гайд, только для подписчиков ---------- */
app.get('/guide', (req, res) => {
  const s = verifySession(req.query.t);
  if (!s) return res.redirect(302, '/');

  const { gz, etag } = getGuide();
  res.set({
    'content-type': 'text/html; charset=utf-8',
    'content-encoding': 'gzip',
    'cache-control': 'private, max-age=86400',
    'x-robots-tag': 'noindex',
    etag,
    vary: 'accept-encoding',
  });
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.send(gz);
});

/* ---------- статика: экран входа и админка ---------- */
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), {
  index: false,
  maxAge: '5m',
}));

const page = (name) => async (req, res) => {
  const html = await readFile(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), 'utf8');
  res.type('html').set('x-robots-tag', 'noindex').send(html);
};

app.get('/', page('gate.html'));
app.get('/admin', page('admin.html'));

app.use((req, res) => res.status(404).type('text').send('не найдено'));

app.use((err, req, res, _next) => {
  if (res.headersSent) return;
  // Кривое тело запроса — это не наша авария.
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: 'тело запроса не разобрать' });
  }
  console.error('server error:', err.stack || err.message);
  res.status(500).json({ error: 'что-то сломалось на сервере' });
});

/* ---------- запуск ---------- */
async function main() {
  await migrate();
  const size = await loadGuide();
  console.log(`гайд загружен: ${(size.raw / 1e6).toFixed(1)} МБ → ${(size.gzipped / 1e6).toFixed(1)} МБ gzip`);

  app.listen(config.port, () => console.log(`слушаю :${config.port}`));

  if (!config.publicUrl) {
    console.warn('PUBLIC_URL не задан — вебхук не поставлен');
    return;
  }
  await callApi('setWebhook', {
    url: `${config.publicUrl}/tg/${config.webhookSecret}`,
    secret_token: config.webhookSecret,
    allowed_updates: ['message', 'callback_query', 'chat_member'],
    drop_pending_updates: false,
  });
  console.log(`вебхук: ${config.publicUrl}/tg/***`);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} — закрываюсь`);
    pool.end().finally(() => process.exit(0));
  });
}

main().catch((e) => {
  console.error('не смог стартовать:', e.stack || e.message);
  process.exit(1);
});
