const { chat } = require('../llm');
const { config } = require('../config');
const { addLog } = require('../db');
const { wrapInput } = require('../hermes/utils');
const { createBreaker, CircuitOpenError } = require('../circuit-breaker');

const tavilyBreaker = createBreaker('tavily');
const braveBreaker = createBreaker('brave');
const lightpandaBreaker = createBreaker('lightpanda');

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
 * Research a floor's task. Uses Tavily → Brave → Lightpanda → LLM-only.
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
  let searchUrls = [];

  // Tier 1: Tavily
  if (config.hasTavily) {
    try {
      const { context, urls } = await tavilyBreaker.call(() => tavilySearch(`${goalText} ${floorDescription}`));
      searchContext = context;
      searchUrls = urls;
    } catch (err) {
      if (err instanceof CircuitOpenError) console.log(`[Alba] Tavily circuit open — skipping`);
      else console.error('[Alba] Tavily search failed:', err.message);
    }
  }
  // Tier 2: Brave (fallback if Tavily had no results or is unavailable)
  if (!searchContext && config.hasBrave) {
    try {
      const { context, urls } = await braveBreaker.call(() => braveSearch(`${goalText} ${floorDescription}`));
      searchContext = context;
      searchUrls = urls;
    } catch (err) {
      if (err instanceof CircuitOpenError) console.log(`[Alba] Brave circuit open — skipping`);
      else console.error('[Alba] Brave search failed:', err.message);
    }
  }

  // Tier 3: Lightpanda — enhance with full page content
  if (config.hasLightpanda) {
    try {
      if (searchUrls.length > 0) {
        const fullContent = await lightpandaBreaker.call(() => lightpandaScrape(searchUrls.slice(0, 2)));
        if (fullContent) searchContext += `\n\n## Full Page Content\n${fullContent}`;
      } else if (!searchContext) {
        searchContext = await lightpandaBreaker.call(() => lightpandaSearch(`${goalText} ${floorDescription}`));
      }
    } catch (err) {
      if (err instanceof CircuitOpenError) console.log(`[Alba] Lightpanda circuit open — skipping`);
      else console.error('[Alba] Lightpanda failed:', err.message);
    }
  }

  const userMessage = buildMessage({ goalText, floorName, floorDescription, floor, searchContext, vexFeedback });

  const result = await chat(
    [{ role: 'user', content: userMessage }],
    { system: ALBA_SYSTEM, goalId, floorId, agent: 'Alba' }
  );

  addLog(goalId, floorId, 'Alba', `Research complete (${result.length} chars)`);
  console.log(`[Alba] Research complete for: ${floorName}`);
  return result;
}

function buildMessage({ goalText, floorName, floorDescription, floor, searchContext, vexFeedback }) {
  let msg = `Goal: ${wrapInput(goalText)}

Floor: ${wrapInput(floorName)}
Description: ${wrapInput(floorDescription)}
Success Condition: ${wrapInput(floor.success_condition || 'Meets description')}
Deliverable: ${wrapInput(floor.deliverable || 'Complete implementation')}`;

  if (searchContext) {
    msg += `\n\nWeb Research:\n${wrapInput(searchContext, 6000)}`;
  }

  if (vexFeedback && vexFeedback.length > 0) {
    msg += `\n\nVex Validation Issues (must address these):\n${vexFeedback.map((f, i) => `${i + 1}. ${wrapInput(f)}`).join('\n')}`;
  }

  msg += '\n\nProvide structured research notes. Think about what information, patterns, and best practices David needs to build the deliverable.';
  return msg;
}

// ── Tavily ──

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
    if (!res.ok) return { context: '', urls: [] };
    const data = await res.json();
    if (!data.results) return { context: '', urls: [] };
    const context = data.results.map(r => `[${r.title}](${r.url})\n${r.content}`).join('\n\n');
    const urls = data.results.map(r => r.url).filter(Boolean);
    return { context, urls };
  } catch (err) {
    console.error('[Alba] Tavily search failed:', err.message);
    return { context: '', urls: [] };
  }
}

// ── Brave ──

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
    if (!res.ok) return { context: '', urls: [] };
    const data = await res.json();
    if (!data.web || !data.web.results) return { context: '', urls: [] };
    const context = data.web.results.map(r => `[${r.title}](${r.url})\n${r.description}`).join('\n\n');
    const urls = data.web.results.map(r => r.url).filter(Boolean);
    return { context, urls };
  } catch (err) {
    console.error('[Alba] Brave search failed:', err.message);
    return { context: '', urls: [] };
  }
}

// ── Lightpanda ──

/**
 * Scrape an array of URLs using Lightpanda, returning combined text content.
 * Non-fatal: returns '' on any error.
 */
async function lightpandaScrape(urls) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    console.warn('[Alba] puppeteer-core not installed — skipping Lightpanda scrape');
    return '';
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: config.lightpandaUrl });
    const results = [];

    for (const url of urls) {
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const text = await page.evaluate(() => document.body?.innerText || '');
        results.push(`[${url}]\n${text.slice(0, 2000)}`);
        await page.close();
      } catch (err) {
        console.warn(`[Alba] Lightpanda failed to scrape ${url}:`, err.message);
      }
    }

    return results.join('\n\n---\n\n');
  } catch (err) {
    console.error('[Alba] Lightpanda connect failed:', err.message);
    return '';
  } finally {
    if (browser) try { await browser.disconnect(); } catch {}
  }
}

/**
 * Search DuckDuckGo via Lightpanda when no search API is configured.
 * Returns combined text from top result pages.
 */
async function lightpandaSearch(query) {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    return '';
  }

  let browser;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: config.lightpandaUrl });
    const page = await browser.newPage();

    // Search DuckDuckGo
    await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query.substring(0, 200))}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    // Extract top result URLs
    const urls = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      return links
        .map(a => a.href)
        .filter(href => href.startsWith('http') && !href.includes('duckduckgo.com'))
        .slice(0, 5);
    });
    await page.close();

    if (!urls.length) return '';

    console.log(`[Alba] Lightpanda DuckDuckGo found ${urls.length} URLs`);
    return lightpandaScrape(urls.slice(0, 3));
  } catch (err) {
    console.error('[Alba] Lightpanda search failed:', err.message);
    return '';
  } finally {
    if (browser) try { await browser.disconnect(); } catch {}
  }
}

module.exports = { research };
