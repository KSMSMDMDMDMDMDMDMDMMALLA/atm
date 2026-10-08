require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const PQueue = require('p-queue').default;

const {
  addParticipant,
  setParticipantActive,
  hasParticipant,
  listParticipants,
  countParticipants,
  getSetting,
  setSetting,
  getLastMessageTime,
  setLastMessageTime,
  isTagEnabled,
  setTagEnabled
} = require('./db');

// ====== НАСТРОЙКИ ======
const ADMIN_ID = 1007247805;
const COOLDOWN_MS = 20 * 1000;

const bot = new Telegraf(process.env.BOT_TOKEN);

const queue = new PQueue({ concurrency: 5, interval: 100, intervalCap: 5 });

// ====== НИЖНЯЯ КЛАВИАТУРА ======
// Текст на кнопках — человеческий. Эмодзи дают визуальный цвет.
// Telegram НЕ поддерживает цвет фона у reply-кнопок.
function bottomKeyboard(userId) {
  const tagOn = isTagEnabled(userId);
  const active = hasParticipant(userId);

  const tagLabel = tagOn ? '🔴 Скрыть ТЭГ' : '🟢 Показать ТЭГ';
  const activeLabel = active ? '🔴 Выключить бота' : '🟢 Включить бота';

  return Markup.keyboard([[tagLabel, activeLabel]]).resize();
}

const TAG_LABELS = ['🟢 Показать ТЭГ', '🔴 Скрыть ТЭГ', 'Показать ТЭГ', 'Скрыть ТЭГ'];
const ACTIVE_LABELS = ['🔴 Выключить бота', '🟢 Включить бота', 'Выключить бота', 'Включить бота'];

// ====== /view ======
function isRevealOn() {
  return getSetting('reveal_to_admins', '0') === '1';
}
function setRevealOn(on) {
  setSetting('reveal_to_admins', on ? '1' : '0');
}

// ====== АНТИСПАМ ======
function checkCooldown(ctx) {
  if (ctx.from.id === ADMIN_ID) return true;

  const now = Date.now();
  const last = getLastMessageTime(ctx.from.id);
  const diff = now - last;

  if (diff < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - diff) / 1000);
    ctx.reply(`Слишком часто. Подождите ещё ${wait} сек.`);
    return false;
  }

  setLastMessageTime(ctx.from.id, now);
  return true;
}

// ====== ЭХО С ТЕГОМ ======
function selfExtra(ctx) {
  if (isTagEnabled(ctx.from.id) && ctx.from.username) {
    return {
      reply_markup: {
        inline_keyboard: [[{
          text: `@${ctx.from.username}`,
          url: `https://t.me/${ctx.from.username}`
        }]]
      }
    };
  }
  return {};
}

// ====== РАССЫЛКА ======
async function broadcastMessage(senderId, messageType, payload, senderInfo) {
  const startTime = Date.now();
  const tasks = [];

  for (const userId of listParticipants()) {
    if (userId === senderId) continue;

    tasks.push(async () => {
      try {
        const isAdmin = userId === ADMIN_ID;
        const adminViewOn = isAdmin && isRevealOn();
        const senderTagOn = isTagEnabled(senderId) && !!senderInfo.username;

        const extra = { ...(payload.extra || {}) };

        if ((adminViewOn || senderTagOn) && senderInfo.username) {
          const url = `https://t.me/${senderInfo.username}`;
          const name = `@${senderInfo.username}`;
          extra.reply_markup = {
            inline_keyboard: [[{ text: name, url }]]
          };
        }

        switch (messageType) {
          case 'text':
            await bot.telegram.sendMessage(userId, payload.text, extra);
            break;
          case 'photo':
            await bot.telegram.sendPhoto(userId, payload.fileId, extra);
            break;
          case 'voice':
            await bot.telegram.sendVoice(userId, payload.fileId, extra);
            break;
          case 'video':
            await bot.telegram.sendVideo(userId, payload.fileId, extra);
            break;
        }
      } catch (err) {
        console.error(`Ошибка отправки пользователю ${userId}:`, err.message);
      }
    });
  }

  await queue.addAll(tasks);
  return Date.now() - startTime;
}

// ====== ЛОГИКА КОМАНД ======
function doStart(ctx) {
  addParticipant(ctx.from);
  ctx.reply(
    'Вы в списке участников. Отправляйте сообщения — они анонимно уйдут всем.',
    bottomKeyboard(ctx.from.id)
  );
}

function doStop(ctx) {
  setParticipantActive(ctx.from.id, false);
  ctx.reply(
    'Вы больше не будете получать сообщения. Нажмите «🟢 Включить бота», чтобы вернуть.',
    bottomKeyboard(ctx.from.id)
  );
}

