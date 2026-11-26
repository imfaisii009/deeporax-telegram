import type { Update } from "@grammyjs/types";
import type { Telegram } from "./client.js";
import { TelegramError } from "./errors.js";
import type { EventSink } from "./events.js";
import { sleep } from "./pacing.js";

export interface WebhookOptions {
  secret?: string;
  onUpdate(update: Update, tg: Telegram): unknown;
  onError?(error: unknown, update?: Update): void;
  waitUntil?: boolean | ((promise: Promise<unknown>) => void);
}
export type WebhookHandler = (request: Request, ...rest: unknown[]) => Promise<Response>;
export interface PollOptions {
  onUpdate(update: Update, tg: Telegram): unknown;
  onError?(error: unknown, update?: Update): void;
  allowedUpdates?: ReadonlyArray<Exclude<keyof Update, "update_id">>;
  signal?: AbortSignal;
  deleteWebhook?: boolean;
}
export interface Poller {
  stop(): void;
  done: Promise<void>;
}

const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;
const enc = new TextEncoder();

// Hash first so the compare is constant-time regardless of length.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all(
    [a, b].map(async (v) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v)))),
  );
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= (x?.[i] ?? 0) ^ (y?.[i] ?? 0);
  return diff === 0;
}

// Runs one handler; never rejects, so one bad update can't stop the rest.
function handle(
  tg: Telegram,
  emit: EventSink,
  options: { onUpdate: PollOptions["onUpdate"]; onError?: PollOptions["onError"] },
  update: Update,
  detail: string,
): Promise<void> {
  return (async () => {
    try {
      await options.onUpdate(update, tg);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      try {
        if (options.onError) options.onError(e, update);
        else emit({ type: "error", detail, error });
      } catch {
        // A throwing onError must not escape either.
      }
    }
  })();
}

export function createWebhook(
  tg: Telegram,
  emit: EventSink,
  options: WebhookOptions,
): WebhookHandler {
  const { secret, waitUntil } = options;
  if (secret !== undefined && !SECRET_RE.test(secret)) {
    throw new TypeError("webhook secret must match ^[A-Za-z0-9_-]{1,256}$");
  }
  if (secret === undefined)
    console.warn("[telegram] webhook has no secret; anyone can post updates");

  return async (request, ...rest) => {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (
      secret !== undefined &&
      !(await safeEqual(secret, request.headers.get("x-telegram-bot-api-secret-token") ?? ""))
    ) {
      return new Response("unauthorized", { status: 401 });
    }
    let update: Update;
    try {
      update = (await request.json()) as Update;
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const run = () => handle(tg, emit, options, update, "webhook handler");
    if (typeof waitUntil === "function") {
      waitUntil(run());
    } else if (waitUntil === true) {
      // Workers pass ctx as the third fetch argument; call as a method to keep `this`.
      const ctx = rest.find(
        (r): r is { waitUntil(p: Promise<unknown>): void } =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as { waitUntil?: unknown }).waitUntil === "function",
      );
      if (ctx) ctx.waitUntil(run());
      else await run();
    } else {
      await run();
    }
    return new Response("ok", { status: 200 });
  };
}

export function createPoll(tg: Telegram, emit: EventSink, options: PollOptions): Poller {
  const controller = new AbortController();
  const { signal } = controller;
  const stop = () => controller.abort();
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();

  const loop = async (): Promise<void> => {
    if (signal.aborted) return;
    try {
      const info = await tg.api.getWebhookInfo(undefined, { signal });
      if (info.url) {
        if (!options.deleteWebhook) {
          throw new TelegramError(
            "poll",
            0,
            "a webhook is set; pass deleteWebhook: true to switch to polling",
          );
        }
        await tg.api.deleteWebhook(undefined, { signal });
      }
    } catch (e) {
      if (signal.aborted) return;
      throw e;
    }

    let offset: number | undefined;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await tg.api.getUpdates(
          {
            ...(offset === undefined ? {} : { offset }),
            timeout: 30,
            allowed_updates: options.allowedUpdates as Exclude<keyof Update, "update_id">[],
          },
          { signal, timeoutMs: 40_000 },
        );
      } catch (e) {
        if (signal.aborted) return;
        // A bad token can't recover by retrying.
        if (e instanceof TelegramError && (e.code === 401 || e.code === 404)) throw e;
        emit({
          type: "error",
          method: "getUpdates",
          error: e instanceof Error ? e : new Error(String(e)),
        });
        // ponytail: fixed 5s back-off on poll errors; exponential if a flapping network makes this noisy
        try {
          await sleep(5000, signal);
        } catch {
          return;
        }
        continue;
      }
      // Whole batch is handled even if stop() lands mid-way, so no update is half-seen.
      for (const update of updates) {
        await handle(tg, emit, options, update, "poll handler");
        offset = update.update_id + 1;
      }
    }
  };

  const done = loop().finally(() => options.signal?.removeEventListener("abort", stop));
  return { stop, done };
}
