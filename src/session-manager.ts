import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import type { SessionInfo } from "./types.js";

const DB_PATH = join(homedir(), ".claude", "channels", "discord", "data", "messages.db");
const DB_DIR = join(homedir(), ".claude", "channels", "discord", "data");

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingMessage {
  prompt: string;
  onText: (text: string) => void;
  onToolUse?: (name: string, input: string) => void;
  resolve: (result: SendResult) => void;
  reject: (err: unknown) => void;
}

interface SendResult {
  result: string;
  sessionId: string;
  cost: number;
  killed?: boolean;
}

interface StreamJsonMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  event?: {
    type: string;
    index?: number;
    content_block?: {
      type: string;
      name?: string;
    };
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  };
  message?: {
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
  errors?: string[];
}

// ── SessionManager ───────────────────────────────────────────────────────────

// ── Account Switcher ─────────────────────────────────────────────────────────

const TOKENS_FILE = join(homedir(), ".claude-tokens.sh");

class AccountSwitcher {
  private tokens: string[] = [];
  private activeIndex = 0;

  constructor() {
    this.loadTokens();
  }

  private loadTokens(): void {
    if (!existsSync(TOKENS_FILE)) {
      console.log("[account-switcher] no tokens file, using env token only");
      const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (envToken) this.tokens = [envToken];
      return;
    }

    const content = readFileSync(TOKENS_FILE, "utf8");
    const matches = content.matchAll(/CLAUDE_TOKEN_\d+="([^"]+)"/g);
    for (const m of matches) {
      this.tokens.push(m[1]);
    }

    // Detect which token is currently active
    const current = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
    const idx = this.tokens.indexOf(current);
    if (idx >= 0) this.activeIndex = idx;

    console.log(`[account-switcher] loaded ${this.tokens.length} accounts, active: #${this.activeIndex + 1}`);
  }

  get currentToken(): string | undefined {
    return this.tokens[this.activeIndex];
  }

  get accountLabel(): string {
    return `#${this.activeIndex + 1}`;
  }

  switch(): boolean {
    if (this.tokens.length < 2) return false;
    this.activeIndex = (this.activeIndex + 1) % this.tokens.length;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = this.tokens[this.activeIndex];
    console.log(`[account-switcher] switched to account #${this.activeIndex + 1}`);
    return true;
  }

  isRateLimitError(errorText: string): boolean {
    const patterns = ["hit your limit", "rate limit", "Rate limit", "rate_limit", "usage limit", "too many requests"];
    return patterns.some(p => errorText.includes(p));
  }
}

// ── SessionManager ───────────────────────────────────────────────────────────

export class SessionManager {
  sessions: Map<string, SessionInfo> = new Map();

  private db: Database;
  private defaultCwd: string;
  private allowedTools: string[];
  private claudeBinary: string;
  private accountSwitcher: AccountSwitcher;

  // Per-thread queues: if a query is running, subsequent sends are queued
  private activeQueries: Map<string, boolean> = new Map();
  private messageQueues: Map<string, PendingMessage[]> = new Map();

  // Exposed subprocess references for kill support
  private activeProcesses: Map<string, ReturnType<typeof Bun.spawn>> = new Map();
  private killedThreads: Set<string> = new Set();

  constructor(defaultCwd: string, allowedTools: string[], claudeBinary = "claude") {
    this.defaultCwd = defaultCwd;
    this.allowedTools = allowedTools;
    this.claudeBinary = claudeBinary;
    this.accountSwitcher = new AccountSwitcher();

    mkdirSync(DB_DIR, { recursive: true });

    this.db = new Database(DB_PATH);
    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA synchronous = NORMAL`);
    this.db.exec(`PRAGMA busy_timeout = 5000`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        guild_id TEXT,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_activity INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `);

    this.loadSessions();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async sendMessage(
    threadId: string,
    prompt: string,
    onText: (text: string) => void,
    onToolUse?: (name: string, input: string) => void
  ): Promise<SendResult> {
    return new Promise<SendResult>((resolve, reject) => {
      const pending: PendingMessage = { prompt, onText, onToolUse, resolve, reject };

      if (this.activeQueries.get(threadId)) {
        const queue = this.messageQueues.get(threadId) ?? [];
        queue.push(pending);
        this.messageQueues.set(threadId, queue);
      } else {
        this.runQuery(threadId, pending);
      }
    });
  }

