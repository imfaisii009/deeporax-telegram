import type { ResponseParameters } from "@grammyjs/types";
import { redact, TelegramError } from "./errors.js";
import type { EventSink } from "./events.js";
import type { Pacer } from "./pacing.js";
import { buildBody } from "./payload.js";
import type { SafeStore } from "./store.js";

export interface RetryOptions {
  attempts: number;
  maxRetryAfterSec: number;
  onNetworkError: boolean;
}

export interface CallInit {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type Caller = (
  method: string,
  args?: Record<string, unknown>,
  init?: CallInit,
) => Promise<unknown>;

export interface RequestConfig {
  token: string;
  apiRoot: string;
  testEnvironment: boolean;
  fetch: typeof fetch;
  timeoutMs: number;
  retry: RetryOptions;
  pace: Pacer;
  emit: EventSink;
  store: SafeStore;
}

interface ApiResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: ResponseParameters;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) =>
  Math.min(10_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);

export function createCaller(config: RequestConfig): Caller {
  const { token, testEnvironment, retry, pace, emit, store } = config;
  const apiRoot = config.apiRoot.replace(/\/$/, "");
  // old chat id -> new id, or null when the store has no mapping (read once per process).
  const migrations = new Map<string, number | null>();

  const resolveChat = async (chatId: unknown): Promise<unknown> => {
    const key = String(chatId);
    if (!migrations.has(key)) {
      const stored = await store.get(`migrated:${key}`);
      const next = stored === null ? Number.NaN : Number(stored);
      migrations.set(key, Number.isFinite(next) ? next : null);
    }
    return migrations.get(key) ?? chatId;
  };

  return async (method, args, init) => {
    if (token === "") throw new TelegramError(method, 0, "bot token is not set");

    const url = `${apiRoot}/bot${token}${testEnvironment ? "/test" : ""}/${method}`;
    const startedAt = Date.now();
    let callArgs = args;
    if (callArgs?.chat_id !== undefined && callArgs.chat_id !== null) {
      callArgs = { ...callArgs, chat_id: await resolveChat(callArgs.chat_id) };
    }
    const chatId = callArgs?.chat_id as number | string | undefined;

    // Paced once per call: 429 waits and backoff already space the retries.
    await pace(method, chatId);

    let payload = await buildBody(callArgs, config.fetch);
    let migrated = false;
    const timeoutMs = init?.timeoutMs ?? config.timeoutMs;

    // Only the retry paths advance `attempt`; a migration replays the same one.
    for (let attempt = 1; attempt <= retry.attempts; ) {
      const hasMore = attempt < retry.attempts;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onAbort = () => controller.abort();
      if (init?.signal?.aborted) controller.abort();
      else init?.signal?.addEventListener("abort", onAbort, { once: true });

      let res: Response;
      let text: string;
      try {
        res = await config.fetch(url, {
          method: "POST",
          body: payload.body,
          headers: payload.headers,
          signal: controller.signal,
        });
        text = await res.text();
      } catch (err) {
        if (init?.signal?.aborted) throw new TelegramError(method, 0, "aborted");
        const description = timedOut
          ? `timed out after ${timeoutMs}ms`
          : `network error: ${redact(String((err as Error)?.message ?? err), token)}`;
        const error = new TelegramError(method, 0, description);
        if (retry.onNetworkError && hasMore) {
          emit({ type: "retry", method, attempt, error });
          await sleep(backoff(attempt));
          attempt++;
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        init?.signal?.removeEventListener("abort", onAbort);
      }

      let body: ApiResponse;
      try {
        body = JSON.parse(text) as ApiResponse;
      } catch {
        body = { ok: false, error_code: res.status, description: `HTTP ${res.status}` };
      }

      if (body.ok) {
        emit({ type: "request", method, chatId, ms: Date.now() - startedAt, attempt });
        return body.result;
      }

      const code = body.error_code ?? res.status;
      const description = body.description ?? `HTTP ${res.status}`;
      const error = new TelegramError(method, code, description, body.parameters);

      if (code === 429 && body.parameters?.retry_after !== undefined) {
        const wait = body.parameters.retry_after;
        if (wait <= retry.maxRetryAfterSec && hasMore) {
          emit({ type: "rate_limited", method, attempt, ms: wait * 1000, error });
          await sleep(wait * 1000);
          attempt++;
          continue;
        }
        throw error;
      }

      const newChatId = body.parameters?.migrate_to_chat_id;
      if (newChatId !== undefined && !migrated && chatId !== undefined) {
        migrated = true;
        await store.put(`migrated:${chatId}`, String(newChatId));
        migrations.set(String(chatId), newChatId);
        emit({ type: "migrated", method, chatId, error });
        payload = await buildBody({ ...callArgs, chat_id: newChatId }, config.fetch);
        callArgs = { ...callArgs, chat_id: newChatId };
        continue;
      }

      if (code >= 500 && hasMore) {
        emit({ type: "retry", method, attempt, error });
        await sleep(backoff(attempt));
        attempt++;
        continue;
      }
      throw error;
    }
    // Unreachable unless retry.attempts < 1.
    throw new TelegramError(method, 0, "no attempts configured");
  };
}
