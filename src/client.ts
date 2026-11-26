import type { CallbackQuery, Message } from "@grammyjs/types";
import { type Alert, type AlerterConfig, createAlerter } from "./alerter.js";
import { type Api, createApi } from "./api.js";
import { createEmitter, type EventSink } from "./events.js";
import { createPacer, DEFAULT_PACING, type PacingLimits } from "./pacing.js";
import {
  createPoll,
  createWebhook,
  type Poller,
  type PollOptions,
  type WebhookHandler,
  type WebhookOptions,
} from "./receive.js";
import { createCaller, type RetryOptions } from "./request.js";
import { createSend, type SendContent, type SendFn, type SendOptions } from "./send.js";
import { createSafeStore, memoryStore, type Store } from "./store.js";
import { createTopics, type Topics } from "./topics.js";

export interface TelegramOptions {
  token?: string;
  store?: Store;
  storePrefix?: string;
  apiRoot?: string;
  testEnvironment?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  pacing?: boolean | Partial<PacingLimits>;
  topics?: { ids?: Record<string, Record<string, number>> }; // chat id (as string) → topic name → thread id
  plainFallback?: boolean;
  onEvent?: EventSink;
}

export interface Telegram {
  readonly enabled: boolean;
  readonly api: Api;
  readonly topics: Topics;
  readonly send: SendFn;
  alerter<R extends string>(config: AlerterConfig<R>): Alert<R>;
  webhook(options: WebhookOptions): WebhookHandler;
  poll(options: PollOptions): Poller;
  answer(
    query: CallbackQuery,
    text?: string,
    options?: { showAlert?: boolean; url?: string },
  ): Promise<true>;
  reply(message: Message, content: SendContent, options?: SendOptions): Promise<Message[]>;
}

export function createTelegram(options: TelegramOptions = {}): Telegram {
  const token = (options.token ?? "").trim();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retry: RetryOptions = {
    attempts: 3,
    maxRetryAfterSec: 30,
    onNetworkError: true,
    ...options.retry,
  };
  const pacing: PacingLimits | false =
    options.pacing === false
      ? false
      : { ...DEFAULT_PACING, ...(typeof options.pacing === "object" ? options.pacing : {}) };

  if (!(timeoutMs > 0)) throw new RangeError("timeoutMs must be > 0");
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1) {
    throw new RangeError("retry.attempts must be an integer >= 1");
  }
  if (!(retry.maxRetryAfterSec >= 0)) throw new RangeError("retry.maxRetryAfterSec must be >= 0");
  if (pacing && !Object.values(pacing).every((limit) => limit > 0)) {
    throw new RangeError("pacing limits must be > 0");
  }

  const emit = createEmitter(options.onEvent);
  const store = createSafeStore(options.store ?? memoryStore(), options.storePrefix ?? "tg:", emit);
  const call = createCaller({
    token,
    apiRoot: options.apiRoot ?? "https://api.telegram.org",
    testEnvironment: options.testEnvironment ?? false,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    timeoutMs,
    retry,
    pace: createPacer(pacing),
    emit,
    store,
  });

  const api = createApi(call);
  const topics = createTopics({ api, store, emit, pinned: options.topics?.ids });

  const send = createSend({
    api,
    topics,
    emit,
    plainFallback: options.plainFallback ?? true,
  });

  const enabled = token !== "";
  const tg: Telegram = {
    enabled,
    api,
    topics,
    send,
    alerter: (config) => createAlerter({ enabled, send, store, emit }, config),
    webhook: (o) => createWebhook(tg, emit, o),
    poll: (o) => createPoll(tg, emit, o),
    answer: (query, text, o) =>
      api.answerCallbackQuery({
        callback_query_id: query.id,
        text,
        show_alert: o?.showAlert,
        url: o?.url,
      }),
    reply: (message, content, o) =>
      send(
        {
          chat: message.chat.id,
          topic: message.is_topic_message ? message.message_thread_id : undefined,
        },
        content,
        { ...o, replyTo: message.message_id },
      ),
  };
  return tg;
}
