import * as crypto from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type TextChannel,
  type ThreadChannel,
  type DMChannel,
  type Message,
  type ButtonInteraction,
} from "discord.js";

// ── Constants ────────────────────────────────────────────────────

const BUTTONS_PER_ROW = 5;
const MAX_BUTTONS = 25;

// ── Helpers ──────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

function buildRows(
  options: string[],
  callbackId: string,
  disabled = false,
  selectedIndex = -1,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < options.length; i += BUTTONS_PER_ROW) {
    const slice = options.slice(i, i + BUTTONS_PER_ROW);
    const row = new ActionRowBuilder<ButtonBuilder>();

    for (let j = 0; j < slice.length; j++) {
      const index = i + j;
      const isSelected = index === selectedIndex;

      const button = new ButtonBuilder()
        .setCustomId(`ask:${callbackId}:${index}`)
        .setLabel(slice[j])
        .setStyle(isSelected ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled);

      row.addComponents(button);
    }

    rows.push(row);
  }

  return rows;
}

// ── Types ────────────────────────────────────────────────────────

interface PendingCallback {
  resolve: (value: string) => void;
  timer: ReturnType<typeof setTimeout>;
  options: string[];
  messageId: string;
}

// ── ButtonManager ────────────────────────────────────────────────

export class ButtonManager {
  private pending: Map<string, PendingCallback>;

  constructor() {
    this.pending = new Map();
  }

  async askUser(
    channel: TextChannel | ThreadChannel | DMChannel,
    question: string,
    options: string[],
    timeoutMs = 120_000,
  ): Promise<string> {
    const capped = options.slice(0, MAX_BUTTONS);
    const callbackId = randomHex(4);
    const rows = buildRows(capped, callbackId);

    const message = await channel.send({
      content: question,
      components: rows,
    }) as Message;

    return new Promise<string>((resolve) => {
      const timer = setTimeout(async () => {
        this.pending.delete(callbackId);

        const disabledRows = buildRows(capped, callbackId, true);
        await message.edit({
          content: `${question} (timed out)`,
          components: disabledRows,
        }).catch(() => undefined);

        resolve("timeout");
      }, timeoutMs);

      this.pending.set(callbackId, {
        resolve,
        timer,
        options: capped,
        messageId: message.id,
      });
    });
  }

  handleInteraction(interaction: ButtonInteraction): boolean {
    const { customId } = interaction;
    if (!customId.startsWith("ask:")) {
      return false;
    }

    const parts = customId.split(":");
    // format: ask:<callbackId>:<index>
    if (parts.length !== 3) {
      return false;
    }

    const [, callbackId, rawIndex] = parts;
    const index = parseInt(rawIndex, 10);

    const entry = this.pending.get(callbackId);
    if (!entry) {
      return false;
    }

    const label = entry.options[index] ?? "unknown";

    clearTimeout(entry.timer);
    this.pending.delete(callbackId);

    const disabledRows = buildRows(entry.options, callbackId, true, index);
    interaction
      .update({
        content: `${interaction.message.content}\n> Selected: **${label}**`,
        components: disabledRows,
      })
      .catch(() => undefined);

    entry.resolve(label);
    return true;
  }

  cancelAll(): void {
    for (const [callbackId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve("cancelled");
      this.pending.delete(callbackId);
    }
  }
}

export default ButtonManager;
