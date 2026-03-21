import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type DMChannel,
  type Attachment,
  type OmitPartialGroupDMChannel,
} from "discord.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";

import { AccessControl } from "./access.js";
import { SessionManager } from "./session-manager.js";
import { MessageStore } from "./store.js";
import { Transcriber } from "./transcriber.js";
import { ButtonManager } from "./buttons.js";

// ── Constants ────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), ".claude", "channels", "discord");
const DATA_DIR = join(STATE_DIR, "data");
const INBOX_DIR = join(STATE_DIR, "inbox");
const APPROVED_DIR = join(STATE_DIR, "approved");
const ENV_PATH = join(STATE_DIR, ".env");

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const IDLE_CLEANUP_INTERVAL = 5 * 60 * 1000; // check every 5 min
const APPROVAL_POLL_INTERVAL = 5000; // 5s
const MAX_DISCORD_LENGTH = 2000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_THREAD_TITLE_LENGTH = 100;

const DEFAULT_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebFetch", "WebSearch", "Agent",
];

const DEFAULT_CWD = process.env.CLAUDE_CWD ?? process.cwd();

// ── Helpers ──────────────────────────────────────────────────────

function loadToken(): string {
  // Try .env file first
  if (existsSync(ENV_PATH)) {
    const content = readFileSync(ENV_PATH, "utf8");
    const match = content.match(/^DISCORD_BOT_TOKEN\s*=\s*(.+)$/m);
    if (match?.[1]) return match[1].trim();
  }
  // Fallback to environment
  const envToken = process.env.DISCORD_BOT_TOKEN;
  if (envToken) return envToken;
  console.error("No bot token found. Set DISCORD_BOT_TOKEN in env or in ~/.claude/channels/discord/.env");
  process.exit(1);
}

function chunk(text: string, limit: number, mode: "length" | "newline"): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = limit;
    if (mode === "newline") {
      const lastPara = remaining.lastIndexOf("\n\n", limit);
      if (lastPara > limit * 0.3) {
        splitAt = lastPara + 2;
      } else {
        const lastLine = remaining.lastIndexOf("\n", limit);
        if (lastLine > limit * 0.3) {
          splitAt = lastLine + 1;
        } else {
          const lastSpace = remaining.lastIndexOf(" ", limit);
          if (lastSpace > limit * 0.3) {
            splitAt = lastSpace + 1;
          }
        }
      }
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

function safeAttName(att: Attachment): string {
  return (att.name ?? "file").replace(/[\[\]\r\n;]/g, "");
}

function sanitizeExt(name: string): string {
  const ext = extname(name).replace(/[^a-zA-Z0-9.]/g, "");
  return ext || ".bin";
}

function truncateTitle(text: string): string {
  const firstLine = text.split("\n")[0].trim();
  if (firstLine.length <= MAX_THREAD_TITLE_LENGTH) return firstLine;
  return firstLine.slice(0, MAX_THREAD_TITLE_LENGTH - 3) + "...";
}

/** Detect numbered options at the end of Claude's response.
 *  Matches patterns like:
 *    1. Option text
 *    2. Another option
 *  or:
 *    1) Option text
 *    2) Another option
 *  Returns the option labels if found (2-6 options), null otherwise. */
function detectOptions(text: string): string[] | null {
  const lines = text.trim().split("\n");
  const options: string[] = [];

  // Scan from the end to find consecutive numbered lines
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^\s*(\d+)[.)]\s+(.+)/);
    if (match) {
      options.unshift(match[2].replace(/\*\*/g, "").trim());
    } else if (options.length > 0) {
      break; // stop at first non-option line
    }
  }

  // Validate: need 2-6 options, numbered sequentially from 1
  if (options.length >= 2 && options.length <= 6) {
    // Verify they look like actual options (not too long)
    if (options.every(o => o.length <= 80)) {
      return options;
    }
  }
  return null;
}

// ── Bot ──────────────────────────────────────────────────────────

const token = loadToken();

