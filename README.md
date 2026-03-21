# claude-discord-supercharged

Discord bot that gives every user their own Claude Code session through Discord threads.

## How it works

Send a message to the bot (DM or @mention in an enabled channel) and it creates a Discord thread. Inside that thread, a full Claude Code session runs — the same session that powers Claude's own coding tasks, with access to file system tools, web search, and code execution. Reply in the thread to continue the conversation; the session resumes with full context. Sessions expire after 30 minutes of inactivity and can be restarted by sending a new message.

```
User message → access gate → create thread → spawn claude CLI → stream response → send chunks
                                                      ↑
                                           --resume <session-id> on followup
```

## Features

### Session Management
- **Thread-per-session** — each Discord thread maps to an isolated Claude Code session
- **Session resume** — reply in a thread and the same Claude session continues with full history
- **Persistence** — thread-to-session mapping survives bot restarts (SQLite)
- **Idle cleanup** — sessions killed after 30 minutes of inactivity, check every 5 minutes
- **Per-thread queue** — concurrent messages in the same thread are serialized, not dropped

### Conversation Intelligence
- **Message history** — last 5 messages injected as context on each request
- **Thread memory** — per-thread markdown notes, persisted across sessions, auto-compressed at 10K chars
- **Context injection** — history and memory prepended to every prompt before sending to Claude

### Communication
- **Smart chunking** — long responses split at paragraph or line boundaries, never mid-word
- **Reaction status flow** — 👀 (received) → 🔥 (working) → ✅ (done)
- **Inline buttons** — numbered options at the end of a response become Discord buttons automatically
- **Typing indicator** — bot shows "typing..." while Claude is processing

### Voice & Media
- **Voice transcription** — audio attachments transcribed automatically via Whisper
- **Whisper backend detection** — tries `whisper-cli` (whisper.cpp) then `openai-whisper`, disables if neither found
- **File attachments** — downloaded and routed to Claude as local file paths, 25MB limit per file

### Access Control
- **Pairing flow** — new DM users get a 6-character code; admin approves by adding user ID to allowlist
- **Allowlist mode** — only pre-configured user IDs can use the bot
- **Per-channel opt-in** — guild channels must be explicitly enabled; unlisted channels are ignored
- **Mention filtering** — channels can require @mention or reply-to-bot before responding
- **Custom mention patterns** — regex patterns to trigger the bot beyond standard @mention

### Operations
- **Supervisor daemon** — auto-restart with exponential backoff (1s → 30s max), 60s stable = reset
- **Restart signal file** — drop `restart.signal` to trigger graceful restart without touching processes
- **Health endpoint** — `GET /` returns `{status, uptime, sessions}` for Railway / uptime monitors
- **Graceful shutdown** — SIGTERM drains in-flight requests, SIGKILL after 5s timeout

## Quick Start

### 1. Create Discord bot

