/**
 * AGI reasoning engine for Hermes.
 * Three capabilities:
 * 1. learnFromMessage — extract user signals from every message
 * 2. reflectAfterBuild — propose what to build next after a goal completes
 * 3. proactiveThink — periodic initiative loop
 */

const { chat } = require('../llm');
const { config } = require('../config');
const userModel = require('../user-model');

/**
 * Extract signals from a user message and update the user model.
 * Runs after every Telegram/chat message. Never throws.
 */
async function learnFromMessage(userText) {
  const model = userModel.get();
  const messages = [{
    role: 'user',
    content: `Extract learning signals from this user message for building a user model.

User message: "${userText}"

Current model:
${JSON.stringify(model, null, 2)}

Return JSON with ONLY new or updated fields. Only include fields where you found something new.
Possible fields: name, interests (array), techStack (array), workflowPatterns (array), goals (array), painPoints (array), timezone

If nothing new was learned, return: {}

Example: {"interests": ["crypto", "trading"], "techStack": ["Python"]}`
  }];

  try {
    const reply = await chat(messages, {
      model: config.agentModel,
      system: 'You are a user profiling assistant. Extract factual signals only. Return valid JSON.',
      maxTokens: 512,
    });
    const cleaned = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : '{}');
    if (Object.keys(obj).length > 0) {
      userModel.update(obj);
      console.log('[AGI] Learned:', JSON.stringify(obj));
    }
  } catch (_) {
    // Never crash — learning is best-effort
  }
}

/**
 * Validate that a suggestion is actionable and not garbage.
 */
function isValidSuggestion(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length < 15 || s.length > 300) return false;
  // Reject pronoun-only or vague suggestions
  if (/^(it|that|this|the thing|something|build it|do it|make it)$/i.test(s.trim())) return false;
  // Must have at least 4 words to be a meaningful description
  if (s.trim().split(/\s+/).length < 4) return false;
  return true;
}

/**
 * After a goal completes, reflect and propose what to build next.
 * Returns a suggestion string or null.
 */
async function reflectAfterBuild(completedGoalText) {
  const model = userModel.get();
  userModel.addCompletedBuild(completedGoalText);

  // Lazy-import getSoul to avoid circular dependency
  const { getSoul } = require('./index');

  const messages = [{
    role: 'user',
    content: `You just completed building: "${completedGoalText}"

User profile:
- Interests: ${model.interests.join(', ') || 'unknown'}
- Tech stack: ${model.techStack.join(', ') || 'unknown'}
- Past builds: ${model.completedBuilds.slice(0, 5).join(', ') || 'none'}
- Goals: ${model.goals.join(', ') || 'unknown'}
- Patterns: ${model.workflowPatterns.join(', ') || 'unknown'}

What is the single most valuable thing to build next for this user?
Think about: automations that save them time, dashboards they'd check daily, tools that extend what was just built.

Return ONE sentence describing the next build. Be specific and actionable.
Example: "Build a Telegram alert bot that notifies you when a GitHub repo in your interest list gets 100+ stars in a day."

Just the one sentence. No explanation.`
  }];

  try {
    const reply = await chat(messages, {
      model: config.eliraModel,
      system: getSoul() + '\n\nYou are in ELIRA MODE. Think about what this user truly needs next.',
      maxTokens: 200,
    });
    const suggestion = reply.trim().replace(/^["']|["']$/g, '');
    if (!isValidSuggestion(suggestion)) {
      console.warn('[AGI] Rejected bad suggestion:', suggestion);
      return null;
    }
    userModel.addSuggestion(suggestion);
    return suggestion;
  } catch (_) { return null; }
}

/**
 * Proactive initiative loop — runs periodically.
 * Hermes thinks about the user and what to propose.
 * Returns a message to send via Telegram (or null if nothing urgent).
 */
async function proactiveThink() {
  const model = userModel.get();
  if (!model.interests.length && !model.completedBuilds.length) return null;

  // Don't spam — only think if last seen was recent (within 24h)
  if (model.lastSeen) {
    const hoursSince = (Date.now() - new Date(model.lastSeen).getTime()) / 3600000;
    if (hoursSince > 24) return null;
  }

  const messages = [{
    role: 'user',
    content: `Review this user profile and decide if there's something valuable to proactively build or suggest right now.

Profile:
${JSON.stringify(model, null, 2)}

Current time: ${new Date().toLocaleString()}

Should Hermes proactively suggest something or start a build? Consider:
- Is there a repeating pattern that could be automated?
- Is there a tool that would clearly help given their interests?
- Is there something from their completed builds that needs a follow-up?

If yes: return JSON {"suggest": true, "message": "short Telegram message proposing the idea (under 200 chars)"}
If no: return JSON {"suggest": false}`
  }];

  try {
    const reply = await chat(messages, {
      model: config.agentModel,
      system: 'You are Hermes, an AGI. Act in the user\'s best interest proactively.',
      maxTokens: 300,
    });
    const cleaned = reply.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : '{}');
    if (obj.suggest && obj.message) return obj.message;
  } catch (_) {}
  return null;
}

module.exports = { learnFromMessage, reflectAfterBuild, proactiveThink };
