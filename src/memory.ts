import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Constants ────────────────────────────────────────────────────

const BASE_DIR = path.join(
  os.homedir(),
  ".claude",
  "channels",
  "discord",
  "data",
  "memory",
);

const MAX_SIZE = 10_000;
const KEEP_SIZE = 5_000;
const MIN_CONTENT_LENGTH = 10;
const COMPRESSION_NOTICE =
  "... earlier entries compressed ...\n\n";

// ── Helpers ──────────────────────────────────────────────────────

function memoryPath(threadId: string): string {
  return path.join(BASE_DIR, `${threadId}.md`);
}

function formatEntry(content: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `## ${date} ${time}\n${content}\n\n`;
}

// ── MemoryManager ────────────────────────────────────────────────

export class MemoryManager {
  constructor() {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  }

  save(threadId: string, content: string): void {
    if (content.length < MIN_CONTENT_LENGTH) {
      return;
    }

    const filePath = memoryPath(threadId);
    const entry = formatEntry(content);
    fs.appendFileSync(filePath, entry, "utf8");

    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SIZE) {
      this.compress(threadId);
    }
  }

  load(threadId: string): string {
    const filePath = memoryPath(threadId);
    if (!fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  }

  clear(threadId: string): void {
    const filePath = memoryPath(threadId);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath);
    }
  }

  compress(threadId: string): void {
    const filePath = memoryPath(threadId);
    if (!fs.existsSync(filePath)) {
      return;
    }

    const content = fs.readFileSync(filePath, "utf8");
    if (content.length <= KEEP_SIZE) {
      return;
    }

    // Take the last KEEP_SIZE chars and trim to a clean line boundary
    let tail = content.slice(-KEEP_SIZE);
    const firstNewline = tail.indexOf("\n");
    if (firstNewline !== -1) {
      tail = tail.slice(firstNewline + 1);
    }

    const compressed = COMPRESSION_NOTICE + tail;
    fs.writeFileSync(filePath, compressed, "utf8");
  }

  exists(threadId: string): boolean {
    return fs.existsSync(memoryPath(threadId));
  }

  list(): string[] {
    if (!fs.existsSync(BASE_DIR)) {
      return [];
    }
    return fs
      .readdirSync(BASE_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3));
  }
}

export default MemoryManager;
