#!/bin/bash
echo "Setting up AskElira 3..."
npm install
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env -- please add your LLM_API_KEY"
fi
mkdir -p data
echo "Done! Run: npm start"
echo "Then open: http://localhost:3000"
