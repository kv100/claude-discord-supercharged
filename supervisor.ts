import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";

const DATA_DIR = join(homedir(), ".claude", "channels", "discord", "data");
const SIGNAL_FILE = join(DATA_DIR, "restart.signal");

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;
const STABLE_THRESHOLD = 60_000;
const SIGNAL_POLL_INTERVAL = 500;
const GRACEFUL_SHUTDOWN_TIMEOUT = 5000;

class Supervisor {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private backoff = MIN_BACKOFF;
  private startedAt = 0;
  private shuttingDown = false;
  private signalPollTimer: ReturnType<typeof setInterval> | null = null;
  private extraArgs: string[];

  constructor(extraArgs: string[]) {
    this.extraArgs = extraArgs;
    mkdirSync(DATA_DIR, { recursive: true });
  }

  start(): void {
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));

    this.startBot();

    this.signalPollTimer = setInterval(() => {
      this.handleRestartSignal();
    }, SIGNAL_POLL_INTERVAL);
  }

  private startBot(): void {
    if (this.shuttingDown) return;

    console.log("[supervisor] starting bot process");

    this.startedAt = Date.now();

    this.child = Bun.spawn(["bun", "src/bot.ts", ...this.extraArgs], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    this.child.exited.then((exitCode) => {
      if (this.shuttingDown) return;

      const uptime = Date.now() - this.startedAt;

      if (uptime >= STABLE_THRESHOLD) {
        console.log(
          `[supervisor] bot ran for ${uptime}ms — resetting backoff to ${MIN_BACKOFF}ms`
        );
        this.backoff = MIN_BACKOFF;
      }

      console.log(
        `[supervisor] bot exited with code ${exitCode}, restarting in ${this.backoff}ms`
      );

      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);

      setTimeout(() => {
        this.startBot();
      }, delay);
    });
  }

  private async killChild(
    signal: string = "SIGTERM",
    timeoutMs: number = GRACEFUL_SHUTDOWN_TIMEOUT
  ): Promise<void> {
    if (!this.child) return;

    const child = this.child;

    try {
      child.kill(signal as NodeJS.Signals);
    } catch {
      // process may already be dead
    }

    const raceResult = await Promise.race([
      child.exited.then(() => "exited"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), timeoutMs)
      ),
    ]);

    if (raceResult === "timeout") {
      console.log("[supervisor] graceful shutdown timed out — sending SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
      await child.exited;
    }

    this.child = null;
  }

  private async handleRestartSignal(): Promise<void> {
    if (!existsSync(SIGNAL_FILE)) return;

    let delay = 0;
    try {
      const contents = readFileSync(SIGNAL_FILE, "utf8").trim();
      const parsed = parseInt(contents, 10);
      if (!isNaN(parsed) && parsed > 0) {
        delay = parsed;
      }
    } catch {
      // unreadable — treat as zero delay
    }

    try {
      unlinkSync(SIGNAL_FILE);
    } catch {
      // already gone — another handler beat us
      return;
    }

    console.log(
      `[supervisor] restart signal received — delay ${delay}ms, killing child`
    );

    await this.killChild("SIGTERM", GRACEFUL_SHUTDOWN_TIMEOUT);

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    this.startBot();
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    console.log(`[supervisor] shutting down (${reason})`);

    if (this.signalPollTimer !== null) {
      clearInterval(this.signalPollTimer);
      this.signalPollTimer = null;
    }

    await this.killChild("SIGTERM", GRACEFUL_SHUTDOWN_TIMEOUT);

    process.exit(0);
  }
}

const supervisor = new Supervisor(process.argv.slice(2));
supervisor.start();
