#!/bin/bash
# SentinelVault — Devnet Setup Script

set -e

echo "🔧 SentinelVault Setup"
echo "======================"

# Check Node.js version
NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ is required. Current: $(node -v 2>/dev/null || echo 'not installed')"
  exit 1
fi
echo "✅ Node.js $(node -v) detected"

# Create .sentinelvault directories
mkdir -p .sentinelvault/keystores
mkdir -p .sentinelvault/audit
mkdir -p .sentinelvault/logs
chmod 700 .sentinelvault/keystores
echo "✅ Created .sentinelvault/ directories"

# Copy .env.example to .env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✅ Created .env from .env.example"
else
  echo "ℹ️  .env already exists, skipping"
fi

# Install dependencies if needed
if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo "✅ Dependencies installed"
else
  echo "ℹ️  node_modules exists, skipping install"
fi

# Build TypeScript
echo "🔨 Building TypeScript..."
npm run build
echo "✅ Build complete"

echo ""
echo "🚀 Setup complete! Run 'npm run demo' to start the multi-agent demo."
