# Contributing to AskElira 3

Thanks for your interest in contributing. AskElira 3 is a multi-agent building automation system. This guide will get you running locally and explain where everything lives.

## Running Locally

```bash
git clone https://github.com/AskElira/askelira3
cd askelira3
npm install
cp .env.example .env
# Edit .env — add your LLM_API_KEY at minimum
npm start
# → http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev
```

The only hard requirement is `LLM_API_KEY`. Everything else (Telegram, web search, AgentMail) is optional.

## Project Structure

```
src/
  hermes/          Unified intelligence — SOUL.md defines personality, index.js exposes all modes
  agents/          One file per agent: alba.js, david.js, vex.js, steven.js
  pipeline/        planner.js, floor-runner.js, workspace.js, fixer.js
  web/             server.js, routes.js, public/ (vanilla JS dashboard)
  config.js        All env vars in one place
  db.js            SQLite schema, queries, migrations
  llm.js           Multi-provider LLM client (Anthropic, OpenAI-compatible, Ollama fallback)
  notify.js        Telegram + notification helpers
  scheduler.js     Daily digest (AgentMail)
  memory.js        SQLite-backed key-value memory for agents
  self-improve.js  Pattern analysis loop — learns from blocked floors
  steven-heartbeat.js  Autonomous floor health monitor
```

## Agent Roles

| Agent | File | What it does |
|-------|------|-------------|
| **Alba** | `agents/alba.js` | Researches each floor (web search or LLM reasoning) |
| **Vex** | `agents/vex.js` | Validates quality — blocks bad research and bad code |
| **David** | `agents/david.js` | Writes real files into `workspaces/[goal-id]/` |
| **Elira** | `hermes/index.js` | Plans, approves, reasons (Hermes in Elira mode) |
| **Steven** | `hermes/index.js` + `agents/steven.js` | Diagnoses and patches broken floors |

## Adding a New Agent

1. Create `src/agents/yourname.js` — export an async function `runYourname(floor, goal, options)`
2. Add it to the pipeline in `src/pipeline/floor-runner.js` at the appropriate stage
3. Log with `[Yourname]` prefix for consistency
4. Handle errors gracefully — never throw unhandled; return a structured result
5. Use `chat()` from `src/llm.js` for all LLM calls — pass `agent: 'Yourname'` for tracking

## Pull Request Guidelines

- **Keep PRs focused** — one thing per PR
- **No TypeScript required** — plain JS is fine, keep it consistent with the codebase
- **No new dependencies without discussion** — the current dep count (5) is intentional
- **Log your agent activity** — `console.log('[AgentName] what it did')` at each key step
- **Don't break the pipeline contract** — `runPipeline()` in `floor-runner.js` is the integration point; if you change agent signatures, update it there too
- **Test manually** — create a simple goal and verify floors complete end-to-end

## Coding Style

- CommonJS (`require`/`module.exports`) — no ESM
- `async/await` throughout — no raw Promise chains
- Errors should propagate to floor status: catch and call `updateFloor(id, { status: 'blocked', ... })`
- Keep files under ~200 lines — if it grows, split by responsibility
- No magic numbers — name your timeouts and thresholds as constants at the top of the file

## Reporting Bugs

Open a GitHub issue with:
- What you were trying to build (goal text)
- Which floor failed and what status it's in
- Relevant lines from the log stream (bottom of dashboard, or `data/server.log`)

For security issues, see [SECURITY.md](SECURITY.md).