// Ensure directories
for (const dir of [STATE_DIR, DATA_DIR, INBOX_DIR, APPROVED_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// Initialize services
const accessControl = new AccessControl();
const store = new MessageStore();
const transcriber = await Transcriber.create();
const buttons = new ButtonManager();
const sessions = new SessionManager(DEFAULT_CWD, DEFAULT_TOOLS);

// Track sent message IDs for mention detection
const sentMessageIds = new Set<string>();
const MAX_SENT_TRACKED = 200;

function noteSent(id: string) {
  sentMessageIds.add(id);
  if (sentMessageIds.size > MAX_SENT_TRACKED) {
    const first = sentMessageIds.values().next().value;
    if (first) sentMessageIds.delete(first);
  }
}

// ── Discord Client ───────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once("ready", () => {
  console.log(`[bot] logged in as ${client.user?.tag}`);
  console.log(`[bot] serving ${client.guilds.cache.size} guild(s)`);

  // Periodic idle cleanup
  setInterval(() => {
    sessions.cleanupIdle(IDLE_TIMEOUT_MS);
  }, IDLE_CLEANUP_INTERVAL);

  // Approval polling
  setInterval(() => {
    checkApprovals();
  }, APPROVAL_POLL_INTERVAL);

  // Periodic DB pruning
  setInterval(() => {
    store.prune();
  }, 60 * 60 * 1000); // hourly
});

// ── Approval Polling ─────────────────────────────────────────────

async function checkApprovals() {
  if (!existsSync(APPROVED_DIR)) return;
  const files = readdirSync(APPROVED_DIR);

  for (const userId of files) {
    if (userId.startsWith(".")) continue;
    const filePath = join(APPROVED_DIR, userId);
    try {
      const chatId = readFileSync(filePath, "utf8").trim();
      unlinkSync(filePath);

      accessControl.addUser(userId);

      // Send confirmation DM
      try {
        const user = await client.users.fetch(userId);
        await user.send("Paired! You can now chat with Claude. Say hi!");
      } catch {
        console.log(`[bot] couldn't DM user ${userId} after approval`);
      }

      console.log(`[bot] approved user ${userId} (chat ${chatId})`);
    } catch {
      // ignore read failures
    }
  }
}

// ── Mention Detection ────────────────────────────────────────────

function isMentioned(msg: Message): boolean {
  if (!client.user) return false;

  // Direct @mention
  if (msg.mentions.has(client.user)) return true;

  // Reply to bot's message
  if (msg.reference?.messageId && sentMessageIds.has(msg.reference.messageId)) {
    return true;
  }

  // Custom mention patterns from access config
  const access = accessControl.load();
  if (access.mentionPatterns) {
    for (const pattern of access.mentionPatterns) {
      try {
        if (new RegExp(pattern, "i").test(msg.content)) return true;
      } catch {
        // invalid regex — skip
      }
    }
  }

  return false;
}

// ── Attachment Handling ──────────────────────────────────────────

async function downloadAttachment(att: Attachment): Promise<string | null> {
  if (att.size > MAX_ATTACHMENT_BYTES) {
    console.log(`[bot] attachment ${att.name} too large (${att.size} bytes)`);
    return null;
  }

  try {
    const response = await fetch(att.url);
    if (!response.ok) return null;

    const buf = Buffer.from(await response.arrayBuffer());
    const ext = sanitizeExt(att.name ?? "file.bin");
    const path = join(INBOX_DIR, `${Date.now()}-${att.id}${ext}`);
    writeFileSync(path, buf);
    return path;
  } catch (err) {
    console.log(`[bot] failed to download attachment: ${err}`);
    return null;
  }
}

// ── Response Sending ─────────────────────────────────────────────