function doTag(ctx) {
  const next = !isTagEnabled(ctx.from.id);
  if (next && !ctx.from.username) {
    return ctx.reply('У вас нет username в Telegram.', bottomKeyboard(ctx.from.id));
  }
  setTagEnabled(ctx.from.id, next);
  ctx.reply(
    `Показ вашего тега под сообщениями: ${next ? 'ВКЛ' : 'ВЫКЛ'}`,
    bottomKeyboard(ctx.from.id)
  );
}

// ====== КОМАНДЫ ======
bot.start(doStart);

bot.command('stop', doStop);
bot.command('tag', doTag);

// Ловим нажатия на нижние кнопки (это обычный текст сообщения)
bot.hears(TAG_LABELS, doTag);
bot.hears(ACTIVE_LABELS, (ctx) => {
  if (hasParticipant(ctx.from.id)) {
    doStop(ctx);
  } else {
    doStart(ctx);
  }
});

bot.command('menu', (ctx) => {
  ctx.reply('Меню:', bottomKeyboard(ctx.from.id));
});

bot.command('list', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('Команда доступна только администратору.');
  }
  ctx.reply(`Всего участников: ${countParticipants()}`);
});

bot.command('view', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('Команда доступна только администратору.');
  }
  const next = !isRevealOn();
  setRevealOn(next);
  ctx.reply(`Отображение отправителей для админа: ${next ? 'ВКЛ' : 'ВЫКЛ'}`);
});

// ====== ОБРАБОТЧИКИ СООБЩЕНИЙ ======
// ВАЖНО: bot.hears(TAG_LABELS) и bot.hears(ACTIVE_LABELS) зарегистрированы раньше,
// поэтому текст "🟢 Показать ТЭГ" и т.п. не попадёт в bot.on('text').
bot.on('text', async (ctx) => {
  if (!hasParticipant(ctx.from.id)) {
    return ctx.reply('Сначала отправьте /start.', bottomKeyboard(ctx.from.id));
  }

  if (!checkCooldown(ctx)) return;

  await ctx.reply(ctx.message.text, selfExtra(ctx));

  const elapsed = await broadcastMessage(
    ctx.from.id,
    'text',
    { text: ctx.message.text, extra: {} },
    { username: ctx.from.username, firstName: ctx.from.first_name }
  );

  ctx.reply(`Ваше сообщение отправлено за ${elapsed} мс.`);
});

bot.on('photo', async (ctx) => {
  if (!hasParticipant(ctx.from.id)) {
    return ctx.reply('Сначала отправьте /start.', bottomKeyboard(ctx.from.id));
  }

  if (!checkCooldown(ctx)) return;

  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const caption = ctx.message.caption || undefined;

  await ctx.replyWithPhoto(photo.file_id, { caption, ...selfExtra(ctx) });

  const elapsed = await broadcastMessage(
    ctx.from.id,
    'photo',
    { fileId: photo.file_id, extra: { caption } },
    { username: ctx.from.username, firstName: ctx.from.first_name }
  );

  ctx.reply(`Фото отправлено за ${elapsed} мс.`);
});

bot.on('voice', async (ctx) => {
  if (!hasParticipant(ctx.from.id)) {
    return ctx.reply('Сначала отправьте /start.', bottomKeyboard(ctx.from.id));
  }

  if (!checkCooldown(ctx)) return;

  await ctx.replyWithVoice(ctx.message.voice.file_id, selfExtra(ctx));

  const elapsed = await broadcastMessage(
    ctx.from.id,
    'voice',
    { fileId: ctx.message.voice.file_id, extra: {} },
    { username: ctx.from.username, firstName: ctx.from.first_name }
  );

  ctx.reply(`Голосовое сообщение отправлено за ${elapsed} мс.`);
});

bot.on('video', async (ctx) => {
  if (!hasParticipant(ctx.from.id)) {
    return ctx.reply('Сначала отправьте /start.', bottomKeyboard(ctx.from.id));
  }

  if (!checkCooldown(ctx)) return;

  const caption = ctx.message.caption || undefined;

  await ctx.replyWithVideo(ctx.message.video.file_id, { caption, ...selfExtra(ctx) });

  const elapsed = await broadcastMessage(
    ctx.from.id,
    'video',
    { fileId: ctx.message.video.file_id, extra: { caption } },
    { username: ctx.from.username, firstName: ctx.from.first_name }
  );

  ctx.reply(`Видео отправлено за ${elapsed} мс.`);
});

bot.on('document', (ctx) => {
  ctx.reply('Отправка файлов не поддерживается.', bottomKeyboard(ctx.from.id));
});

// ====== ЗАПУСК ======
bot.launch().then(() => {
  console.log('Бот запущен');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));