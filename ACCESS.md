# Access Control

The bot controls who can use it through `~/.claude/channels/discord/access.json`. The file is created automatically on first run with safe defaults.

## Policy Modes

### `"pairing"` (default)

New users who DM the bot receive a 6-character code and a message asking them to get admin approval. Existing users in `allowFrom` are let through immediately.

Pairing codes expire after 1 hour. At most 3 pending DM codes exist at a time; additional requests are dropped silently until existing codes expire or are approved.

To approve a user: add their Discord user ID to `allowFrom` in `access.json`. The bot polls `~/.claude/channels/discord/approved/` every 5 seconds — you can also drop a file named `<user-id>` in that directory and the bot will add the user and send them a confirmation DM.

### `"allowlist"`

Only users whose Discord user ID appears in `allowFrom` can use the bot. All other DMs are silently dropped without a response.

### `"disabled"`

All DMs are dropped. Use this if you only want the bot to operate in specific server channels.

## DM Flow (pairing mode)

1. User sends a DM to the bot
2. Bot replies: `"To use Claude, ask the admin to approve your pairing code: <code>"`
3. Admin adds the user ID to `allowFrom` in `access.json`
4. Bot detects the change within 5 seconds and sends the user: `"Paired! You can now chat with Claude. Say hi!"`
5. All subsequent DMs from that user are delivered

If the user DMs again before approval, they receive the same pairing code (no duplicate).

## Guild Channel Configuration

Server channels are opt-in. A channel not listed in `groups` is completely ignored.

To enable a channel, add its ID to `groups`:

```json
{
  "groups": {
    "1234567890123456789": {
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

When a message arrives in an enabled channel, the bot:
1. Checks `allowFrom` for that channel (if non-empty, user must be in it)
2. Checks `requireMention` (if true, user must @mention the bot, reply to it, or match a custom pattern)
3. Creates a thread from the message if both checks pass

### `requireMention`

When `true`, the bot only responds if the message:
- Contains a direct @mention of the bot (`<@BOT_ID>`)
- Is a reply to one of the bot's own messages
- Matches one of the `mentionPatterns` regexes (if configured)

When `false`, the bot responds to every message in the channel from allowed users.

### Per-channel `allowFrom`

An empty `allowFrom` array means all users (subject to the DM-level `dmPolicy` allowlist — note: guild messages do not use `dmPolicy`; the channel `allowFrom` is the only gate for guild messages).

A non-empty `allowFrom` restricts that channel to those specific user IDs:

```json
{
  "groups": {
    "CHANNEL_ID": {
      "requireMention": false,
      "allowFrom": ["USER_ID_1", "USER_ID_2"]
    }
  }
}
```

## Mention Detection

Three things count as a mention in guild channels:

1. **Direct @mention** — message contains `<@BOT_ID>` or `<@!BOT_ID>`
2. **Reply to bot** — message is a Discord reply to one of the last 200 messages the bot sent
3. **Custom pattern** — message matches one of the regexes in `mentionPatterns`

The bot mention (`<@BOT_ID>`) is stripped from the message before it is sent to Claude.

### Custom mention patterns

Add regex patterns to `mentionPatterns` to trigger the bot without an @mention:

```json
{
  "mentionPatterns": [
    "^claude[,:]",
    "\\bask claude\\b",
    "^hey bot"
  ]
}
```

Patterns are matched case-insensitively. Invalid regex patterns are skipped silently.

## Full access.json Schema

```json
{
  "dmPolicy": "pairing",
  "allowFrom": [],
  "groups": {},
  "mentionPatterns": [],
  "ackReaction": "eyes",
  "replyToMode": "first",
  "textChunkLimit": 2000,
  "chunkMode": "newline",
  "autoTranscribe": true
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dmPolicy` | `"pairing" \| "allowlist" \| "disabled"` | `"pairing"` | How unknown DM users are handled |
| `allowFrom` | `string[]` | `[]` | Discord user IDs allowed to DM the bot |
| `groups` | `Record<string, GroupPolicy>` | `{}` | Per-channel config (key = channel snowflake) |
| `mentionPatterns` | `string[]` | `[]` | Regex patterns that count as a mention |
| `ackReaction` | `string` | `"eyes"` | Emoji reacted when a message is received (`"eyes"` = 👀, or any emoji string) |
| `replyToMode` | `"off" \| "first" \| "all"` | `"first"` | Whether bot uses Discord reply on responses |
| `textChunkLimit` | `number` | `2000` | Max characters per Discord message (hard cap: 2000) |
| `chunkMode` | `"length" \| "newline"` | `"newline"` | Split at exact length or at natural line breaks |
| `autoTranscribe` | `boolean` | `true` | Transcribe audio attachments automatically |

### GroupPolicy schema

```json
{
  "requireMention": true,
  "allowFrom": []
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `requireMention` | `boolean` | `true` | Require @mention or reply to respond |
| `allowFrom` | `string[]` | `[]` | Restrict channel to these user IDs (empty = all) |

## Common Setups

### Private bot (just you)

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["YOUR_USER_ID"]
}
```

### Team bot (specific people, specific channel)

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["USER_ID_1", "USER_ID_2", "USER_ID_3"],
  "groups": {
    "CHANNEL_ID": {
      "requireMention": false,
      "allowFrom": ["USER_ID_1", "USER_ID_2", "USER_ID_3"]
    }
  }
}
```

### Public server (anyone in specific channels, @mention required)

```json
{
  "dmPolicy": "disabled",
  "allowFrom": [],
  "groups": {
    "CHANNEL_ID": {
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

### Open server with pairing for DMs

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

New DM users go through pairing. Channel messages require @mention. Anyone can be approved.

## Editing access.json

The file is read on every message, so changes take effect immediately without restarting the bot. Use any text editor:

```bash
nano ~/.claude/channels/discord/access.json
```

The bot writes to the file atomically (write to temp file, rename) to prevent corruption. If the file is corrupted, the bot renames it to `access.json.corrupt-<timestamp>` and starts with defaults.
