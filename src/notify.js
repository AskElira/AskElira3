const { config } = require('./config');
const settings = require('./settings');

// When true, per-floor notifications are suppressed during a build run
let silentMode = false;
function setSilent(val) { silentMode = val; }

async function sendTelegram(text) {
  if (!config.hasTelegram) return;
  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, parse_mode: 'Markdown' }),
    });
    if (!res.ok) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: config.telegramChatId, text: text.replace(/\*/g, '') }),
      });
    }
  } catch (err) {
    console.error('[Notify] Telegram failed:', err.message);
  }
}

async function notifyFloorLive(goalText, floorName) {
  if (silentMode) return;
  const s = settings.get();
  if (!s.notifications.floorLive) return;
  await sendTelegram(`✅ *Floor Live* — ${floorName}\n_${goalText.substring(0, 60)}_`);
}

async function notifyFloorBlocked(goalText, floorName, reason) {
  if (silentMode) return;
  const s = settings.get();
  if (!s.notifications.floorBlocked) return;
  await sendTelegram(`⚠️ *Blocked* — ${floorName}\n${reason}`);
}

async function notifyGoalComplete(goalText) {
  const s = settings.get();
  if (!s.notifications.buildComplete) return;
  await sendTelegram(`🎉 *Goal Complete*\n"${goalText.substring(0, 80)}"\n\nAll floors live.`);
}

async function notifyStevenAlert(floorName, issue) {
  const s = settings.get();
  if (!s.notifications.stevenAlerts) return;
  await sendTelegram(`🔧 *Steven* — ${floorName}\n${issue.substring(0, 200)}`);
}

/**
 * Upload a local video file to the user's Telegram chat via sendVideo.
 * @param {string} filePath — absolute path to an .mp4 file
 * @param {string} [caption]
 */
async function sendTelegramVideo(filePath, caption = '') {
  if (!config.hasTelegram) throw new Error('Telegram not configured');
  const fs = require('fs');
  if (!fs.existsSync(filePath)) throw new Error(`Video file not found: ${filePath}`);

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendVideo`;
  const form = new FormData();
  form.append('chat_id', config.telegramChatId);
  if (caption) form.append('caption', caption);
  // Stream the file as a Blob
  const buffer = fs.readFileSync(filePath);
  form.append('video', new Blob([buffer], { type: 'video/mp4' }), 'video.mp4');

  const res = await fetch(url, { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`sendVideo failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

module.exports = { sendTelegram, sendTelegramVideo, notifyFloorLive, notifyFloorBlocked, notifyGoalComplete, notifyStevenAlert, setSilent };