async function sendResponse(
  channel: TextChannel | ThreadChannel | DMChannel,
  text: string,
  access: { textChunkLimit?: number; chunkMode?: "length" | "newline"; replyToMode?: string },
  replyToId?: string,
): Promise<void> {
  const limit = Math.min(access.textChunkLimit ?? MAX_DISCORD_LENGTH, MAX_DISCORD_LENGTH);
  const mode = access.chunkMode ?? "newline";
  const chunks = chunk(text, limit, mode);

  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i];
    try {
      let sent: Message;
      if (i === 0 && replyToId && access.replyToMode !== "off") {
        sent = await channel.send({
          content,
          reply: { messageReference: replyToId },
        });
      } else {
        sent = await channel.send({ content });
      }
      noteSent(sent.id);

      // Store outgoing message
      store.store({
        message_id: sent.id,
        channel_id: channel.id,
        user_id: client.user?.id ?? "bot",
        username: client.user?.username ?? "claude",
        display_name: client.user?.displayName ?? "Claude",
        text: content,
        date: Math.floor(sent.createdTimestamp / 1000),
        is_outgoing: true,
        thread_id: channel.isThread() ? channel.id : undefined,
      });
    } catch (err) {
      console.error(`[bot] failed to send chunk ${i + 1}/${chunks.length}:`, err);
    }
  }
}

// ── Message Handler ──────────────────────────────────────────────