  getSession(threadId: string): SessionInfo | undefined {
    return this.sessions.get(threadId);
  }

  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  private cwdOverrides: Map<string, string> = new Map();

  setCwd(threadId: string, cwd: string): void {
    const info = this.sessions.get(threadId);
    if (info) {
      info.cwd = cwd;
      this.sessions.set(threadId, info);
      this.persistSession(info);
    } else {
      // Pre-set cwd for threads that don't have a session yet
      this.cwdOverrides.set(threadId, cwd);
    }
  }

  killSession(threadId: string): void {
    const info = this.sessions.get(threadId);
    if (info) {
      info.status = "dead";
      this.persistSession(info);
    }
    this.sessions.delete(threadId);
    console.log(`[session-manager] killed session for thread ${threadId}`);
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  cleanupIdle(maxIdleMs: number): string[] {
    const now = Date.now();
    const idled: string[] = [];

    for (const [threadId, info] of this.sessions) {
      const idleMs = now - info.lastActivity;
      if (idleMs > maxIdleMs && info.status === "active") {
        info.status = "idle";
        this.persistSession(info);
        idled.push(threadId);
      }
    }

    if (idled.length > 0) {
      console.log(`[session-manager] marked ${idled.length} sessions as idle: ${idled.join(", ")}`);
    }

    return idled;
  }

  getSessionId(threadId: string): string | undefined {
    return this.sessions.get(threadId)?.sessionId;
  }

  killQuery(threadId: string): boolean {
    const proc = this.activeProcesses.get(threadId);
    if (!proc) return false;
    this.killedThreads.add(threadId);
    proc.kill();
    this.activeProcesses.delete(threadId);
    return true;
  }

  close(): void {
    this.db.close();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private runQuery(threadId: string, pending: PendingMessage): void {
    this.activeQueries.set(threadId, true);

    this.executeQuery(threadId, pending)
      .then((result) => {
        // Check if result is a rate limit error — try switching account
        if (this.accountSwitcher.isRateLimitError(result.result)) {
          console.log(`[session-manager] rate limit on account ${this.accountSwitcher.accountLabel}, switching...`);
          if (this.accountSwitcher.switch()) {
            console.log(`[session-manager] retrying on account ${this.accountSwitcher.accountLabel}`);
            return this.executeQuery(threadId, pending, { skipResume: true });
          }
        }
        return result;
      })
      .catch((err) => {
        // Check if error message contains rate limit — retry on next account
        const errMsg = err instanceof Error ? err.message : String(err);
        if (this.accountSwitcher.isRateLimitError(errMsg)) {
          console.log(`[session-manager] rate limit error on account ${this.accountSwitcher.accountLabel}, switching...`);
          if (this.accountSwitcher.switch()) {
            console.log(`[session-manager] retrying on account ${this.accountSwitcher.accountLabel}`);
            return this.executeQuery(threadId, pending, { skipResume: true });
          }
        }
        throw err;
      })
      .then((result) => {
        pending.resolve(result);
      })
      .catch((err) => {
        pending.reject(err);
      })
      .finally(() => {
        this.activeQueries.set(threadId, false);
        this.drainQueue(threadId);
      });
  }

  private drainQueue(threadId: string): void {
    const queue = this.messageQueues.get(threadId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    if (queue.length === 0) {
      this.messageQueues.delete(threadId);
    }
    this.runQuery(threadId, next);
  }

  private async executeQuery(
    threadId: string,
    pending: PendingMessage,
    opts?: { skipResume?: boolean },
  ): Promise<SendResult> {
    const { prompt, onText, onToolUse } = pending;
    const existing = this.sessions.get(threadId);
    const cwd = existing?.cwd ?? this.cwdOverrides.get(threadId) ?? this.defaultCwd;
    this.cwdOverrides.delete(threadId); // consume once

    // Build claude CLI args
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--model", "claude-opus-4-6",
    ];

    // Resume existing session (skip on retry after account switch — session belongs to other account)
    if (existing?.sessionId && !opts?.skipResume) {
      args.push("--resume", existing.sessionId);
    }

    // Allowed tools
    if (this.allowedTools.length > 0) {
      args.push("--allowedTools", this.allowedTools.join(","));
    }

    // Disallowed tools
    args.push("--disallowedTools", "AskUserQuestion");

    let resolvedSessionId = existing?.sessionId ?? "";
    let totalCost = 0;
    let finalResult = "";

    try {
      const proc = Bun.spawn([this.claudeBinary, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
      this.activeProcesses.set(threadId, proc);

      // Read streaming JSON line by line
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let msg: StreamJsonMessage;
          try {
            msg = JSON.parse(trimmed);
          } catch {
            continue; // skip non-JSON lines
          }

          // System init — capture session ID
          if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
            resolvedSessionId = msg.session_id;
            const now = Date.now();
            const info: SessionInfo = {
              sessionId: resolvedSessionId,
              threadId,
              guildId: existing?.guildId,
              cwd,
              createdAt: existing?.createdAt ?? now,
              lastActivity: now,
              status: "active",
            };
            this.sessions.set(threadId, info);
            this.persistSession(info);
          }

          // Stream events — real-time text deltas
          if (msg.type === "stream_event" && msg.event) {
            const evt = msg.event;

            // Text streaming — word by word
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
              onText(evt.delta.text);
            }

            // Tool use start — show tool name
            if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use" && evt.content_block.name && onToolUse) {
              onToolUse(evt.content_block.name, "");
            }

            // Message stop — add separator between turns
            if (evt.type === "message_stop") {
              onText("\n\n");
            }
          }

          // Result — final message
          if (msg.type === "result") {
            if (msg.session_id) resolvedSessionId = msg.session_id;
            totalCost = msg.total_cost_usd ?? 0;
            finalResult = msg.result ?? "";

            const info = this.sessions.get(threadId);
            if (info) {
              info.sessionId = resolvedSessionId;
              info.lastActivity = Date.now();
              info.status = "active";
              this.sessions.set(threadId, info);
              this.persistSession(info);
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const msg: StreamJsonMessage = JSON.parse(buffer.trim());
          if (msg.type === "result") {
            if (msg.session_id) resolvedSessionId = msg.session_id;
            totalCost = msg.total_cost_usd ?? 0;
            finalResult = msg.result ?? "";
          }
        } catch {
          // ignore
        }
      }

      // Wait for process to exit
      this.activeProcesses.delete(threadId);
      const exitCode = await proc.exited;

      if (this.killedThreads.has(threadId)) {
        this.killedThreads.delete(threadId);
        return { result: finalResult, sessionId: resolvedSessionId, cost: totalCost, killed: true };
      }

      if (exitCode !== 0 && !finalResult) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`claude exited with code ${exitCode}: ${stderr.trim()}`);
      }

    } catch (err) {
      this.activeProcesses.delete(threadId);

      if (this.killedThreads.has(threadId)) {
        this.killedThreads.delete(threadId);
        return { result: finalResult, sessionId: resolvedSessionId, cost: totalCost, killed: true };
      }

      console.error(`[session-manager] query failed for thread ${threadId}:`, err);

      const info = this.sessions.get(threadId);
      if (info) {
        info.status = "dead";
        this.sessions.set(threadId, info);
        this.persistSession(info);
      }

      const message = err instanceof Error ? err.message : String(err);
      return {
        result: `Error: ${message}`,
        sessionId: resolvedSessionId,
        cost: totalCost,
      };
    }

