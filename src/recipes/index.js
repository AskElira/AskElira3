const RECIPES = [
  {
    id: 'rest-api',
    name: 'REST API Scaffold',
    description: 'Express.js REST API with CRUD endpoints, input validation, error handling, and SQLite persistence.',
    category: 'Backend',
    default_goal_text: 'Build a production-ready REST API with Express.js — CRUD endpoints, input validation, error middleware, rate limiting, and SQLite database with a clean schema',
    suggested_floors: ['Project Setup & Package Config', 'Database Schema & Migrations', 'API Routes & Controllers', 'Middleware & Validation', 'Error Handling & Logging'],
    tags: ['node', 'express', 'api', 'rest', 'sqlite', 'backend'],
  },
  {
    id: 'vapi-voice-agent',
    name: 'Vapi.ai Voice Agent',
    description: 'End-to-end Vapi.ai voice agent with custom tools, system prompts, and a webhook backend.',
    category: 'AI/Voice',
    default_goal_text: 'Build a Vapi.ai voice agent with a Node.js webhook backend, custom assistant configuration, tool definitions, and a test HTML page to make calls',
    suggested_floors: ['Webhook Server Setup', 'Vapi Assistant Configuration', 'Custom Tool Handlers', 'Call Flow Logic', 'Test Interface'],
    tags: ['vapi', 'voice', 'ai', 'node', 'webhook'],
  },
  {
    id: 'fastapi-service',
    name: 'FastAPI Service',
    description: 'Python FastAPI service with async endpoints, Pydantic models, SQLAlchemy ORM, and auto-generated docs.',
    category: 'Backend',
    default_goal_text: 'Build a Python FastAPI service with async endpoints, Pydantic request/response models, SQLAlchemy ORM with SQLite, Alembic migrations, and automatic OpenAPI docs',
    suggested_floors: ['Project Layout & Requirements', 'Database Models & ORM', 'API Endpoints & Routing', 'Auth & Middleware', 'Tests & Health Check'],
    tags: ['python', 'fastapi', 'api', 'pydantic', 'sqlalchemy', 'backend'],
  },
  {
    id: 'react-dashboard',
    name: 'React Dashboard',
    description: 'Data dashboard with React, Chart.js, live polling, and a dark-mode-first design.',
    category: 'Frontend',
    default_goal_text: 'Build a React dashboard with Chart.js charts, a data table with sorting and filtering, live polling via fetch, dark mode support using CSS variables, and a responsive layout',
    suggested_floors: ['Project Scaffold & Dependencies', 'Layout & Dark Mode Theme', 'Chart Components', 'Data Table with Filters', 'Live Data Polling'],
    tags: ['react', 'frontend', 'dashboard', 'chartjs', 'css'],
  },
  {
    id: 'telegram-bot',
    name: 'Telegram Bot',
    description: 'Feature-complete Telegram bot with commands, inline keyboards, persistent state, and a webhook mode.',
    category: 'Bots',
    default_goal_text: 'Build a Telegram bot with node-telegram-bot-api — command handlers, inline keyboard menus, user session state in SQLite, a /help system, and optional webhook mode',
    suggested_floors: ['Bot Setup & Config', 'Command Handlers', 'Inline Keyboard Menus', 'Session State Storage', 'Webhook Mode & Deploy'],
    tags: ['telegram', 'bot', 'node', 'sqlite'],
  },
  {
    id: 'cli-tool',
    name: 'CLI Tool',
    description: 'Node.js CLI tool with argument parsing, config file support, colored output, and a plugin architecture.',
    category: 'Tools',
    default_goal_text: 'Build a Node.js CLI tool with commander.js for argument parsing, a .config.json for user settings, colorful terminal output via chalk, progress indicators, and an extensible command registry',
    suggested_floors: ['CLI Entry Point & Commands', 'Argument Parsing & Validation', 'Config File System', 'Output Formatting & Colors', 'Plugin/Command Registry'],
    tags: ['node', 'cli', 'commander', 'chalk', 'tools'],
  },
  {
    id: 'data-pipeline',
    name: 'Data Pipeline',
    description: 'Python ETL pipeline with scheduled runs, SQLite staging, error recovery, and a summary report.',
    category: 'Data',
    default_goal_text: 'Build a Python ETL data pipeline that fetches from a source API, transforms and cleans the data, loads it into SQLite, handles errors with retries, and generates a daily summary report',
    suggested_floors: ['Pipeline Architecture & Config', 'Data Extraction Layer', 'Transform & Clean Logic', 'SQLite Load & Schema', 'Scheduler & Summary Report'],
    tags: ['python', 'etl', 'pipeline', 'sqlite', 'data'],
  },
  {
    id: 'webhook-handler',
    name: 'Webhook Handler',
    description: 'Secure webhook receiver with signature verification, event routing, retry queue, and an admin UI.',
    category: 'Integration',
    default_goal_text: 'Build a webhook handler service with Express.js — HMAC signature verification, event type routing, a SQLite queue for retry logic, idempotency keys, and a minimal admin dashboard to view recent events',
    suggested_floors: ['Server & Signature Verification', 'Event Router & Handlers', 'SQLite Queue & Retry Logic', 'Idempotency & Dedup', 'Admin Dashboard'],
    tags: ['node', 'express', 'webhook', 'sqlite', 'integration'],
  },
];

const CATEGORIES = [...new Set(RECIPES.map(r => r.category))];

function listRecipes() {
  return RECIPES;
}

function getRecipe(id) {
  return RECIPES.find(r => r.id === id) || null;
}

function listCategories() {
  return CATEGORIES;
}

function findByName(name) {
  const lower = name.toLowerCase();
  return RECIPES.find(r =>
    r.id === lower ||
    r.name.toLowerCase().includes(lower) ||
    r.tags.some(t => t === lower)
  ) || null;
}

module.exports = { listRecipes, getRecipe, listCategories, findByName, RECIPES };
