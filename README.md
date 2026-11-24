# Euler's Harness

A desktop agent harness by Vulktek Cyber Solutions. Chat with an agent that reads files, runs code, and edits while you watch, with live tool activity, metrics, and persistent memory.

## Install

**Linux:** download `Eulers Harness-0.1.0.AppImage`, make executable (`chmod +x`), run.

**Windows:** download the NSIS installer, double-click, follow it. (Builds from the release pipeline.)

No admin rights. No terminal. Data stays in `~/.euler` (Linux/macOS) or `%APPDATA%\Euler's Harness` (Windows).

## First run

The wizard walks you through:

1. Provider pick: Ollama or llama.cpp (local, no key), or any OpenAI-compatible endpoint / Anthropic with your key.
2. Endpoint test: it lists the models your endpoint actually serves.
3. Model pick + context window size.
4. Workspace folder: where the agent works with your files.
5. RAG (optional): point at a docs folder + embedding server; Index now builds your private search.

Keys are encrypted at rest (Windows DPAPI / Linux keyring). Local-only profiles never touch the network beyond your endpoint.

## Updating

The status bar carries an update chip. Click once to check: it compares the running version against
the latest release in this public repo, and if there is a newer one the chip offers it. A second click
downloads `euler-app.asar`, verifies it, swaps it in and relaunches the app. No credentials live on
any machine; every device updates itself from the public releases. Release assets carry the app layer
only, so Linux and Windows consume the same asset.

## What the agent can do

- Chat with full markdown + code rendering
- Live activity panel: every tool call and file touched, streaming
- bash + read/edit/write inside your workspace
- Permission gate: destructive commands, network calls, and system paths ask first
- Persistent memory: soul.md (persona), user.md (your facts), memories (durable facts the model writes)
- Ctrl+F across every conversation you've ever had
- Paste text or files into the input; large pastes are saved to the inbox and referenced
- Metrics line: tok/s, latency, tokens, cost, and a context fill bar

## Building from source

```bash
npm install
npm run typecheck
npm run build && npm run dist:win && npm run dist:linux   # win-unpacked + linux-unpacked dirs
npm run publish:release   # push source, tag the release, upload euler-app.asar (needs GITHUB_TOKEN)
```

## Security model

- API keys encrypted with Electron safeStorage; never logged or indexed
- Permission gate tiers: auto (safe reads), approve (network, outside-workspace writes, package installs), block-then-approve (destructive patterns: rm -rf, sudo, disk tools)
- File tools fenced away from protected files (.env, keys, .euler internals)
- Zero telemetry, zero phone-home; the only check the updater makes is GET /releases/latest on this repo

## Data in one place

Everything lives in one folder. Export zips it. Wipe removes it.

## Stack

TypeScript end to end: Electron + Solid + SQLite (FTS5) + better-sqlite3 + Pi SDK (Earendil pi). Agent core: pi 1.6.0. No Python, no shell app code.
