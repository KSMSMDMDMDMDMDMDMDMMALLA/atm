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
  setTagEnabled,
  getPunishment,
  setPunishment,
  clearPunishment
} = require('./db');

// ====== НАСТРОЙКИ ======
const ADMIN_ID = 1007247805;
const COOLDOWN_MS = 20 * 1000;

const bot = new Telegraf(process.env.BOT_TOKEN);

const queue = new PQueue({ concurrency: 5, interval: 100, intervalCap: 5 });

// ====== НИЖНЯЯ КЛАВИАТУРА ======
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

// ====== УТИЛИТЫ ВРЕМЕНИ ======
function parseDuration(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === '0' || s === '-' || s === 'forever' || s === 'бес') return 0;

  const m = s.match(/^(\d+)\s*([smhd])$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return Date.now() + n * mult;
}

function formatUntil(ts) {
  if (ts === 0) return 'бессрочно';
  return new Date(ts).toLocaleString('ru-RU');
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

// ====== БАН / МУТ ======
function checkPunishment(ctx) {
  const p = getPunishment(ctx.from.id);
  if (!p) return true;

  if (p.type === 'ban') {
    ctx.reply(
      `Вы забанены до: ${formatUntil(p.until_ts)}` +
      (p.reason ? `\nПричина: ${p.reason}` : '')
    );
    return false;
  }
  if (p.type === 'mute') {
    ctx.reply(
      `Вы в муте до: ${formatUntil(p.until_ts)}` +
      (p.reason ? `\nПричина: ${p.reason}` : '')
    );
    return false;
  }
  return true;
}

function getTargetFromReply(ctx) {
  if (ctx.message.reply_to_message && ctx.message.reply_to_message.from) {
    return ctx.message.reply_to_message.from.id;
  }
  return null;
}

function parsePunishArgs(text) {
  const parts = text.trim().split(/\s+/);
  parts.shift(); // сама команда
  const time = parts.shift();
  const reason = parts.join(' ').trim();
  return { time, reason };
}

async function applyPunishment(ctx, type) {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('Команда доступна только администратору.');
  }

  const target = getTargetFromReply(ctx);
  if (!target) {
    return ctx.reply(
      'Ответьте этой командой на сообщение пользователя в боте. ' +
      'Например: ответьте на его сообщение и напишите /ban 10m спам'
    );
  }

  const { time, reason } = parsePunishArgs(ctx.message.text);
  const until = parseDuration(time);
  if (until === null) {
    return ctx.reply(
      'Неверный формат времени. Используйте: 30s, 10m, 2h, 1d, 7d или 0 (бессрочно).'
    );
  }

  setPunishment(target, type, until, reason);

  const label = type === 'ban' ? 'забанен' : 'замучен';
  ctx.reply(
    `Пользователь ${target} ${label}.\n` +
    `До: ${formatUntil(until)}\n` +
    (reason ? `Причина: ${reason}` : '')
  );
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

    // Забаненные не получают рассылку
    const p = getPunishment(userId);
    if (p && p.type === 'ban') continue;

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

// ====== BAN / MUTE / UNBAN ======
bot.command('ban', (ctx) => applyPunishment(ctx, 'ban'));
bot.command('mute', (ctx) => applyPunishment(ctx, 'mute'));

bot.command('unban', (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('Команда доступна только администратору.');
  }
  const target = getTargetFromReply(ctx);
  if (!target) {
    return ctx.reply('Ответьте на сообщение пользователя в боте.');
  }
  clearPunishment(target);
  ctx.reply(`С пользователя ${target} сняты все ограничения.`);
});

// ====== ОБРАБОТЧИКИ СООБЩЕНИЙ ======
bot.on('text', async (ctx) => {
  if (!hasParticipant(ctx.from.id)) {
    return ctx.reply('Сначала отправьте /start.', bottomKeyboard(ctx.from.id));
  }

  if (!checkPunishment(ctx)) return;
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

  if (!checkPunishment(ctx)) return;
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

  if (!checkPunishment(ctx)) return;
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

  if (!checkPunishment(ctx)) return;
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