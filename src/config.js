function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  botToken: required('BOT_TOKEN'),
  // Канал, подписку на который проверяем. Формат: @chotakvkusno
  channel: process.env.CHANNEL || '@chotakvkusno',
  channelUrl: process.env.CHANNEL_URL || 'https://t.me/chotakvkusno',
  // Чат, куда бот пересылает обращения. Узнать можно командой /id в боте.
  adminChatId: process.env.ADMIN_CHAT_ID || null,
  // Кому открыта админка. Список tg_id через запятую, узнать через /id в личке бота.
  adminTgIds: (process.env.ADMIN_TG_IDS || '')
    .split(',').map((s) => Number(s.trim())).filter(Boolean),
  sessionSecret: required('SESSION_SECRET'),
  webhookSecret: required('WEBHOOK_SECRET'),
  databaseUrl: required('DATABASE_URL'),
  // Публичный адрес сервиса. На Railway подставляется автоматически.
  publicUrl: (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, ''),
  // Сколько живёт сессия мини-аппа
  sessionTtlSec: 24 * 60 * 60,
  // initData считается протухшей через сутки
  initDataMaxAgeSec: 24 * 60 * 60,
};
