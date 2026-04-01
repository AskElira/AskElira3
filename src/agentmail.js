const { config } = require('./config');

const AGENTMAIL_API = 'https://api.agentmail.to/v0';
const FROM_INBOX = 'elira@agentmail.to';

/**
 * Send an email via AgentMail from elira@agentmail.to
 */
async function sendEmail({ to, subject, html, text }) {
  if (!config.agentmailKey) throw new Error('AGENTMAIL_API_KEY not configured');

  const res = await fetch(`${AGENTMAIL_API}/inboxes/${encodeURIComponent(FROM_INBOX)}/messages/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.agentmailKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, subject, html, text }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`AgentMail error ${res.status}: ${JSON.stringify(data)}`);
  console.log(`[AgentMail] Sent to ${to} — message_id: ${data.message_id}`);
  return data;
}

module.exports = { sendEmail, FROM_INBOX };
