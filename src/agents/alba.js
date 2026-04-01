const { chat } = require('../llm');
const { config } = require('../config');
const { addLog } = require('../db');

const ALBA_SYSTEM = `You are Alba, the research agent for AskElira 3.

Your job is to gather relevant information, patterns, and context needed to complete a task.
You produce structured research notes that David (the builder agent) will use to write real code.

Your output format:
## Research Notes
### Key Findings
- (bullet points of relevant facts, patterns, best practices)
### Recommended Approach
- (concrete steps or strategy)
### File Structure
- (what files need to be created and what each should contain)
### Resources & References
- (URLs, docs, examples if relevant)
### Risks & Considerations
- (potential issues to watch for)

Be thorough but concise. Focus on actionable intelligence that David can use to build.
When building software, include specific code patterns, library recommendations, and architecture decisions.`;

/**
 * Research a floor's task. Uses Tavily/Brave if available, otherwise LLM-only.
 * @param {Object} floor - floor record with name, description, success_condition, deliverable
 * @param {Object} goal - goal record with id, text
 * @param {string[]} [vexFeedback] - issues from Vex Gate 1 (for re-research)
 * @returns {Promise<string>}
 */
async function research(floor, goal, vexFeedback) {
  const floorName = floor.name;
  const floorDescription = floor.description || '';
  const goalText = goal.text;
  const goalId = goal.id;
  const floorId = floor.id;

  console.log(`[Alba] Researching: ${floorName}`);
  addLog(goalId, floorId, 'Alba', `Starting research for: ${floorName}`);

  let searchContext = '';

  // Try web search if configured
  if (config.hasTavily) {
    searchContext = await tavilySearch(`${goalText} ${floorDescription}`);
  } else if (config.hasBrave) {
    searchContext = await braveSearch(`${goalText} ${floorDescription}`);
  }

  let userMessage = `Goal: ${goalText}

Floor: ${floorName}
Description: ${floorDescription}
Success Condition: ${floor.success_condition || 'Meets description'}
Deliverable: ${floor.deliverable || 'Complete implementation'}`;

  if (searchContext) {
    userMessage += `\n\nWeb Search Results:\n${searchContext}`;
  }

  if (vexFeedback && vexFeedback.length > 0) {
    userMessage += `\n\nVex Validation Issues (must address these):\n${vexFeedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
  }

  userMessage += '\n\nProvide structured research notes. Think about what information, patterns, and best practices David needs to build the deliverable.';

  const result = await chat(
    [{ role: 'user', content: userMessage }],
    { system: ALBA_SYSTEM }
  );

  addLog(goalId, floorId, 'Alba', `Research complete (${result.length} chars)`);
  console.log(`[Alba] Research complete for: ${floorName}`);
  return result;
}

async function tavilySearch(query) {
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query: query.substring(0, 400),
        max_results: 5,
      }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    if (!data.results) return '';
    return data.results
      .map(r => `[${r.title}](${r.url})\n${r.content}`)
      .join('\n\n');
  } catch (err) {
    console.error('[Alba] Tavily search failed:', err.message);
    return '';
  }
}

async function braveSearch(query) {
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query.substring(0, 400))}&count=5`,
      {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': config.braveSearchApiKey,
        },
      }
    );
    if (!res.ok) return '';
    const data = await res.json();
    if (!data.web || !data.web.results) return '';
    return data.web.results
      .map(r => `[${r.title}](${r.url})\n${r.description}`)
      .join('\n\n');
  } catch (err) {
    console.error('[Alba] Brave search failed:', err.message);
    return '';
  }
}

module.exports = { research };
