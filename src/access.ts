import { randomBytes } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
import type { Access, GateResult, GroupPolicy, PendingEntry } from "./types.js";

const CONFIG_PATH = join(homedir(), ".claude", "channels", "discord", "access.json");
const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_PENDING_DM = 3;

const DEFAULT_ACCESS: Access = {
  dmPolicy: "pairing",
  allowFrom: [],
  groups: {},
  pending: {},
  ackReaction: "eyes",
  replyToMode: "first",
  textChunkLimit: 2000,
  chunkMode: "newline",
  autoTranscribe: true,
};

export class AccessControl {
  constructor() {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    if (!existsSync(CONFIG_PATH)) {
      this.save(DEFAULT_ACCESS);
    }
  }

  load(): Access {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw) as Access;
      return { ...DEFAULT_ACCESS, ...parsed };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...DEFAULT_ACCESS };
      }
      // Corrupt — move aside and return defaults
      const corruptPath = CONFIG_PATH + `.corrupt-${Date.now()}`;
      try {
        renameSync(CONFIG_PATH, corruptPath);
      } catch {
        // ignore rename failure
      }
      return { ...DEFAULT_ACCESS };
    }
  }

  save(access: Access): void {
    const tmp = CONFIG_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(access, null, 2), { mode: 0o600 });
    renameSync(tmp, CONFIG_PATH);
  }

  gate(
    userId: string,
    channelId: string,
    isDM: boolean,
    guildId?: string,
    isThread?: boolean,
    parentChannelId?: string,
  ): GateResult {
    const access = this.load();

    // Clean expired entries first
    const now = Date.now();
    let dirty = false;
    for (const code of Object.keys(access.pending)) {
      if (access.pending[code].expiresAt <= now) {
        delete access.pending[code];
        dirty = true;
      }
    }
    if (dirty) {
      this.save(access);
    }

    if (access.dmPolicy === "disabled") {
      return { action: "drop" };
    }

    if (isDM) {
      // Allowlist check
      if (access.allowFrom.includes(userId)) {
        return { action: "deliver", access };
      }

      if (access.dmPolicy === "allowlist") {
        return { action: "drop" };
      }

      // dmPolicy === "pairing"
      // Check if there's already a pending code for this user
      for (const [code, entry] of Object.entries(access.pending)) {
        if (entry.senderId === userId && entry.chatId === userId && entry.expiresAt > now) {
          return { action: "pair", code, isResend: true };
        }
      }

      // Enforce max pending DM codes
      const dmPending = Object.values(access.pending).filter(
        (e) => e.type === "dm" || !e.type,
      );
      if (dmPending.length >= MAX_PENDING_DM) {
        return { action: "drop" };
      }

      const code = randomBytes(3).toString("hex");
      access.pending[code] = {
        senderId: userId,
        chatId: userId,
        createdAt: now,
        expiresAt: now + TTL_MS,
        replies: 0,
        type: "dm",
      };
      this.save(access);

      return { action: "pair", code, isResend: false };
    }

    // Guild message
    // Resolve effective channel (threads fall back to parent)
    const effectiveChannelId =
      isThread && parentChannelId ? parentChannelId : channelId;

    const policy = access.groups[effectiveChannelId];
    if (!policy) {
      return { action: "drop" };
    }

    // Per-channel allowFrom restriction
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(userId)) {
      return { action: "drop" };
    }

    return { action: "deliver", access };
  }

  approve(code: string): { senderId: string; chatId: string } | null {
    const access = this.load();
    const entry = access.pending[code];
    if (!entry || entry.expiresAt <= Date.now()) {
      return null;
    }

    delete access.pending[code];

    if (!access.allowFrom.includes(entry.senderId)) {
      access.allowFrom.push(entry.senderId);
    }

    this.save(access);
    return { senderId: entry.senderId, chatId: entry.chatId };
  }

  deny(code: string): boolean {
    const access = this.load();
    if (!(code in access.pending)) {
      return false;
    }
    delete access.pending[code];
    this.save(access);
    return true;
  }

  addUser(userId: string): void {
    const access = this.load();
    if (!access.allowFrom.includes(userId)) {
      access.allowFrom.push(userId);
      this.save(access);
    }
  }

  removeUser(userId: string): void {
    const access = this.load();
    const idx = access.allowFrom.indexOf(userId);
    if (idx !== -1) {
      access.allowFrom.splice(idx, 1);
      this.save(access);
    }
  }

  addChannel(channelId: string, policy?: Partial<GroupPolicy>): void {
    const access = this.load();
    access.groups[channelId] = {
      requireMention: true,
      allowFrom: [],
      ...policy,
    };
    this.save(access);
  }

  removeChannel(channelId: string): void {
    const access = this.load();
    delete access.groups[channelId];
    this.save(access);
  }

  getPending(): Record<string, PendingEntry> {
    const access = this.load();
    return access.pending;
  }

  isAllowed(userId: string): boolean {
    const access = this.load();
    return access.allowFrom.includes(userId);
  }
}

export default AccessControl;