Go to [Discord Developer Portal](https://discord.com/developers/applications):

1. New Application → Bot tab
2. Enable **Message Content Intent** (required)
3. Enable **Server Members Intent** (optional)
4. Under OAuth2 → URL Generator, select scopes: `bot`, `applications.commands`
5. Bot permissions: `Send Messages`, `Create Public Threads`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use External Emojis`
6. Copy the generated invite URL and add the bot to your server
7. Copy the bot token from the Bot tab

### 2. Install prerequisites

You need [Bun](https://bun.sh) and the Claude Code CLI:

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Authenticate (opens browser)
claude
```

### 3. Clone and install

```bash
git clone https://github.com/your-org/claude-discord-supercharged
cd claude-discord-supercharged
bun install
```

### 4. Configure token

```bash
mkdir -p ~/.claude/channels/discord
echo "DISCORD_BOT_TOKEN=your-token-here" > ~/.claude/channels/discord/.env
```

Or set it as an environment variable:

```bash
export DISCORD_BOT_TOKEN=your-token-here
```

### 5. Configure access

The bot creates `~/.claude/channels/discord/access.json` with defaults on first run. Default policy is `"pairing"` — new DM users are asked to get admin approval.

For a quick private setup (only you can use it), set your Discord user ID directly:

```bash
cat > ~/.claude/channels/discord/access.json << 'EOF'
{
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_DISCORD_USER_ID"]
}
EOF
```

To find your Discord user ID: Settings → Advanced → enable Developer Mode, then right-click your username → Copy User ID.

### 6. Start the bot

```bash
# Direct (development)
bun src/bot.ts

# With supervisor (recommended)
bun supervisor.ts
```

See [Access Control](#access-control) for full configuration options, including enabling channels in servers.

## Access Control

The bot has a flexible access model configured in `~/.claude/channels/discord/access.json`.

See [ACCESS.md](ACCESS.md) for the full reference.

**Quick summary:**

| Mode | Behavior |
|------|----------|
| `"pairing"` | New users receive a code; admin adds them to allowlist |
| `"allowlist"` | Only users in `allowFrom` can use the bot |
| `"disabled"` | DMs rejected entirely |

Guild channels are off by default. Add a channel ID to `groups` to enable it:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {
    "CHANNEL_ID": {
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

## Voice Transcription

The bot auto-detects available Whisper backends at startup:

1. `whisper-cli` (whisper.cpp) + a model file at a standard path
2. `openai-whisper` (Python Whisper)
3. Disabled if neither is found

`ffmpeg` is required for `whisper-cli` to convert audio to 16kHz mono WAV. It is not required for `openai-whisper`.

To install whisper.cpp on macOS:

```bash
brew install whisper-cpp ffmpeg
```

On Ubuntu/Debian:

```bash
apt-get install ffmpeg
# build whisper-cli from source or use a pre-built package
```

To disable transcription globally, set `"autoTranscribe": false` in `access.json`.

## Deployment

### Local

```bash
bun src/bot.ts
```

### Supervisor (recommended for persistent local installs)

The supervisor manages the bot process, restarts on crash, and responds to signal files:

```bash
bun supervisor.ts
```

Backoff schedule: 1s → 2s → 4s → 8s → 16s → 30s (max). Resets after 60 seconds of stable uptime.

To trigger a graceful restart without touching the supervisor:

```bash
touch ~/.claude/channels/discord/data/restart.signal
```

### Systemd

```ini
[Unit]
Description=claude-discord-supercharged
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/claude-discord-supercharged
ExecStart=/home/youruser/.bun/bin/bun supervisor.ts
Restart=on-failure
RestartSec=5
Environment=DISCORD_BOT_TOKEN=your-token-here

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now claude-discord.service
```

### Docker

```bash
docker build -t claude-discord .
docker run -d \
  -e DISCORD_BOT_TOKEN=your-token-here \
  -v ~/.claude/channels/discord:/root/.claude/channels/discord \
  -p 8080:8080 \
  claude-discord
```

The Dockerfile installs Bun, Node.js, Claude Code CLI, and ffmpeg. Claude Code must be authenticated — mount `~/.claude` from a host that has already run `claude` and completed auth.

### Railway

The bot exposes a health endpoint on `PORT` (default `8080`). Railway detects this automatically. Set `DISCORD_BOT_TOKEN` and `CLAUDE_CWD` in Railway environment variables.

## Architecture

```
src/
  bot.ts              Discord.js client — message routing, thread creation, reaction lifecycle
  session-manager.ts  Thread → Claude CLI session mapping, subprocess management, message queuing
  store.ts            SQLite message store — per-channel history, searchable, 500/channel cap
  memory.ts           Per-thread markdown memory — persisted across sessions, auto-compress
  access.ts           Access control — pairing flow, allowlist, channel opt-in, gate checks
  transcriber.ts      Whisper voice transcription — backend detection, ffmpeg conversion
  buttons.ts          Discord button components — numbered option detection, interaction handling
  types.ts            TypeScript interfaces

supervisor.ts         Daemon — manages bot process lifecycle, exponential backoff restart
Dockerfile            Container — Bun + Node.js + Claude CLI + ffmpeg
```

### How sessions work

Each Discord thread ID maps to a Claude Code session ID (stored in SQLite). When a message arrives:

1. `session-manager` looks up the thread ID
2. If a session exists: runs `claude -p "<prompt>" --resume <session-id> --output-format stream-json`
3. If no session: runs `claude -p "<prompt>" --output-format stream-json` (new session)
4. Streams JSON lines from stdout — extracts text blocks and tool calls
5. Saves the session ID from the `system.init` event for the next message

Claude runs with `--dangerously-skip-permissions`, `--effort max`, and `--model claude-opus-4-6` by default, with a 1M context window beta enabled.

### Tools available to Claude

| Tool | Description |
|------|-------------|
| `Read` | Read files from the working directory |
| `Write` | Write files |
| `Edit` | Make targeted edits to files |
| `Bash` | Run shell commands |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents |
| `WebFetch` | Fetch a URL |
| `WebSearch` | Search the web |
| `Agent` | Spawn sub-agents for parallel work |

`AskUserQuestion` is disallowed — the bot handles user interaction directly.

## Configuration Reference

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | — | Discord bot token from Developer Portal |
| `CLAUDE_CWD` | No | `process.cwd()` | Working directory for Claude sessions |
| `PORT` | No | `8080` | Port for health check endpoint |

Token can also be set in `~/.claude/channels/discord/.env` as `DISCORD_BOT_TOKEN=...`. The file takes precedence over the environment variable.

### access.json

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dmPolicy` | `"pairing" \| "allowlist" \| "disabled"` | `"pairing"` | How to handle DMs from unknown users |
| `allowFrom` | `string[]` | `[]` | Allowed Discord user IDs (snowflakes) |
| `groups` | `object` | `{}` | Per-channel configuration (see ACCESS.md) |
| `mentionPatterns` | `string[]` | `[]` | Regex patterns that count as a mention |
| `ackReaction` | `string` | `"eyes"` | Emoji reacted when message is received |
| `replyToMode` | `"off" \| "first" \| "all"` | `"first"` | Whether responses use Discord reply |
| `textChunkLimit` | `number` | `2000` | Max chars per message (Discord max: 2000) |
| `chunkMode` | `"length" \| "newline"` | `"newline"` | How to split long responses |
| `autoTranscribe` | `boolean` | `true` | Auto-transcribe voice attachments |

## Data Locations

All persistent state lives under `~/.claude/channels/discord/`:

```
~/.claude/channels/discord/
  .env                  Bot token
  access.json           Access control config (auto-created on first run)
  data/
    messages.db         SQLite — message history + session mapping
    memory/             Per-thread memory files (<thread-id>.md)
    restart.signal      Drop this file to trigger supervisor restart
  inbox/                Downloaded attachments (temp, not cleaned automatically)
  approved/             Pending approval markers (consumed on polling interval)
```

The SQLite database stores both message history (`messages` table) and session state (`sessions` table). The two share the same file to keep deployment simple.

## Troubleshooting

**Bot doesn't respond to DMs**

Check `dmPolicy` in `access.json`. If it's `"pairing"`, the user receives a pairing code and needs admin approval. If it's `"allowlist"`, their user ID must be in `allowFrom`.

**Bot doesn't respond in a server channel**

The channel ID must be listed under `groups` in `access.json`. If `requireMention` is `true`, you must @mention the bot or reply to one of its messages.

**"No bot token found" error**

Create `~/.claude/channels/discord/.env` with `DISCORD_BOT_TOKEN=your-token-here`, or set the environment variable before running.

**Voice transcription not working**

The bot logs which backend it detected at startup: `[transcriber] backend=whisper-cli ...` or `[transcriber] no whisper binary found`. Install `whisper-cli` + a model, or `openai-whisper`. Transcription is silently skipped if no backend is found.

**Session resumes with wrong context**

Claude sessions are identified by a session ID returned by the CLI. If the bot was restarted and the session no longer exists in Claude's local state, the next message starts a fresh session automatically.

**`claude` command not found**

Install the Claude Code CLI: `npm install -g @anthropic-ai/claude-code` and authenticate with `claude`.

**High memory usage**

Each active session has an in-memory queue and recent-history buffer. Idle cleanup runs every 5 minutes and kills sessions idle for more than 30 minutes. The SQLite database is pruned hourly (14-day TTL, 500 message/channel cap, 50MB max).

## License

MIT — see [LICENSE](LICENSE).
