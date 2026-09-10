import { config } from './config.js';
import {
  callApi, checkSubscription, escapeHtml, isAdmin,
} from './telegram.js';
import {
  upsertUser, recordSubscription, createTicket, attachAdminMessage,
  findTicketByAdminMessage, answerTicket, logEvent, stats, pool,
} from './db.js';

const GUIDE_BUTTON = () => ({
  inline_keyboard: [
    [{ text: '🥣 Открыть гайд', web_app: { url: config.publicUrl } }],
    [{ text: 'А чё так вкусно?', url: config.channelUrl }],
  ],
});

const SUBSCRIBE_BUTTON = () => ({
  inline_keyboard: [
    [{ text: 'Подписаться на канал', url: config.channelUrl }],
    [{ text: 'Я подписался', callback_data: 'recheck' }],
  ],
});

const isAdminChat = (chatId) =>
  config.adminChatId && String(chatId) === String(config.adminChatId);

async function handleStart(msg, startParam) {
  const user = await upsertUser(msg.from, startParam);
  await logEvent(user.tg_id, 'bot_start', { start_param: startParam || null });

  const { status, subscribed } = await checkSubscription(msg.from.id);
  await recordSubscription(msg.from.id, config.channel, status, subscribed, 'bot');

  if (!subscribed) {
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Привет! Гайд «Греческий йогурт — 50 рецептов» лежит внутри канала.\n\n'
          + 'Подпишись на «А чё так вкусно?» — и открывай, он бесплатный.',
      reply_markup: SUBSCRIBE_BUTTON(),
    });
    return;
  }

  await callApi('sendMessage', {
    chat_id: msg.chat.id,
    text: 'Держи гайд: 50 рецептов с греческим йогуртом, база по выбору банки '
        + 'и что делать, чтобы соус не свернулся.\n\n'
        + 'Если что-то не получилось или хочешь рецепт под свой запрос — просто напиши сюда, отвечу.',
    reply_markup: GUIDE_BUTTON(),
  });
}

async function handleUserMessage(msg) {
  const text = msg.text || msg.caption;
  if (!text) {
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Пока понимаю только текст. Напиши словами, что нужно.',
    });
    return;
  }

  await upsertUser(msg.from, null);
  const ticket = await createTicket({
    tgId: msg.from.id, source: 'bot', topic: null, context: null, message: text,
  });

  await callApi('sendMessage', {
    chat_id: msg.chat.id,
    text: 'Записал, передал. Ответим здесь же.',
  });

  await forwardToAdmin(ticket);
}

async function forwardToAdmin(ticket) {
  if (!config.adminChatId) {
    console.warn('ADMIN_CHAT_ID не задан — обращение #%s только в базе', ticket.id);
    return;
  }
  const { rows } = await pool.query('select * from users where tg_id = $1', [ticket.tg_id]);
  const from = rows[0] || { tg_id: ticket.tg_id };
  const who = from.username ? `@${from.username}` : `${from.first_name || ''} ${from.last_name || ''}`.trim();
  const head = ticket.source === 'miniapp' ? 'из мини-аппа' : 'из бота';
  const lines = [
    `<b>Обращение #${ticket.id}</b> (${head})`,
    `От: ${escapeHtml(who || 'без имени')} · <code>${from.tg_id}</code>`,
  ];
  if (ticket.topic) lines.push(`Тема: ${escapeHtml(ticket.topic)}`);
  if (ticket.context) lines.push(`Экран: ${escapeHtml(ticket.context)}`);
  lines.push('', escapeHtml(ticket.message), '', '<i>Ответь реплаем на это сообщение — уйдёт человеку.</i>');

  const sent = await callApi('sendMessage', {
    chat_id: config.adminChatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
  });
  await attachAdminMessage(ticket.id, sent.chat.id, sent.message_id);
}

