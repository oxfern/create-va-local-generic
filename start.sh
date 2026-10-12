#!/usr/bin/env bash
set -eo pipefail

cd "$(dirname "$0")"

echo "Installing the local tools..."
./bin/hermit install
source ./bin/activate-hermit

echo "Installing app dependencies..."
bun install --frozen-lockfile

echo "Checking and downloading the voice models (first run: about 2.9 GB)..."
bun run setup

echo "Starting the voice agent..."
bun run dev