client.on("messageCreate", async (msg: OmitPartialGroupDMChannel<Message>) => {
  // Ignore own messages
  if (msg.author.id === client.user?.id) return;
  if (msg.author.bot) return;

  const isDM = msg.channel.type === ChannelType.DM;
  const isThread = msg.channel.isThread();
  const parentChannelId = isThread ? (msg.channel as ThreadChannel).parentId ?? undefined : undefined;
  const guildId = msg.guildId ?? undefined;

  // Store all messages before gating
  store.store({
    message_id: msg.id,
    channel_id: msg.channelId,
    user_id: msg.author.id,
    username: msg.author.username,
    display_name: msg.author.displayName ?? msg.author.username,
    text: msg.content,
    media_type: msg.attachments.size > 0 ? "attachment" : undefined,
    caption: undefined,
    reply_to_msg_id: msg.reference?.messageId ?? undefined,
    date: Math.floor(msg.createdTimestamp / 1000),
    thread_id: isThread ? msg.channelId : undefined,
  });

  // Gate check
  const gate = accessControl.gate(
    msg.author.id,
    msg.channelId,
    isDM,
    guildId,
    isThread,
    parentChannelId,
  );

  if (gate.action === "drop") return;

  if (gate.action === "pair") {
    if (!gate.isResend) {
      try {
        await msg.reply(
          `To use Claude, ask the admin to approve your pairing code: \`${gate.code}\`\n` +
          `Run in terminal: approve the code in the Discord access settings.`
        );
      } catch {
        // can't reply — DMs disabled or permissions
      }
    }
    return;
  }

  // gate.action === "deliver"
  const access = gate.access;

  // In guild channels (not threads): check if bot is mentioned
  if (!isDM && !isThread) {
    const groupPolicy = access.groups[msg.channelId];
    if (groupPolicy?.requireMention && !isMentioned(msg)) {
      return;
    }
  }

  // In threads: only respond if it's a thread we're tracking, or bot is mentioned
  if (isThread && !sessions.hasSession(msg.channelId) && !isMentioned(msg)) {
    return;
  }

  // Ack reaction
  if (access.ackReaction) {
    try {
      await msg.react(access.ackReaction === "eyes" ? "👀" : access.ackReaction);
    } catch {
      // no permission to react
    }
  }

  // Build prompt from message content + attachments
  let prompt = msg.content;

  // Strip bot mention from message
  if (client.user) {
    prompt = prompt.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  }

  // Handle attachments
  const attachmentDescs: string[] = [];
  for (const [, att] of msg.attachments) {
    const path = await downloadAttachment(att);
    if (path) {
      const kb = Math.round(att.size / 1024);
      attachmentDescs.push(`[Attachment: ${safeAttName(att)} (${att.contentType ?? "unknown"}, ${kb}KB) downloaded to ${path}]`);
    }
  }
  if (attachmentDescs.length > 0) {
    prompt += "\n\n" + attachmentDescs.join("\n");
  }

  // Voice transcription for audio attachments
  if (access.autoTranscribe && transcriber.isAvailable()) {
    for (const [, att] of msg.attachments) {
      if (att.contentType?.startsWith("audio/") || att.name?.match(/\.(ogg|mp3|wav|m4a|flac|webm)$/i)) {
        const path = await downloadAttachment(att);
        if (path) {
          const transcription = await transcriber.transcribe(path);
          if (transcription) {
            prompt += `\n\n[Voice transcription: ${transcription}]`;
          }
        }
      }
    }
  }

  if (!prompt.trim()) {
    prompt = "(empty message with attachments — describe what you see)";
  }

  // Determine working channel — create thread in guild channels, use existing in DMs/threads
  let workChannel: TextChannel | ThreadChannel | DMChannel;

  if (!isDM && !isThread) {
    // Guild channel message — create a thread
    try {
      const threadTitle = truncateTitle(msg.content) || "Claude session";
      const thread = await (msg.channel as TextChannel).threads.create({
        name: `${threadTitle}`,
        startMessage: msg,
        autoArchiveDuration: 1440, // 24h
      });
      workChannel = thread;

      // Set typing indicator
      await thread.sendTyping();
    } catch (err) {
      console.error("[bot] failed to create thread:", err);
      workChannel = msg.channel as TextChannel;
    }
  } else {
    workChannel = msg.channel as TextChannel | ThreadChannel | DMChannel;
    try {
      await workChannel.sendTyping();
    } catch {
      // typing indicator not critical
    }
  }

  // Working reaction
  try {
    await msg.react("🔥");
  } catch {
    // no permission
  }

  // Send to Claude
  const workThreadId = workChannel.id;
  let responseText = "";

  try {
    const result = await sessions.sendMessage(
      workThreadId,
      prompt,
      (text) => {
        responseText += text;
      },
      (toolName, _input) => {
        // Optionally log tool usage — for now just accumulate
        console.log(`[bot] tool: ${toolName}`);
      },
    );

    // Remove working reaction, add done
    try {
      await msg.reactions.cache.get("🔥")?.users.remove(client.user!.id);
      await msg.react("✅");
    } catch {
      // reaction cleanup not critical
    }

    // Use streaming text (all assistant turns) — result.result only has last turn
    const finalText = responseText.trim() || result.result || "(no response)";
    const replyRef = workChannel.id === msg.channelId ? msg.id : undefined;
    await sendResponse(workChannel, finalText, access, replyRef);

    // Detect numbered options and offer Discord buttons
    const options = detectOptions(finalText);
    if (options) {
      buttons.askUser(
        workChannel,
        "Choose an option:",
        options,
      ).then(async (choice) => {
        if (choice === "timeout" || choice === "cancelled") return;
        // Send the chosen option as a new message to the same session
        const followUp = await sessions.sendMessage(
          workThreadId,
          choice,
          () => {},
        );
        const followUpText = followUp.result || "(no response)";
        await sendResponse(workChannel, followUpText, access);
      }).catch(console.error);
    }

    // Log cost
    if (result.cost > 0) {
      console.log(`[bot] session=${result.sessionId} cost=$${result.cost.toFixed(4)}`);
    }
  } catch (err) {
    console.error("[bot] error processing message:", err);

    try {
      await msg.reactions.cache.get("🔥")?.users.remove(client.user!.id);
    } catch { /* ignore */ }

    const errMsg = err instanceof Error ? err.message : String(err);
    const errReplyRef = workChannel.id === msg.channelId ? msg.id : undefined;
    await sendResponse(workChannel, `Error: ${errMsg}`, access, errReplyRef);
  }
});

// ── Button Interactions ──────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  buttons.handleInteraction(interaction);
});

// ── Graceful Shutdown ────────────────────────────────────────────

function shutdown() {
  console.log("[bot] shutting down...");
  buttons.cancelAll();
  sessions.close();
  store.close();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Health Check ──────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080", 10);
Bun.serve({
  port: PORT,
  fetch() {
    return new Response(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      sessions: sessions.listSessions().length,
    }), { headers: { "Content-Type": "application/json" } });
  },
});
console.log(`[bot] health check on :${PORT}`);

// ── Login ────────────────────────────────────────────────────────

console.log("[bot] starting...");
await client.login(token);