    return { result: finalResult, sessionId: resolvedSessionId, cost: totalCost };
  }

  private persistSession(info: SessionInfo): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions
           (thread_id, session_id, guild_id, cwd, created_at, last_activity, status)
         VALUES
           ($thread_id, $session_id, $guild_id, $cwd, $created_at, $last_activity, $status)`
      )
      .run({
        $thread_id: info.threadId,
        $session_id: info.sessionId,
        $guild_id: info.guildId ?? null,
        $cwd: info.cwd,
        $created_at: info.createdAt,
        $last_activity: info.lastActivity,
        $status: info.status,
      });
  }

  private loadSessions(): void {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE status != 'dead'`)
      .all() as {
        thread_id: string;
        session_id: string;
        guild_id: string | null;
        cwd: string;
        created_at: number;
        last_activity: number;
        status: string;
      }[];

    for (const row of rows) {
      const info: SessionInfo = {
        sessionId: row.session_id,
        threadId: row.thread_id,
        guildId: row.guild_id ?? undefined,
        cwd: row.cwd,
        createdAt: row.created_at,
        lastActivity: row.last_activity,
        status: row.status as SessionInfo["status"],
      };
      this.sessions.set(row.thread_id, info);
    }

    console.log(`[session-manager] loaded ${this.sessions.size} sessions from DB`);
  }
}

export default SessionManager;
