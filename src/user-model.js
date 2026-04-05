/**
 * Persistent user knowledge base — now backed by SQLite via src/memory.js.
 * Hermes learns from every interaction and builds a profile over time.
 *
 * Maintains the same API as the old JSON-file version for backward compatibility.
 */

const { remember, recall } = require('./memory');

const PROFILE_KEY = 'user_profile';

const DEFAULT_MODEL = {
  name: null,
  interests: [],
  techStack: [],
  workflowPatterns: [],
  goals: [],
  painPoints: [],
  completedBuilds: [],
  suggestedNext: [],
  timezone: null,
  lastSeen: null,
  updatedAt: null,
};

function load() {
  const saved = recall(PROFILE_KEY);
  if (saved && typeof saved === 'object') {
    return { ...DEFAULT_MODEL, ...saved };
  }
  return { ...DEFAULT_MODEL };
}

function save(model) {
  model.updatedAt = new Date().toISOString();
  remember(PROFILE_KEY, model);
}

function get() { return load(); }

/**
 * Merge new signals into the model (deduplicates arrays).
 * @param {Object} signals - partial update, e.g. { interests: ["trading"], name: "Alvin" }
 * @returns {Object} updated model
 */
function update(signals) {
  const model = load();
  for (const [key, val] of Object.entries(signals)) {
    if (Array.isArray(model[key]) && Array.isArray(val)) {
      model[key] = [...new Set([...model[key], ...val])].slice(0, 30);
    } else if (val !== undefined && val !== null) {
      model[key] = val;
    }
  }
  save(model);
  return model;
}

function addCompletedBuild(goalText) {
  const model = load();
  model.completedBuilds = [goalText, ...model.completedBuilds].slice(0, 20);
  save(model);
}

function addSuggestion(idea) {
  const model = load();
  if (!model.suggestedNext.includes(idea)) {
    model.suggestedNext.unshift(idea);
    model.suggestedNext = model.suggestedNext.slice(0, 10);
  }
  save(model);
}

function clearSuggestion(idea) {
  const model = load();
  model.suggestedNext = model.suggestedNext.filter(s => s !== idea);
  save(model);
}

function touch() {
  const model = load();
  model.lastSeen = new Date().toISOString();
  save(model);
}

/**
 * Returns a compact user context string for injection into agent prompts.
 * Only includes non-empty fields so agents get signal, not noise.
 */
function formatContext() {
  const model = load();
  const parts = [];
  if (model.name) parts.push(`User: ${model.name}`);
  if (model.techStack && model.techStack.length) parts.push(`Tech stack: ${model.techStack.join(', ')}`);
  if (model.workflowPatterns && model.workflowPatterns.length) parts.push(`Workflow patterns: ${model.workflowPatterns.slice(0, 5).join(', ')}`);
  if (model.completedBuilds && model.completedBuilds.length) parts.push(`Recent builds: ${model.completedBuilds.slice(0, 3).join('; ')}`);
  if (model.painPoints && model.painPoints.length) parts.push(`Pain points: ${model.painPoints.slice(0, 3).join(', ')}`);
  return parts.length ? `## User Context\n${parts.join('\n')}` : '';
}

module.exports = { get, update, formatContext, addCompletedBuild, addSuggestion, clearSuggestion, touch };
