import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename, extname } from "node:path";

// ── Constants ────────────────────────────────────────────────────

const WHISPER_MODEL_PATHS = [
  "/usr/local/share/whisper-cpp/models/ggml-small.bin",
  "/usr/local/share/whisper-cpp/models/ggml-base.bin",
  join(homedir(), ".cache/whisper-cpp/ggml-small.bin"),
  join(homedir(), ".cache/whisper-cpp/ggml-base.bin"),
];

type WhisperBackend = "whisper-cli" | "openai-whisper";

interface DetectedConfig {
  backend: WhisperBackend | null;
  modelPath: string | null;
  hasFfmpeg: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

async function which(cmd: string): Promise<boolean> {
  const proc = Bun.spawn(["which", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc.exitCode === 0;
}

async function runCommand(
  args: string[],
  opts: { cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function findModelPath(): string | null {
  for (const p of WHISPER_MODEL_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await Bun.file(path).exists() && Bun.spawn(["rm", "-f", path]);
  } catch {
    // best-effort cleanup
  }
}

// ── Transcriber ──────────────────────────────────────────────────

export class Transcriber {
  private config: DetectedConfig;
  private cache = new Map<string, string>();

  constructor() {
    this.config = { backend: null, modelPath: null, hasFfmpeg: false };
    // Detection runs async — callers check isAvailable() after awaiting init()
    // but we also kick off detection synchronously where Bun allows.
    // The real detection is done via the static factory or the lazy init below.
  }

  /** Async factory — prefer this over `new Transcriber()` when you need the
   *  instance ready immediately. */
  static async create(): Promise<Transcriber> {
    const t = new Transcriber();
    await t._detect();
    return t;
  }

  /** Lazy init — called automatically before first transcription if not yet
   *  initialised via the static factory. */
  private _detected = false;
  private async _detect(): Promise<void> {
    if (this._detected) return;
    this._detected = true;

    const [hasCliBackend, hasOpenAiBackend, hasFfmpeg] = await Promise.all([
      which("whisper-cli"),
      which("whisper"),
      which("ffmpeg"),
    ]);

    this.config.hasFfmpeg = hasFfmpeg;

    if (hasCliBackend) {
      const model = findModelPath();
      if (model) {
        this.config.backend = "whisper-cli";
        this.config.modelPath = model;
        console.log(`[transcriber] backend=whisper-cli model=${model} ffmpeg=${hasFfmpeg}`);
      } else {
        console.log("[transcriber] whisper-cli found but no model file — trying openai-whisper");
      }
    }

    if (!this.config.backend && hasOpenAiBackend) {
      this.config.backend = "openai-whisper";
      console.log(`[transcriber] backend=openai-whisper ffmpeg=${hasFfmpeg}`);
    }

    if (!this.config.backend) {
      console.log("[transcriber] no whisper binary found — transcription disabled");
    }
  }

  isAvailable(): boolean {
    return this.config.backend !== null;
  }

  async transcribe(audioPath: string): Promise<string | null> {
    await this._detect();

    if (!this.config.backend) return null;

    // Cache hit
    const cached = this.cache.get(audioPath);
    if (cached !== undefined) return cached || null;

    try {
      const result =
        this.config.backend === "whisper-cli"
          ? await this._transcribeWithCli(audioPath)
          : await this._transcribeWithOpenAi(audioPath);

      // Cache result (empty string means "tried but got nothing")
      this.cache.set(audioPath, result ?? "");
      return result;
    } catch (err) {
      console.log(`[transcriber] error transcribing ${audioPath}: ${err}`);
      this.cache.set(audioPath, "");
      return null;
    }
  }

  private async _transcribeWithCli(audioPath: string): Promise<string | null> {
    if (!this.config.modelPath) return null;

    const wavPath = join(tmpdir(), `whisper-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);

    try {
      // Convert to 16kHz mono WAV
      const ffmpegResult = await runCommand([
        "ffmpeg",
        "-y",
        "-i", audioPath,
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        wavPath,
      ]);

      if (ffmpegResult.exitCode !== 0) {
        console.log(`[transcriber] ffmpeg failed (exit ${ffmpegResult.exitCode}): ${ffmpegResult.stderr.trim()}`);
        return null;
      }

      const result = await runCommand([
        "whisper-cli",
        "-m", this.config.modelPath,
        "-f", wavPath,
        "--no-timestamps",
        "-l", "auto",
      ]);

      if (result.exitCode !== 0) {
        console.log(`[transcriber] whisper-cli failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
        return null;
      }

      return parseWhisperOutput(result.stdout);
    } finally {
      await removeTempFile(wavPath);
    }
  }

  private async _transcribeWithOpenAi(audioPath: string): Promise<string | null> {
    const outDir = tmpdir();
    const baseName = basename(audioPath, extname(audioPath));
    const txtPath = join(outDir, `${baseName}.txt`);

    try {
      const result = await runCommand([
        "whisper",
        audioPath,
        "--model", "small",
        "--output_format", "txt",
        "--output_dir", outDir,
      ]);

      if (result.exitCode !== 0) {
        console.log(`[transcriber] openai-whisper failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
        return null;
      }

      if (!existsSync(txtPath)) {
        console.log(`[transcriber] openai-whisper did not produce ${txtPath}`);
        return null;
      }

      const text = await Bun.file(txtPath).text();
      return text.trim() || null;
    } finally {
      await removeTempFile(txtPath);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ── Output parser ────────────────────────────────────────────────

/** Strip whisper-cpp timing tags like [00:00:00.000 --> 00:00:03.000] and
 *  collapse whitespace. */
function parseWhisperOutput(raw: string): string | null {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/\[[\d:.,\s>]+\]/g, "").trim())
    .filter(Boolean);
  const text = lines.join(" ").trim();
  return text || null;
}

// ── Exports ──────────────────────────────────────────────────────

export default Transcriber;
