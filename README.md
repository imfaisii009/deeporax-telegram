# @deeporax/telegram

A small Telegram Bot API client with no runtime dependencies. It uses only web APIs (`fetch`, `FormData`, `Blob`, `AbortSignal`, `crypto.subtle`), so the same code runs on Cloudflare Workers, Vercel Edge, Node 18+, Bun and Deno.

It covers the parts a server usually needs: sending messages (with splitting, retries and rate limits), named forum topics, de-duplicated alerts, HTML formatting, file uploads, and a webhook or long-polling receiver. Types for every Bot API method come from `@grammyjs/types`.

```sh
npm install @deeporax/telegram
```

## Quick start

```ts
import { createTelegram, html, b, button } from "@deeporax/telegram";

const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN });

// Raw API: every Bot API method, typed, one object argument as in Telegram's docs.
await tg.api.sendMessage({ chat_id: 12345, text: "hi" });

// High-level send: splits long text, resolves topics by name, retries, falls back to plain text.
await tg.send({ chat: 12345 }, html`${b("Deploy finished")} in ${12.4}s`, {
  silent: true,
  buttons: [[button.url("Open", "https://example.com")]],
});
```

A plain string passed to `send` is sent as plain text with no `parse_mode`, so user content cannot break parsing. Use `html` when you want markup.

If `token` is empty, the client is disabled: `tg.enabled` is `false`, alerts resolve with `{ ok: false, skipped: "disabled" }`, and `tg.api` and `tg.send` throw a `TelegramError` with code `0`.

`createTelegram` options: `token`, `store`, `storePrefix` (default `tg:`), `apiRoot` (for a self-hosted Bot API server), `testEnvironment`, `fetch`, `timeoutMs` (default 30000), `retry` (`attempts`, `maxRetryAfterSec`, `onNetworkError`), `pacing` (`true`, `false`, or custom limits), `topics.ids`, `plainFallback` and `onEvent`.

Retry behaviour:

- A 429 waits for `retry_after` and retries if it is at most `maxRetryAfterSec` (default 30).
- 5xx responses, network errors and timeouts back off exponentially, up to `attempts` (default 3). A timed-out send may already have been delivered, so a retry can duplicate a message. Set `retry: { onNetworkError: false }` to turn this off.
- A 400 with `migrate_to_chat_id` is retried once with the new chat id. The mapping is saved in the store and a `migrated` event is emitted.

## Recipes

### Cloudflare Workers

```ts
import { createTelegram, html } from "@deeporax/telegram";

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_CHAT_ID: string;
  TELEGRAM_KV: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const tg = createTelegram({ token: env.TELEGRAM_BOT_TOKEN, store: env.TELEGRAM_KV });
    const CHAT_ID = Number(env.TELEGRAM_CHAT_ID);
    const alert = tg.alerter<"errors" | "general">({
      chat: CHAT_ID,
      routes: { errors: { topic: "Errors" }, general: {} },
      dedupe: { windowSec: 600 },
      fallbackRoute: "general",
    });

    const url = new URL(request.url);
    if (url.pathname === "/telegram") {
      return tg.webhook({
        secret: env.TELEGRAM_WEBHOOK_SECRET,
        waitUntil: true, // acknowledge at once, handle in ctx.waitUntil
        onUpdate: async (update) => {
          if (update.message?.text === "/ping") await tg.reply(update.message, "pong");
        },
      })(request, env, ctx);
    }

    // alert() never throws, so its promise is safe to hand to waitUntil.
    ctx.waitUntil(alert("errors", html`Upstream 503`, { key: "503" }));
    return new Response("ok");
  },
};
```

The Workers `KVNamespace` is accepted as a `store` as is. You can also write `export default { fetch: tg.webhook({ ... }) }` when the Worker only receives updates.

### Next.js route handler

```ts
// app/api/telegram/route.ts
import { createTelegram } from "@deeporax/telegram";

const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN });

export const POST = tg.webhook({
  secret: process.env.TELEGRAM_WEBHOOK_SECRET,
  onUpdate: async (update) => {
    if (update.message?.text) await tg.reply(update.message, `You said: ${update.message.text}`);
  },
});
```

The handler takes a standard `Request` and returns a `Response`. Next.js route handlers are called with a second argument, which the webhook ignores unless `waitUntil: true` is set.

### Node

```ts
import { createTelegram } from "@deeporax/telegram";

const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN });

const poller = tg.poll({
  allowedUpdates: ["message", "callback_query"],
  onUpdate: async (update) => {
    if (update.message) await tg.reply(update.message, "hello");
  },
});
poller.done.catch((error) => {
  console.error("polling stopped", error);
  process.exit(1);
});
process.on("SIGINT", () => poller.stop());
```

