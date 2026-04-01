const { config } = require('./config');

// When true, per-floor notifications are suppressed — only final summary sends
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
      // Fallback: retry without markdown
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
  await sendTelegram(`✅ *Floor Live* — ${floorName}\n_${goalText.substring(0, 60)}_`);
}

async function notifyFloorBlocked(goalText, floorName, reason) {
  if (silentMode) return;
  await sendTelegram(`⚠️ *Blocked* — ${floorName}\n${reason}`);
}

async function notifyGoalComplete(goalText) {
  await sendTelegram(`🎉 *Goal Complete*\n"${goalText.substring(0, 80)}"\n\nAll floors live.`);
}

async function notifyStevenAlert(floorName, issue) {
  await sendTelegram(`🔧 *Steven* — ${floorName}\n${issue.substring(0, 200)}`);
}

module.exports = { sendTelegram, notifyFloorLive, notifyFloorBlocked, notifyGoalComplete, notifyStevenAlert, setSilent };
