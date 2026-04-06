const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  llmApiKey: process.env.LLM_API_KEY || '',
  llmBaseUrl: (process.env.LLM_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''),
  eliraModel: process.env.ELIRA_MODEL || 'claude-sonnet-4-6',
  agentModel: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  tavilyApiKey: process.env.TAVILY_API_KEY || '',
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || '',
  agentmailKey: process.env.AGENTMAIL_API_KEY || '',
  digestEmail: process.env.DIGEST_EMAIL || '',
  port: parseInt(process.env.PORT || '3000', 10),
  dbPath: path.resolve(__dirname, '..', 'data', 'askelira3.db'),
  apiToken: process.env.API_TOKEN || '',
  lightpandaUrl: process.env.LIGHTPANDA_URL || '',
  fallbackLlmKey: process.env.FALLBACK_LLM_KEY || process.env.ANTHROPIC_API_KEY || '',
  fallbackLlmUrl: (process.env.FALLBACK_LLM_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''),
  fallbackModel: process.env.FALLBACK_MODEL || 'claude-haiku-4-5-20251001',
};

config.isAnthropic = !config.llmBaseUrl || config.llmBaseUrl.includes('anthropic');
config.isOpenAI = config.llmBaseUrl.includes('openrouter') || config.llmBaseUrl.includes('openai');
config.hasTelegram = !!(config.telegramBotToken && config.telegramChatId);
config.hasTavily = !!config.tavilyApiKey;
config.hasBrave = !!config.braveSearchApiKey;
config.hasLlm = !!config.llmApiKey;
config.hasAgentmail = !!config.agentmailKey;
config.hasApiToken = !!config.apiToken;
config.hasLightpanda = !!config.lightpandaUrl;
config.hasFallbackLlm = !!config.fallbackLlmKey;

function validate() {
  const issues = [];
  if (!config.llmApiKey) issues.push('LLM_API_KEY is required');
  if (issues.length) {
    console.error('[Config] Validation errors:');
    issues.forEach(i => console.error(`  - ${i}`));
    return false;
  }
  return true;
}

module.exports = { config, validate };
