# claude-discord-supercharged

Discord bot that gives Claude Code sessions through Discord threads. Each thread = separate Claude Code session with full context isolation.

## Features

- **Thread-per-session** — each Discord thread maps to an isolated Claude Code session
- **Session persistence** — thread-to-session mapping survives bot restarts (SQLite)
- **Auto-thread creation** — message in guild channel auto-creates a thread
- **Session resume** — subsequent messages in a thread continue the same Claude session
- **Access control** — pairing flow, allowlist, per-channel opt-in
- **Message history** — SQLite store with search, 500/channel cap, 14-day TTL
- **Persistent memory** — per-thread markdown memory, auto-compress at 10K chars
- **Voice transcription** — Whisper (whisper-cli or openai-whisper) + ffmpeg
- **Reaction status flow** — `eyes` (read) -> `fire` (working) -> `check` (done)
- **Discord components** — button-based ask_user confirmations
- **Idle cleanup** — sessions killed after 30min inactivity
- **Supervisor daemon** — auto-restart with exponential backoff (1s-30s)
- **File attachments** — download + route to Claude, 25MB limit

## Prerequisites

- [Bun](https://bun.sh) runtime
- Claude Code CLI installed and authenticated (`claude` command working)
- Discord bot token (from [Discord Developer Portal](https://discord.com/developers/applications))
- Optional: `whisper-cli` or `openai-whisper` + `ffmpeg` for voice transcription

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure bot token

Create `~/.claude/channels/discord/.env`:

```bash
DISCORD_BOT_TOKEN=your-bot-token-here
```

Or set via environment variable:

```bash
export DISCORD_BOT_TOKEN=your-bot-token-here
```

### 3. Discord bot settings

In the [Developer Portal](https://discord.com/developers/applications):

1. Create application -> Bot
2. Enable **Message Content Intent** (required)
3. Enable **Server Members Intent** (optional, for member info)
4. Bot permissions: Send Messages, Create Public Threads, Read Message History, Add Reactions, Attach Files, Use Slash Commands
5. Invite bot to your server with the generated OAuth2 URL

### 4. Configure access

The bot uses a pairing flow by default. When someone DMs the bot:

1. They receive a 6-character pairing code
2. Approve in terminal by adding their Discord user ID to the allowlist

Edit `~/.claude/channels/discord/access.json`:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["USER_ID_1", "USER_ID_2"],
  "groups": {
    "CHANNEL_ID": {
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

- `dmPolicy`: `"pairing"` (default), `"allowlist"`, or `"disabled"`
- `allowFrom`: array of Discord user IDs (snowflakes)
- `groups`: per-channel configuration (add channel IDs to enable)
- `requireMention`: if true, bot only responds when @mentioned in that channel

## Usage

### Run directly

```bash
bun src/bot.ts
```

### Run with supervisor (recommended for production)

```bash
bun supervisor.ts
```

The supervisor provides:
- Auto-restart on crash with exponential backoff (1s -> 30s max)
- Backoff reset after 60s stable uptime
- Graceful shutdown (SIGTERM -> 5s wait -> SIGKILL)
- Restart signal file support

### How it works

1. **DM the bot** or **mention it in an enabled channel**
2. In guild channels, the bot creates a **thread** from your message
3. Claude Code processes your request in an isolated session
4. Reply in the thread to continue the conversation (same session)
5. Sessions auto-expire after 30 minutes of inactivity

### Working directory

By default, Claude works in the bot's current directory. The session manager supports per-thread working directories — extend as needed.

## Architecture

```
bot.ts              Discord.js client — message routing, threads, reactions
session-manager.ts  Thread -> Claude Code session mapping (via Agent SDK)
store.ts            SQLite message history — per-channel, searchable
memory.ts           Per-thread persistent memory (markdown files)
access.ts           Access control — pairing, allowlist, channel opt-in
transcriber.ts      Whisper voice transcription
buttons.ts          Discord button components for confirmations
supervisor.ts       Daemon — manages bot process lifecycle
```

## Configuration

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_BOT_TOKEN` | Discord bot token | Required |

### access.json options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dmPolicy` | string | `"pairing"` | DM handling: pairing/allowlist/disabled |
| `allowFrom` | string[] | `[]` | Allowed user IDs |
| `groups` | object | `{}` | Channel ID -> policy mapping |
| `ackReaction` | string | `"eyes"` | Reaction on message receipt |
| `replyToMode` | string | `"first"` | Reply threading: off/first/all |
| `textChunkLimit` | number | `2000` | Max chars per message |
| `chunkMode` | string | `"newline"` | Split mode: length/newline |
| `autoTranscribe` | boolean | `true` | Auto-transcribe voice messages |

## Data locations

```
~/.claude/channels/discord/
  .env                  Bot token
  access.json           Access control config
  data/
    messages.db         SQLite message + session store
    memory/             Per-thread memory files
    restart.signal      Supervisor restart trigger
  inbox/                Downloaded attachments
  approved/             Pending approval markers
```

## License

MIT
