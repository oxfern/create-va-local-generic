#!/usr/bin/env bash
set -eo pipefail

cd "$(dirname "$0")"

echo "Installing Bun and llama.cpp..."
./scripts/install-tools.sh
export PATH="$PWD/.tools/bin:$PATH"

echo "Installing app dependencies..."
bun install --frozen-lockfile

echo "Checking and downloading the voice models (first run: about 2.9 GB)..."
bun run setup

echo "Starting the voice agent..."
bun run dev
