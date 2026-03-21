// ── Access Control ──────────────────────────────────────────────

export type DmPolicy = "pairing" | "allowlist" | "disabled";

export interface GroupPolicy {
  requireMention: boolean;
  allowFrom: string[];
  respondInThreads?: boolean; // respond to all messages in threads (no mention needed)
  threadCwd?: string; // cwd for Claude sessions in threads (e.g. agent workspace)
}

export interface PendingEntry {
  senderId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
  type?: "dm" | "group";
  guildName?: string;
}

export interface Access {
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groups: Record<string, GroupPolicy>;
  pending: Record<string, PendingEntry>;
  mentionPatterns?: string[];
  ackReaction?: string;
  replyToMode?: "off" | "first" | "all";
  textChunkLimit?: number;
  chunkMode?: "length" | "newline";
  autoTranscribe?: boolean;
}

// ── Gate Result ─────────────────────────────────────────────────

export type GateResult =
  | { action: "deliver"; access: Access }
  | { action: "drop" }
  | { action: "pair"; code: string; isResend: boolean };

// ── Session ─────────────────────────────────────────────────────

export interface SessionInfo {
  sessionId: string;
  threadId: string;
  guildId?: string;
  cwd: string;
  createdAt: number;
  lastActivity: number;
  status: "active" | "idle" | "dead";
}

// ── Message Store ───────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  message_id: string;
  channel_id: string;
  user_id: string;
  username: string;
  display_name: string;
  text: string;
  media_type: string | null;
  caption: string | null;
  reply_to_msg_id: string | null;
  date: number;
  edit_date: number | null;
  is_outgoing: number;
  thread_id: string | null;
}

// ── Memory ──────────────────────────────────────────────────────

export interface MemoryEntry {
  date: string;
  content: string;
}

// ── Bot Config ──────────────────────────────────────────────────

export interface BotConfig {
  token: string;
  defaultCwd: string;
  idleTimeoutMs: number;
  maxSessionsPerGuild: number;
  allowedTools: string[];
  permissionMode: string;
}

// ── Attachment ──────────────────────────────────────────────────

export interface AttachmentInfo {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
  path?: string;
}
