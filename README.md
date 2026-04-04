# AskElira 3

Multi-agent building automation powered by Hermes (Elira + Steven).

Describe a goal. Hermes decomposes it into floors. Alba researches, David builds real code,
Vex validates everything, Elira approves. If anything breaks, Steven fixes it.

## Setup

**Prerequisites:** Node.js 18+ and a C++ compiler for the SQLite native addon:

| Platform | Install build tools |
|----------|-------------------|
| **Mac** | `xcode-select --install` |
| **Windows** | `npm install -g windows-build-tools` |
| **Linux** | `sudo apt install build-essential python3` |

**Then:**

1. `git clone https://github.com/AskElira/askelira3 && cd askelira3`
2. `npm install`
3. `cp .env.example .env` -- add your `LLM_API_KEY`
4. `npm start` -- http://localhost:3000

Optionally add `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` for notifications.

## LLM Providers

| Provider | LLM_BASE_URL | Notes |
|---|---|---|
| Anthropic (default) | (leave blank) | Best quality |
| OpenRouter | https://openrouter.ai/api/v1 | Any model |
| Local (Ollama) | http://localhost:11434/v1 | Private |

## Agents

- **Alba** -- researches requirements (web search or LLM reasoning)
- **Vex** -- validates research quality + code quality (blocks bad work)
- **David** -- writes real, working code into `workspaces/[goal-id]/`
- **Elira** (Hermes) -- architect, approver, deep reasoner
- **Steven** (Hermes) -- fixer, debugger, patches broken floors

## Pipeline

```
Goal -> Hermes/Elira plans floors -> For each floor:
  Alba researches -> Vex Gate 1 -> David builds real files -> Vex Gate 2 -> Hermes/Elira approves
  If rejected: Hermes/Steven patches -> re-validate -> retry (max 3)
  If all pass: Goal met
```

## Output

All generated code lives in `workspaces/[goal-id]/`. View and download from the dashboard.

## CLI

```bash
askelira3 "build a REST API for a todo app"   # Run a goal
askelira3 --status                              # Show all goals
askelira3 --logs [goalId]                       # Show logs
askelira3 --fix <floorId>                       # Steven fixes a floor
askelira3                                       # Interactive chat
```

## Dashboard

The web dashboard at http://localhost:3000 has three tabs:

- **Building** -- floor pipeline with status, agent badges, Vex scores, and fix buttons
- **Workspace** -- file browser with syntax-highlighted code viewer
- **Chat** -- direct conversation with Hermes (Elira/Steven modes)

Live log stream at the bottom shows real-time agent activity.

## Architecture

```
src/
  hermes/          Unified intelligence (SOUL.md + index.js)
  agents/          Alba, David, Vex, Steven, Elira (thin wrapper)
  pipeline/        Planner, floor-runner, workspace manager, fixer
  web/             Express server, routes, static frontend
  config.js        Environment configuration
  db.js            SQLite with better-sqlite3
  llm.js           Multi-provider LLM client
  notify.js        Telegram notifications
```

## License

MIT