### Deno

```ts
import { createTelegram } from "npm:@deeporax/telegram";

const tg = createTelegram({ token: Deno.env.get("TELEGRAM_BOT_TOKEN") });
Deno.serve(
  tg.webhook({
    secret: Deno.env.get("TELEGRAM_WEBHOOK_SECRET"),
    onUpdate: async (update) => {
      if (update.message) await tg.reply(update.message, "hello from Deno");
    },
  }),
);
```

## Topics

Named forum topics are scoped per chat. `tg.send` resolves a topic name in this order: an id pinned in config, the in-memory cache, the store, then `createForumTopic` (the new id is written to the store).

```ts
import { createTelegram } from "@deeporax/telegram";

const CHAT = Number(process.env.TELEGRAM_CHAT_ID);
const tg = createTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  // Pin ids you already know, keyed by chat id then topic name.
  topics: { ids: { [CHAT]: { Errors: 123 } } },
});

const threadId = await tg.topics.ensure(CHAT, "Sign-ups", { iconColor: 0xfb6f5f });
await tg.send({ chat: CHAT, topic: "Sign-ups" }, "New sign-up");
await tg.send({ chat: CHAT, topic: threadId }, "A numeric id works too");

await tg.topics.rename(CHAT, "Sign-ups", "Sign-ups (prod)");
await tg.topics.close(CHAT, "Sign-ups (prod)");
```

`tg.topics` has `ensure`, `id` (resolve without creating), `rename`, `close`, `reopen`, `delete` and `forget` (drop from the cache and store only). Anything else, such as `editGeneralForumTopic`, is on `tg.api`.

Self-healing: if a send fails because the topic was deleted, the cached id is cleared, the topic is created again and the send is retried once. If the topic is closed, it is reopened and the send is retried once.

Creating topics in a supergroup needs the bot to be an admin with `can_manage_topics`. The error says so when it is missing.

**Cross-instance race.** The store has no compare-and-set. Two instances (for example two Worker isolates) that send to a new topic name at the same moment can each create a topic, leaving duplicates. Within one process this cannot happen. To avoid it across instances, do either of these:

- Pin the ids in `topics.ids`.
- Call `tg.topics.ensure()` for every topic name from a deploy step or a cron trigger, so the id is already stored before real traffic arrives.

## Alerts

`tg.alerter()` returns an `alert` function that routes by name, de-duplicates, and never throws.

```ts
import { createTelegram, html, code } from "@deeporax/telegram";

const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN });
const CHAT_ID = Number(process.env.TELEGRAM_CHAT_ID);

const alert = tg.alerter<"errors" | "signups" | "general">({
  chat: CHAT_ID,
  routes: {
    errors: { topic: "Errors", iconColor: 0xfb6f5f },
    signups: { topic: "Sign-ups", silent: true },
    general: {}, // no topic: the chat root or General
  },
  dedupe: { windowSec: 600 },
  fallbackRoute: "general", // used if a topic route fails after healing and retries
});

const result = await alert("errors", html`Upstream 503 on ${code("/api/pay")}`, {
  key: "503|/api/pay", // same key within windowSec is dropped
});
if (!result.ok) console.log(result.skipped ?? result.error);
```

Name the route union as the type argument when you set `fallbackRoute`, as above. Otherwise TypeScript infers the route names from `fallbackRoute` alone.

The result is `{ ok: true, messages }` or `{ ok: false, skipped?: "disabled" | "deduped", error? }`.

De-duplication checks an in-memory map first, then the store with a TTL. Eventually consistent stores such as Workers KV can let a burst across regions send twice. A failed send releases its key so the next alert can retry. Every final failure is reported through `onEvent` (or `console.warn` by default).

## Formatting

`` html`...` `` escapes every interpolated value. Nested `html` results and `raw(str)` pass through unescaped. `send` and `alert` recognise the result, set `parse_mode: "HTML"` and disable link previews (pass `preview: true` to keep them).

