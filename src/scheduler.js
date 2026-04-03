/**
 * Daily digest scheduler — runs the agentmail automation at 8am every morning.
 * Executes the Python pipeline from the workspace, then sends via AgentMail.
 *
 * Now timezone-aware: reads TZ env var (default UTC).
 * Stores lastDigestDate in SQLite via src/memory.js to prevent double-fire across restarts.
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { sendEmail } = require('./agentmail');
const { config } = require('./config');
const { sendTelegram } = require('./notify');
const { listGoals } = require('./db');
const workspace = require('./pipeline/workspace');
const { remember, recall } = require('./memory');

const DIGEST_RECIPIENT = process.env.DIGEST_EMAIL || '';
const TARGET_HOUR = 8;
const USER_TZ = process.env.TZ || 'UTC';

let schedulerTimer = null;

function startScheduler() {
  if (!config.agentmailKey) {
    console.log('[Scheduler] AGENTMAIL_API_KEY not set — daily digest disabled');
    return;
  }
  console.log(`[Scheduler] Daily digest scheduled at ${TARGET_HOUR}:00 ${USER_TZ} -> ${DIGEST_RECIPIENT}`);
  // Check every minute
  schedulerTimer = setInterval(checkAndRun, 60 * 1000);
  checkAndRun(); // check on startup in case we missed it
}

function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
}

function checkAndRun() {
  // Get current time in user's timezone
  const now = new Date();
  let localHour, localDateStr;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: USER_TZ,
      hour: 'numeric',
      hour12: false,
    });
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: USER_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    localHour = parseInt(formatter.format(now), 10);
    localDateStr = dateFormatter.format(now); // "MM/DD/YYYY"
  } catch (err) {
    // Fallback to system time if timezone is invalid
    console.error(`[Scheduler] Invalid timezone "${USER_TZ}", falling back to system time:`, err.message);
    localHour = now.getHours();
    localDateStr = now.toDateString();
  }

  // Check if already fired today (persisted in SQLite)
  const lastDigestDate = recall('lastDigestDate');

  // Run at 8am local time, once per day
  if (localHour === TARGET_HOUR && lastDigestDate !== localDateStr) {
    remember('lastDigestDate', localDateStr);
    console.log(`[Scheduler] ${TARGET_HOUR}:00 ${USER_TZ} — running daily digest`);
    runDigest().catch(err => console.error('[Scheduler] Digest failed:', err.message));
  }
}

async function runDigest() {
  await sendTelegram('*Daily Digest* — Starting 8am run...');

  // Find the agentmail automation workspace (most recent goal with these files)
  const goals = listGoals();
  let workspaceId = null;
  for (const g of goals) {
    const files = workspace.listFiles(g.id);
    if (files.some(f => f.includes('github_trending') || f.includes('hn_fetcher'))) {
      workspaceId = g.id;
      break;
    }
  }

  let html = null;
  let text = null;

  if (workspaceId) {
    const wsPath = workspace.getWorkspacePath(workspaceId);
    html = await runPythonPipeline(wsPath);
  }

  // Fallback: build digest from live LLM call if Python pipeline fails
  if (!html) {
    console.log('[Scheduler] Python pipeline unavailable — using LLM digest fallback');
    const { hermesChat } = require('./hermes/index');
    const reply = await hermesChat([{
      role: 'user',
      content: `Generate a daily tech digest email for ${new Date().toDateString()}. Include:
1. A high-level summary of what's trending in tech today
2. 5 notable GitHub repo categories likely trending today
3. 3 interesting Hacker News discussion topics likely today
Format as clean HTML email with a header, sections, and readable layout. Keep it concise.`
    }]);
    html = reply;
    text = reply.replace(/<[^>]+>/g, '').trim();
  }

  const subject = `Daily Tech Digest — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}`;

  await sendEmail({
    to: DIGEST_RECIPIENT,
    subject,
    html: html || text,
    text: text || (html || '').replace(/<[^>]+>/g, '').trim(),
  });

  await sendTelegram(`*Daily Digest Sent* \u2713\nTo: ${DIGEST_RECIPIENT}\nSubject: ${subject}`);
  console.log(`[Scheduler] Digest sent to ${DIGEST_RECIPIENT}`);
}

async function runPythonPipeline(wsPath) {
  return new Promise((resolve) => {
    // Check if aggregator + email builder exist
    const aggregator = path.join(wsPath, 'aggregator.py');

    if (!fs.existsSync(aggregator)) return resolve(null);

    // Install requirements if needed
    const reqs = path.join(wsPath, 'requirements.txt');
    if (fs.existsSync(reqs)) {
      try { execSync(`pip3 install -q -r "${reqs}"`, { timeout: 30000 }); } catch (e) { /* ignore */ }
    }

    const script = `
import sys, json
sys.path.insert(0, '${wsPath}')
try:
    from aggregator import aggregate
    data = aggregate()
    print(json.dumps({'ok': True, 'data': data}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
`;
    exec(`python3 -c "${script.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { timeout: 60000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const result = JSON.parse(stdout.trim());
        if (!result.ok) { console.error('[Scheduler] Python error:', result.error); return resolve(null); }
        // Build HTML from data
        const html = buildDigestHtml(result.data);
        resolve(html);
      } catch (e) { resolve(null); }
    });
  });
}

function buildDigestHtml(data) {
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const repos = (data.github_repos || data.repos || []).slice(0, 10);
  const articles = (data.hn_articles || data.articles || []).slice(0, 10);
  const summary = data.summary || data.ai_summary || '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 0 auto; color: #222221; }
  .header { background: linear-gradient(135deg, #111110, #ffc53d22); padding: 32px; border-bottom: 2px solid #ffc53d; }
  .header h1 { margin: 0; font-size: 22px; color: #ffc53d; }
  .header p { margin: 4px 0 0; color: #666; font-size: 13px; }
  .section { padding: 24px 32px; border-bottom: 1px solid #eee; }
  .section h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin: 0 0 16px; }
  .summary { background: #fffbf0; border-left: 3px solid #ffc53d; padding: 16px; border-radius: 0 8px 8px 0; line-height: 1.6; }
  .repo { padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
  .repo:last-child { border: none; }
  .repo-name { font-weight: 600; color: #222221; text-decoration: none; }
  .repo-meta { font-size: 12px; color: #888; margin-top: 2px; }
  .article { padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
  .article:last-child { border: none; }
  .article a { color: #222221; text-decoration: none; font-weight: 500; }
  .article-meta { font-size: 12px; color: #888; margin-top: 2px; }
  .footer { padding: 24px 32px; font-size: 12px; color: #999; text-align: center; }
</style></head>
<body>
<div class="header">
  <h1>Daily Tech Digest</h1>
  <p>${date} \u00B7 Powered by Elira @ AskElira 3</p>
</div>
${summary ? `<div class="section"><h2>AI Summary</h2><div class="summary">${summary}</div></div>` : ''}
${repos.length ? `<div class="section"><h2>GitHub Trending Today</h2>${repos.map(r => `
  <div class="repo">
    <div><a class="repo-name" href="https://github.com/${r.author || ''}/${r.name || r.repo_name || ''}">${r.author ? r.author + '/' : ''}${r.name || r.repo_name || ''}</a></div>
    <div class="repo-meta">${r.description || ''} \u00B7 \u2B50 ${r.stars || r.stars_today || 0} \u00B7 ${r.language || ''}</div>
  </div>`).join('')}</div>` : ''}
${articles.length ? `<div class="section"><h2>Hacker News</h2>${articles.map(a => `
  <div class="article">
    <div><a href="${a.url || '#'}">${a.title || ''}</a></div>
    <div class="article-meta">\u25B2 ${a.score || a.points || 0} points \u00B7 ${a.comments || 0} comments</div>
  </div>`).join('')}</div>` : ''}
<div class="footer">Sent by Elira via AskElira 3 \u00B7 elira@agentmail.to</div>
</body></html>`;
}

// Manual trigger for testing
async function triggerNow() {
  console.log('[Scheduler] Manual trigger');
  await runDigest();
}

module.exports = { startScheduler, stopScheduler, triggerNow };
