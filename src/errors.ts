import type { ResponseParameters } from "@grammyjs/types";

export class TelegramError extends Error {
  override readonly name = "TelegramError";
  readonly method: string;
  /** Telegram error_code; 0 = local failure (disabled, network, timeout, aborted). */
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;
  readonly migrateToChatId?: number;

  constructor(method: string, code: number, description: string, parameters?: ResponseParameters) {
    super(`${method}: ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.retryAfter = parameters?.retry_after;
    this.migrateToChatId = parameters?.migrate_to_chat_id;
  }
}

export function redact(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("***");
}