```ts
import {
  b,
  code,
  emoji,
  flag,
  html,
  i,
  kv,
  link,
  mention,
  plain,
  pre,
  progress,
  quote,
  raw,
  s,
  sparkline,
  spoiler,
  truncate,
  u,
} from "@deeporax/telegram";

const user = "<script>"; // escaped automatically
const text = html`${b("Report")} for ${user}: ${link("https://example.com", "details")}`;

const parts = [
  i("italic"),
  u("underline"),
  s("strike"),
  code("inline"),
  spoiler("secret"),
  pre("const a = 1;", "ts"),
  quote("a quote", { expandable: true }),
  mention(12345, "Sam"),
  emoji("5368324170671202286", "👍"),
  raw("<b>trusted</b>"),
];

const stats = kv({ Requests: "1 204", Errors: "3" }); // aligned lines in <code>
const bars = sparkline([3, 5, 2, 8, 6]); // ▃▅▁█▆
const bar = progress(7, 10); // █████████░ style bar, 10 cells by default
const where = `${flag("GB")} ${truncate("a very long message", 10)}`;
const stripped = plain(text); // tags removed, entities decoded
```

Text over 4,096 characters is split, preferring paragraph breaks, then lines, then words. The splitter is HTML-aware: a tag open at a cut is closed at the end of that chunk and reopened in the next. Buttons go on the last chunk and the reply reference on the first.

If Telegram rejects the HTML ("can't parse entities"), the chunk is resent as plain text and a `parse_fallback` event is emitted. Pass `plainFallback: false` to `createTelegram` or to a single `send` to turn this off.

Buttons: `button.url`, `button.callback` (throws if `callback_data` is over 64 UTF-8 bytes), `button.webApp`, `button.copy` and `button.loginUrl` build inline buttons, passed to `send` and `alert` as rows. `keyboard.reply`, `keyboard.remove` and `keyboard.forceReply` build the other markup types, sent through `reply_markup` on `tg.api`.

## Files

```ts
import { createTelegram, InputFile, html } from "@deeporax/telegram";

const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN });
const CHAT = 12345;

// Raw API with an upload: any InputFile in the arguments switches the request to multipart.
await tg.api.sendDocument({
  chat_id: CHAT,
  document: new InputFile(new TextEncoder().encode("a,b\n1,2\n"), "report.csv"),
});

// High-level send with media. A caption over 1,024 characters is cut and the rest follows as a reply.
await tg.send(CHAT, {
  type: "photo",
  file: InputFile.fromUrl("https://example.com/chart.png"),
  caption: html`<b>Chart</b>`,
});

// A string is passed to Telegram untouched, as a file_id or a URL it can fetch itself.
await tg.send(CHAT, { type: "document", file: "BQACAgIAAxkBAAI..." });

// Albums take 2 to 10 items and no buttons.
await tg.send(CHAT, {
  type: "album",
  items: [
    { type: "photo", file: "https://example.com/1.jpg" },
    { type: "photo", file: "https://example.com/2.jpg", caption: "second" },
  ],
});
```

`new InputFile(data, filename?)` takes a `Blob`, `Uint8Array`, `ArrayBuffer` or `ReadableStream`. `InputFile.fromUrl(url)` downloads the file and uploads it, for URLs Telegram cannot reach. Media kinds are `photo`, `document`, `video`, `audio`, `animation` and `voice`.

## Webhooks and polling

```ts
import { createTelegram } from "@deeporax/telegram";

const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN });

// Webhook: (request, ...rest) => Promise<Response>
const handler = tg.webhook({
  secret: process.env.TELEGRAM_WEBHOOK_SECRET, // [A-Za-z0-9_-], 1-256 chars
  onUpdate: async (update, tg) => {
    if (update.callback_query) await tg.answer(update.callback_query, "Done");
  },
  onError: (error, update) => console.error("handler failed", update?.update_id, error),
});

// Polling: for local development and long-running processes.
const poller = tg.poll({
  deleteWebhook: true,
  onUpdate: async (update) => console.log(update.update_id),
});
poller.done.catch((error) => console.error("polling stopped", error));
poller.stop();
```

Webhook behaviour:

- Only POST is accepted (405 otherwise). The `X-Telegram-Bot-Api-Secret-Token` header is compared in constant time (401 on mismatch). A body that is not JSON gets 400.
- **The handler returns 200 even when your `onUpdate` throws.** Telegram retries non-2xx responses, so a failing handler would otherwise cause a retry storm. The error goes to `onError` if you gave one, otherwise to the `error` event.
- With no `secret`, the webhook logs a warning because anyone can post updates.
- `waitUntil` set to `true` uses the platform context passed as a later argument (`ctx` on Workers). Passing a function uses that instead. Either way the response is sent immediately and the update is handled in the background.

Polling behaviour:

- **`poll().done` rejects** when a webhook is set and you did not pass `deleteWebhook: true`, or when the token is bad (401 or 404). **Attach a `.catch` to it**, or Node treats the rejection as unhandled and may exit.
- Other polling errors are emitted as `error` events and retried after a short wait.
- `poller.stop()` or an aborted `signal` ends the loop and resolves `done`.
- Errors thrown by `onUpdate` go to `onError` or the `error` event, as with the webhook, and do not stop the loop.

