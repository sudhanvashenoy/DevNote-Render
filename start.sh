#!/bin/bash
echo ""
echo "  ██╗  ██╗███╗   ██╗ ██████╗ ██╗    ██╗██████╗  █████╗ ███████╗███████╗"
echo "  ██║ ██╔╝████╗  ██║██╔═══██╗██║    ██║██╔══██╗██╔══██╗██╔════╝██╔════╝"
echo "  █████╔╝ ██╔██╗ ██║██║   ██║██║ █╗ ██║██████╔╝███████║███████╗█████╗  "
echo "  ██╔═██╗ ██║╚██╗██║██║   ██║██║███╗██║██╔══██╗██╔══██║╚════██║██╔══╝  "
echo "  ██║  ██╗██║ ╚████║╚██████╔╝╚███╔███╔╝██████╔╝██║  ██║███████║███████╗"
echo "  ╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚══╝╚══╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚══════╝"
echo ""
echo "  Personal Knowledge Hub — localhost only"
echo "  ─────────────────────────────────────────"
echo ""

# Check node is installed
if ! command -v node &> /dev/null; then
  echo "  ❌ Node.js not found. Please install Node.js from https://nodejs.org"
  exit 1
fi

# Install deps if needed
if [ ! -d "backend/node_modules" ]; then
  echo "  📦 Installing dependencies (first run only)..."
  cd backend && npm install && cd ..
  echo "  ✅ Dependencies installed"
  echo ""
fi

echo "  🚀 Starting KnowBase at http://localhost:3333"
echo "  📁 Data: ./data/"
echo "  📎 Uploads: ./uploads/"
echo ""
echo "  Press Ctrl+C to stop"
echo ""

cd backend && node server.js
