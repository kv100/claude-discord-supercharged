import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { StoredMessage } from "./types.js";

const DB_PATH = join(homedir(), ".claude", "channels", "discord", "data", "messages.db");
const DB_DIR = join(homedir(), ".claude", "channels", "discord", "data");

const MAX_PER_CHANNEL = 500;
const TTL_DAYS = 14;
const MAX_DB_BYTES = 50 * 1024 * 1024;

export class MessageStore {
  private db: Database;

  private storeStmt: ReturnType<Database["prepare"]>;
  private getHistoryStmt: ReturnType<Database["prepare"]>;
  private getHistoryBeforeStmt: ReturnType<Database["prepare"]>;
  private searchStmt: ReturnType<Database["prepare"]>;
  private clearStmt: ReturnType<Database["prepare"]>;

  constructor() {
    mkdirSync(DB_DIR, { recursive: true });

    this.db = new Database(DB_PATH);

    this.db.exec(`PRAGMA journal_mode = WAL`);
    this.db.exec(`PRAGMA synchronous = NORMAL`);
    this.db.exec(`PRAGMA cache_size = -16384`);
    this.db.exec(`PRAGMA busy_timeout = 5000`);
    this.db.exec(`PRAGMA foreign_keys = ON`);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        media_type TEXT,
        caption TEXT,
        reply_to_msg_id TEXT,
        date INTEGER NOT NULL,
        edit_date INTEGER,
        is_outgoing INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT,
        UNIQUE(message_id, channel_id)
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel_date ON messages (channel_id, date DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_channel_reply ON messages (channel_id, reply_to_msg_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_date ON messages (date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (channel_id, thread_id)`);

    this.storeStmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages
        (message_id, channel_id, user_id, username, display_name, text, media_type, caption, reply_to_msg_id, date, edit_date, is_outgoing, thread_id)
      VALUES
        ($message_id, $channel_id, $user_id, $username, $display_name, $text, $media_type, $caption, $reply_to_msg_id, $date, $edit_date, $is_outgoing, $thread_id)
    `);

    this.getHistoryStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel_id = $channel_id
      ORDER BY date DESC
      LIMIT $limit
    `);

    this.getHistoryBeforeStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel_id = $channel_id AND date < $before
      ORDER BY date DESC
      LIMIT $limit
    `);

    this.searchStmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE channel_id = $channel_id AND text LIKE $query ESCAPE '\\'
      ORDER BY date ASC
      LIMIT $limit
    `);

    this.clearStmt = this.db.prepare(`
      DELETE FROM messages WHERE channel_id = $channel_id
    `);
  }

  store(msg: {
    message_id: string;
    channel_id: string;
    user_id: string;
    username: string;
    display_name: string;
    text: string;
    media_type?: string;
    caption?: string;
    reply_to_msg_id?: string;
    date: number;
    edit_date?: number;
    is_outgoing?: boolean;
    thread_id?: string;
  }): void {
    this.storeStmt.run({
      $message_id: msg.message_id,
      $channel_id: msg.channel_id,
      $user_id: msg.user_id,
      $username: msg.username,
      $display_name: msg.display_name,
      $text: msg.text,
      $media_type: msg.media_type ?? null,
      $caption: msg.caption ?? null,
      $reply_to_msg_id: msg.reply_to_msg_id ?? null,
      $date: msg.date,
      $edit_date: msg.edit_date ?? null,
      $is_outgoing: msg.is_outgoing ? 1 : 0,
      $thread_id: msg.thread_id ?? null,
    });
  }

  getHistory(channelId: string, limit = 50, before?: number): StoredMessage[] {
    const cap = Math.min(limit, 200);
    if (before !== undefined) {
      return this.getHistoryBeforeStmt.all({
        $channel_id: channelId,
        $before: before,
        $limit: cap,
      }) as StoredMessage[];
    }
    return this.getHistoryStmt.all({
      $channel_id: channelId,
      $limit: cap,
    }) as StoredMessage[];
  }

  search(channelId: string, query: string, limit = 20): StoredMessage[] {
    const cap = Math.min(limit, 100);
    const escaped = query.replace(/[%_\\]/g, (c) => `\\${c}`);
    return this.searchStmt.all({
      $channel_id: channelId,
      $query: `%${escaped}%`,
      $limit: cap,
    }) as StoredMessage[];
  }

  formatRecent(channelId: string, count = 5): string {
    const msgs = this.getHistory(channelId, count).reverse();
    if (msgs.length === 0) return "";
    return msgs
      .map((m) => `[${new Date(m.date * 1000).toISOString()}] @${m.username}: ${m.text}`)
      .join("\n");
  }

  clearHistory(channelId: string): number {
    const result = this.clearStmt.run({ $channel_id: channelId });
    return result.changes;
  }

  prune(): void {
    const cutoff = Math.floor(Date.now() / 1000) - TTL_DAYS * 86400;
    this.db.exec(`DELETE FROM messages WHERE date < ${cutoff}`);

    const channels = this.db
      .prepare(`SELECT DISTINCT channel_id FROM messages`)
      .all() as { channel_id: string }[];

    for (const { channel_id } of channels) {
      const cutoffRow = this.db
        .prepare(
          `SELECT date FROM messages WHERE channel_id = ? ORDER BY date DESC LIMIT 1 OFFSET ${MAX_PER_CHANNEL - 1}`
        )
        .get(channel_id) as { date: number } | undefined;

      if (cutoffRow) {
        this.db.exec(
          `DELETE FROM messages WHERE channel_id = '${channel_id.replace(/'/g, "''")}' AND date < ${cutoffRow.date}`
        );
      }
    }

    const sizeRow = this.db
      .prepare(`SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`)
      .get() as { size: number } | undefined;

    if (sizeRow && sizeRow.size > MAX_DB_BYTES) {
      this.db.exec(`
        DELETE FROM messages WHERE id IN (
          SELECT id FROM messages ORDER BY date ASC LIMIT 1000
        )
      `);
      this.db.exec(`VACUUM`);
    }
  }

  close(): void {
    this.db.close();
  }
}

export default MessageStore;