Helpers: `tg.answer(callbackQuery, text?, { showAlert?, url? })` and `tg.reply(message, content, options?)`, which replies in the same chat and topic. Routing beyond this is not provided.

## Store adapters

A `Store` has the shape of Cloudflare KV, so a KV binding works directly:

```ts
interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  delete?(key: string): Promise<unknown>;
}
```

The store holds topic ids, de-dupe keys and chat migrations. Without one, `memoryStore()` is used, which is lost on restart. Keys are prefixed with `tg:` (change it with `storePrefix`). TTLs under 60 seconds are raised to 60.

### Upstash Redis

```ts
import { Redis } from "@upstash/redis";
import { createTelegram, type Store } from "@deeporax/telegram";

const redis = Redis.fromEnv();

const store: Store = {
  get: async (key) => (await redis.get<string>(key)) ?? null,
  put: (key, value, options) =>
    redis.set(key, value, options?.expirationTtl ? { ex: options.expirationTtl } : {}),
  delete: (key) => redis.del(key),
};

const tg = createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, store });
```

### Cloudflare D1

```ts
import { createTelegram, type Store } from "@deeporax/telegram";

// CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER);
export function d1Store(db: D1Database): Store {
  return {
    async get(key) {
      const row = await db
        .prepare("SELECT v FROM kv WHERE k = ? AND (exp IS NULL OR exp > ?)")
        .bind(key, Date.now())
        .first<{ v: string }>();
      return row?.v ?? null;
    },
    put: (key, value, options) =>
      db
        .prepare("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)")
        .bind(key, value, options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null)
        .run(),
    delete: (key) => db.prepare("DELETE FROM kv WHERE k = ?").bind(key).run(),
  };
}

export const make = (env: { DB: D1Database }) =>
  createTelegram({ token: "...", store: d1Store(env.DB) });
```

### JSON file

For one Node process only. Two processes writing the same file will overwrite each other.

```ts
import { readFile, writeFile } from "node:fs/promises";
import { createTelegram, type Store } from "@deeporax/telegram";

type Data = Record<string, { v: string; exp?: number }>;

function fileStore(path: string): Store {
  const load = async (): Promise<Data> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Data;
    } catch {
      return {};
    }
  };
  return {
    async get(key) {
      const hit = (await load())[key];
      return hit && (hit.exp === undefined || hit.exp > Date.now()) ? hit.v : null;
    },
    async put(key, value, options) {
      const data = await load();
      const exp = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined;
      data[key] = { v: value, exp };
      await writeFile(path, JSON.stringify(data));
    },
    async delete(key) {
      const data = await load();
      delete data[key];
      await writeFile(path, JSON.stringify(data));
    },
  };
}

const tg = createTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  store: fileStore("./tg-store.json"),
});
```

## Events

`onEvent` receives every notable thing the client does. It is for logging and metrics.

```ts
import { createTelegram, type TelegramEvent } from "@deeporax/telegram";

const tg = createTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  onEvent: (event: TelegramEvent) => {
    if (event.type === "retry" || event.type === "rate_limited") {
      console.log(event.type, event.method, event.attempt, event.ms);
    } else if (event.type === "error" || event.type === "dropped") {
      console.error(event.type, event.method, event.error?.message);
    }
  },
});
```

`type` is one of `request`, `retry`, `rate_limited`, `topic_created`, `topic_healed`, `migrated`, `parse_fallback`, `deduped`, `dropped` or `error`. Other fields (`method`, `chatId`, `threadId`, `ms`, `attempt`, `error`, `topic`, `key`, `detail`) are set when they apply. Without `onEvent`, only `error` and `dropped` are logged with `console.warn`. The bot token never appears in an event, a log line or an error message. A throwing hook is ignored.

Failed API calls throw `TelegramError` with `method`, `code`, `description`, and `retryAfter` or `migrateToChatId` when Telegram sent them.

Pacing is per process: private chats about 1 message per second, groups about 20 per minute, about 30 per second overall. Sends wait for a slot instead of failing. On Workers each isolate paces separately, and the 429 handling covers the rest.

## When to use grammY instead

This package is a client, not a bot framework. It has no middleware, sessions, conversations, command routing or plugin ecosystem. If you are building an interactive bot with many commands and multi-step flows, use [grammY](https://grammy.dev). If your service mostly sends messages (alerts, notifications, reports) and receives a few updates, this package is smaller and has no dependencies beyond types.

## Licence

MIT