async function handleAdminReply(msg) {
  const ticket = await findTicketByAdminMessage(msg.chat.id, msg.reply_to_message.message_id);
  if (!ticket) {
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Не нашёл обращение для этого сообщения. Ответь реплаем именно на карточку обращения.',
      reply_to_message_id: msg.message_id,
    });
    return;
  }
  const text = msg.text || msg.caption;
  if (!text) return;

  try {
    await callApi('sendMessage', {
      chat_id: ticket.tg_id,
      text: `Ответ на твой вопрос:\n\n${text}`,
    });
    await answerTicket(ticket.id, text);
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: `Отправил по #${ticket.id}.`,
      reply_to_message_id: msg.message_id,
    });
  } catch (e) {
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: `Не доставил по #${ticket.id}: ${e.description || e.message}`,
      reply_to_message_id: msg.message_id,
    });
  }
}

async function handleMessage(msg) {
  const text = msg.text || '';

  if (text.startsWith('/id')) {
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: `chat_id этого чата: <code>${msg.chat.id}</code>`,
      parse_mode: 'HTML',
    });
    return;
  }

  if (text.startsWith('/admin')) {
    if (!isAdmin(msg.from.id)) return;
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: 'Админка: пользователи, обращения, что открывают.',
      reply_markup: { inline_keyboard: [[
        { text: '📊 Открыть админку', web_app: { url: `${config.publicUrl}/admin` } },
      ]] },
    });
    return;
  }

  if (text.startsWith('/stats')) {
    if (!isAdminChat(msg.chat.id)) return;
    const s = await stats();
    await callApi('sendMessage', {
      chat_id: msg.chat.id,
      text: [
        `Пользователей: ${s.users}`,
        `Из них подписаны: ${s.subscribed}`,
        `Активны за сутки: ${s.dau}`,
        `Обращений: ${s.ticketsTotal} (новых ${s.ticketsNew})`,
      ].join('\n'),
    });
    return;
  }

  // Ответ админа реплаем на карточку обращения
  if (isAdminChat(msg.chat.id) && msg.reply_to_message) {
    await handleAdminReply(msg);
    return;
  }

  // В админ-чате обычные сообщения игнорируем
  if (isAdminChat(msg.chat.id)) return;
  if (msg.chat.type !== 'private') return;

  if (text.startsWith('/start')) {
    await handleStart(msg, text.split(' ')[1] || null);
    return;
  }

  await handleUserMessage(msg);
}

async function handleCallback(cq) {
  if (cq.data !== 'recheck') return;

  const { status, subscribed } = await checkSubscription(cq.from.id);
  await upsertUser(cq.from, null);
  await recordSubscription(cq.from.id, config.channel, status, subscribed, 'bot');

  await callApi('answerCallbackQuery', {
    callback_query_id: cq.id,
    text: subscribed ? 'Всё, доступ открыт' : 'Пока не вижу подписку',
    show_alert: !subscribed,
  });

  if (subscribed) {
    await callApi('editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: 'Спасибо за подписку. Гайд открыт — заходи.',
      reply_markup: GUIDE_BUTTON(),
    });
  }
}

// Пользователь вступил в канал или вышел из него
async function handleChatMember(upd) {
  const chat = upd.chat;
  const expected = config.channel.replace(/^@/, '').toLowerCase();
  if ((chat.username || '').toLowerCase() !== expected) return;

  const status = upd.new_chat_member.status;
  const subscribed = ['creator', 'administrator', 'member'].includes(status)
    || (status === 'restricted' && upd.new_chat_member.is_member === true);

  const { rowCount } = await pool.query('select 1 from users where tg_id = $1', [upd.from.id]);
  if (!rowCount) return; // человек нам ещё не знаком — заведём его при первом контакте

  await recordSubscription(upd.from.id, config.channel, status, subscribed, 'chat_member');
}

export async function handleUpdate(update) {
  if (update.message) return handleMessage(update.message);
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.chat_member) return handleChatMember(update.chat_member);
}

export { forwardToAdmin };
