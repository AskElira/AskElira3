/**
 * Self-Improvement Pattern Analysis Loop.
 *
 * Runs every 6 hours:
 * - Queries DB for all completed goals + floors
 * - Counts which floor names fail most often (blocked count per floor name pattern)
 * - If any floor type has >3 failures, calls hermesReason() for a suggested fix
 * - Saves suggestion to memory under key 'self_improvement_suggestions'
 * - Sends Telegram with the pattern + suggestion
 *
 * Exports: startSelfImproveLoop()
 */

const { listGoals, listFloors } = require('./db');
const { hermesReason } = require('./hermes/index');
const { sendTelegram } = require('./notify');
const { remember, recall } = require('./memory');
const { config } = require('./config');

const INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FAILURE_THRESHOLD = 3;

let selfImproveTimer = null;

/**
 * Analyze floor failure patterns across all goals.
 * Returns an object mapping floor name patterns to failure counts.
 */
function analyzePatterns() {
  const goals = listGoals();
  const failureCounts = {}; // { floorNamePattern: count }

  for (const goal of goals) {
    const floors = listFloors(goal.id);
    for (const floor of floors) {
      if (floor.status === 'blocked') {
        // Normalize floor name: lowercase, trim numbers/special chars for pattern matching
        const pattern = floor.name.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        if (pattern) {
          failureCounts[pattern] = (failureCounts[pattern] || 0) + 1;
        }
      }
    }
  }

  return failureCounts;
}

/**
 * Run a single self-improvement cycle.
 */
async function selfImproveCycle() {
  try {
    const patterns = analyzePatterns();
    const problematic = Object.entries(patterns).filter(([_, count]) => count > FAILURE_THRESHOLD);

    if (problematic.length === 0) {
      console.log('[SelfImprove] No failure patterns above threshold');
      return;
    }

    console.log(`[SelfImprove] Found ${problematic.length} problematic pattern(s)`);

    // Load existing suggestions
    const existing = recall('self_improvement_suggestions') || [];

    for (const [pattern, count] of problematic) {
      // Skip if we already have a suggestion for this pattern
      const alreadySuggested = existing.some(s => s.pattern === pattern);
      if (alreadySuggested) continue;

      console.log(`[SelfImprove] Analyzing: "${pattern}" (${count} failures)`);

      const context = `Floor type "${pattern}" has failed ${count} times across different goals. This is a recurring pattern in the AskElira building pipeline.

Current pipeline flow: Elira plans -> Alba researches -> Vex1 validates research -> David builds -> Vex2 validates build -> Elira approves.
If a floor fails, Steven attempts to fix it.

The repeated failure of "${pattern}" floors suggests a systemic issue in either:
1. How Elira plans these floors (too vague? wrong scope?)
2. How David builds them (missing context? wrong approach?)
3. How the success condition is defined (too strict? ambiguous?)`;

      const task = `Analyze why "${pattern}" floors keep failing and suggest ONE specific improvement to either the system prompt, planner logic, or floor definition template that would prevent this failure pattern. Be concrete and actionable.`;

      try {
        const reasoning = await hermesReason(context, task);

        // Extract a 1-line summary from the recommendation section
        const lines = reasoning.split('\n').filter(l => l.trim());
        let summary = '';
        let inRecommend = false;
        for (const line of lines) {
          if (line.includes('RECOMMEND')) { inRecommend = true; continue; }
          if (inRecommend && line.trim() && !line.startsWith('**')) {
            summary = line.trim().substring(0, 200);
            break;
          }
        }
        if (!summary) {
          summary = lines[lines.length - 1]?.trim().substring(0, 200) || 'See full analysis';
        }

        const suggestion = {
          pattern,
          failureCount: count,
          summary,
          fullAnalysis: reasoning,
          createdAt: new Date().toISOString(),
        };

        existing.push(suggestion);
        remember('self_improvement_suggestions', existing);

        console.log(`[SelfImprove] Suggestion saved for "${pattern}": ${summary}`);

        if (config.hasTelegram) {
          await sendTelegram(`\u{1F9E0} Elira noticed a pattern: "${pattern}" fails often (${count}x). Suggestion: ${summary}`);
        }
      } catch (err) {
        console.error(`[SelfImprove] Analysis failed for "${pattern}":`, err.message);
      }
    }
  } catch (err) {
    console.error('[SelfImprove] Cycle error:', err.message);
  }
}

/**
 * Start the self-improvement loop. Runs every 6 hours.
 */
function startSelfImproveLoop() {
  if (selfImproveTimer) {
    console.log('[SelfImprove] Already running');
    return;
  }
  console.log('[SelfImprove] Pattern analysis loop started (interval: 6h)');
  selfImproveTimer = setInterval(selfImproveCycle, INTERVAL_MS);
  // Run first analysis after 30 seconds (let server fully boot)
  setTimeout(selfImproveCycle, 30000);
}

function stopSelfImproveLoop() {
  if (selfImproveTimer) {
    clearInterval(selfImproveTimer);
    selfImproveTimer = null;
    console.log('[SelfImprove] Pattern analysis loop stopped');
  }
}

module.exports = { startSelfImproveLoop, stopSelfImproveLoop };
