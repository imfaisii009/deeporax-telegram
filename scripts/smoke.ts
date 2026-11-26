// Live smoke test against a real forum supergroup. Needs TELEGRAM_SMOKE_BOT_TOKEN and
// TELEGRAM_SMOKE_CHAT_ID (Bun loads .env). S11, S14 and S15 run offline; the rest skip without both.
import {
  createTelegram,
  InputFile,
  memoryStore,
  plain,
  raw,
  type Store,
  TelegramError,
  type TelegramEvent,
} from "../src/index.ts";

const TOKEN = process.env.TELEGRAM_SMOKE_BOT_TOKEN ?? "";
const CHAT_ENV = process.env.TELEGRAM_SMOKE_CHAT_ID ?? "";
const live = /^\d+:[A-Za-z0-9_-]{30,}$/.test(TOKEN) && CHAT_ENV !== "";
const CHAT: number | string = /^-?\d+$/.test(CHAT_ENV) ? Number(CHAT_ENV) : CHAT_ENV;
const RUN = `smoke-${Date.now()}`;

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

// Tiny valid 1x1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);
const IMAGE_URL =
  "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png";

const events: TelegramEvent[] = [];
const threads = new Set<number>(); // every thread id this run touched, for cleanup
const onEvent = (e: TelegramEvent) => {
  events.push(e);
  if (e.threadId !== undefined) threads.add(e.threadId);
};
const eventsSince = (mark: number, type: TelegramEvent["type"]) =>
  events.slice(mark).filter((e) => e.type === type);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const track = <T extends { message_thread_id?: number }>(msgs: T[]): T[] => {
  for (const m of msgs) if (m.message_thread_id !== undefined) threads.add(m.message_thread_id);
  return msgs;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
let skipped = 0;
async function check(id: string, name: string, needsLive: boolean, fn: () => Promise<void>) {
  if (needsLive && !live) {
    skipped++;
    console.log(`SKIP ${id} ${name}: no TELEGRAM_SMOKE_BOT_TOKEN/TELEGRAM_SMOKE_CHAT_ID`);
    return;
  }
  try {
    await fn();
    passed++;
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${id} ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const tg = createTelegram({ token: TOKEN, onEvent });
const nameA = `A-${RUN}`;
const nameB = `B-${RUN}`;

try {
  await check("S1", "getChat is a forum", true, async () => {
    const chat = await tg.api.getChat({ chat_id: CHAT });
    assert("is_forum" in chat && chat.is_forum === true, "chat is not a forum");
  });

  await check("S2", "topics.ensure is idempotent", true, async () => {
    const mark = events.length;
    const a = await tg.topics.ensure(CHAT, nameA, { iconColor: 0xfb6f5f });
    const b = await tg.topics.ensure(CHAT, nameA, { iconColor: 0xfb6f5f });
    threads.add(a);
    assert(a === b, `ids differ: ${a} vs ${b}`);
    assert(eventsSince(mark, "topic_created").length === 1, "expected exactly one topic_created");
  });

  await check("S3", "send heals a deleted topic", true, async () => {
    const mark = events.length;
    const oldId = await tg.topics.id(CHAT, nameA);
    assert(oldId !== undefined, "topic A missing");
    await tg.api.deleteForumTopic({ chat_id: CHAT, message_thread_id: oldId });
    const msgs = track(await tg.send({ chat: CHAT, topic: nameA }, "after delete"));
    assert(msgs[0]?.message_thread_id !== oldId, "message landed in the old thread");
    const healed = eventsSince(mark, "topic_healed");
    assert(
      healed.some((e) => e.detail === "recreated"),
      "no topic_healed recreated",
    );
    console.log(`  S3 telegram said: ${healed[0]?.error?.message}`);
  });

  await check("S4", "pinned heal is shared through the store", true, async () => {
    const name = `P-${RUN}`;
    const created = await tg.api.createForumTopic({ chat_id: CHAT, name });
    threads.add(created.message_thread_id);
    const store = memoryStore();
    const mk = (sink: (e: TelegramEvent) => void) =>
      createTelegram({
        token: TOKEN,
        store,
        topics: { ids: { [String(CHAT)]: { [name]: created.message_thread_id } } },
        onEvent: (e) => {
          onEvent(e);
          sink(e);
        },
      });
    const ev1: TelegramEvent[] = [];
    const ev2: TelegramEvent[] = [];
    const c1 = mk((e) => ev1.push(e));
    const c2 = mk((e) => ev2.push(e));
    await c1.api.deleteForumTopic({ chat_id: CHAT, message_thread_id: created.message_thread_id });
    const m1 = track(await c1.send({ chat: CHAT, topic: name }, "pinned heal 1"));
    const m2 = track(await c2.send({ chat: CHAT, topic: name }, "pinned heal 2"));
    const heals = ev1.filter((e) => e.type === "topic_healed").length;
    assert(heals === 1, `client 1 healed ${heals} times`);
    assert(
      m2[0]?.message_thread_id === m1[0]?.message_thread_id,
      "client 2 did not use the healed thread",
    );
    assert(
      !ev2.some((e) => e.type === "topic_created" || e.type === "topic_healed"),
      "client 2 created or healed a topic",
    );
  });

  await check("S5", "10k Html splits within the limit", true, async () => {
    const nested = `<b>bold <i>${"alpha &amp; beta \u{1F600} ".repeat(150)}</i></b>`;
    const run = `<b>${"x".repeat(5000)}</b>`;
    const tail = `<i>${"\u{1F600}\u{1F680}".repeat(900)}</i>`;
    const content = raw(nested + run + tail);
    assert(plain(content).length >= 10_000, "fixture shorter than 10,000 characters");
    const msgs = track(await tg.send({ chat: CHAT, topic: nameA }, content));
    assert(msgs.length >= 3, `only ${msgs.length} messages`);
    // visibleLength is not public; the delivered text length is the same quantity.
    for (const m of msgs) assert((m.text?.length ?? 0) <= 4096, "a chunk exceeds 4,096");
  });

  await check("S6", "send reopens a closed topic", true, async () => {
    const mark = events.length;
    threads.add(await tg.topics.ensure(CHAT, nameB));
    await tg.topics.close(CHAT, nameB);
    track(await tg.send({ chat: CHAT, topic: nameB }, "after close"));
    const healed = eventsSince(mark, "topic_healed");
    assert(
      healed.some((e) => e.detail === "reopened"),
      "no topic_healed reopened",
    );
    console.log(
      `  S6 telegram said: ${healed.find((e) => e.detail === "reopened")?.error?.message}`,
    );
  });

  await check("S7", "album of URL and bytes photos", true, async () => {
    const msgs = track(
      await tg.send(
        { chat: CHAT, topic: nameA },
        {
          type: "album",
          items: [
            { type: "photo", file: InputFile.fromUrl(IMAGE_URL) },
            { type: "photo", file: new InputFile(PNG, "pixel.png") },
          ],
        },
      ),
    );
    assert(msgs.length === 2, `got ${msgs.length} messages`);
  });

  await check("S8", "document from bytes", true, async () => {
    const msgs = track(
      await tg.send(
        { chat: CHAT, topic: nameA },
        {
          type: "document",
          file: new InputFile(new TextEncoder().encode("a,b\n1,2"), "smoke.csv"),
        },
      ),
    );
    assert(msgs[0]?.document?.file_name === "smoke.csv", "file_name is not smoke.csv");
  });

  await check("S9", "broken HTML falls back to plain text", true, async () => {
    const mark = events.length;
    const msgs = track(await tg.send({ chat: CHAT, topic: nameA }, raw("<b>broken")));
    assert(msgs[0]?.text === "<b>broken", `text was ${JSON.stringify(msgs[0]?.text)}`);
    assert(eventsSince(mark, "parse_fallback").length === 1, "expected one parse_fallback");
  });

  await check("S10", "long photo caption overflows into a reply", true, async () => {
    const msgs = track(
      await tg.send(
        { chat: CHAT, topic: nameA },
        { type: "photo", file: new InputFile(PNG, "pixel.png"), caption: "word ".repeat(300) },
      ),
    );
    assert(msgs.length === 2, `got ${msgs.length} messages`);
    assert(
      msgs[1]?.reply_to_message?.message_id === msgs[0]?.message_id,
      "reply does not point at the photo",
    );
  });

  await check("S11", "network failure does not leak the token", false, async () => {
    const fake = `123456:${"A".repeat(35)}`;
    const mark = events.length;
    const c = createTelegram({
      token: fake,
      apiRoot: "http://127.0.0.1:9",
      retry: { attempts: 1 },
      onEvent,
    });
    let err: unknown;
    try {
      await c.api.getMe();
    } catch (e) {
      err = e;
    }
    assert(err instanceof TelegramError && err.code === 0, "expected TelegramError code 0");
    const surfaces = [
      err.message,
      err.description,
      String(err.stack),
      String(err.cause),
      ...events.slice(mark).map((e) =>
        JSON.stringify({
          ...e,
          error: e.error?.message,
          stack: e.error?.stack,
          cause: String(e.error?.cause),
        }),
      ),
    ];
    assert(!surfaces.some((s) => s.includes(fake)), "token leaked");
  });

  await check("S12", "alerter survives a failing store", true, async () => {
    const boom: Store = {
      get: () => Promise.reject(new Error("store down")),
      put: () => Promise.reject(new Error("store down")),
      delete: () => Promise.reject(new Error("store down")),
    };
    const evs: TelegramEvent[] = [];
    const c = createTelegram({
      token: TOKEN,
      store: boom,
      onEvent: (e) => {
        onEvent(e);
        evs.push(e);
      },
    });
    const alert = c.alerter({
      chat: CHAT,
      routes: { a: { topic: `S12-${RUN}` } },
      dedupe: { windowSec: 60 },
    });
    const res = await alert("a", "store failure alert", { key: `s12-${RUN}` });
    assert(res.ok, "alert did not return ok: true");
    track(res.messages);
    assert(
      evs.some((e) => e.type === "error" && /store/i.test(`${e.detail} ${e.error?.message}`)),
      "no error event mentions the store",
    );
  });

  await check("S13", "alerter dedupes by key", true, async () => {
    const alert = tg.alerter({
      chat: CHAT,
      routes: { a: { topic: nameA } },
      dedupe: { windowSec: 60 },
    });
    const key = `s13-${RUN}`;
    const first = await alert("a", "dedupe 1", { key });
    if (first.ok) track(first.messages);
    const second = await alert("a", "dedupe 2", { key });
    assert(!second.ok && second.skipped === "deduped", "second alert was not deduped");
  });

  await check("S14", "disabled client", false, async () => {
    const c = createTelegram({ token: "" });
    const res = await c.alerter({ chat: 1, routes: { a: {} } })("a", "x");
    assert(!res.ok && res.skipped === "disabled", "alert was not skipped as disabled");
    let err: unknown;
    try {
      await c.api.getMe();
    } catch (e) {
      err = e;
    }
    assert(err instanceof TelegramError && err.code === 0, "expected TelegramError code 0");
    assert(/bot token is not set/.test(err.description), `description was "${err.description}"`);
  });

  await check("S15", "webhook handler", false, async () => {
    const state: { calls: number; boom: boolean } = { calls: 0, boom: false };
    const handler = createTelegram({ token: "" }).webhook({
      secret: "smoke_secret",
      onUpdate: () => {
        state.calls++;
        if (state.boom) throw new Error("handler failed");
      },
      onError: () => {},
    });
    const count = () => state.calls;
    const post = (secret?: string) =>
      handler(
        new Request("http://localhost/hook", {
          method: "POST",
          headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {},
          body: JSON.stringify({ update_id: 1 }),
        }),
      );
    assert((await handler(new Request("http://localhost/hook"))).status === 405, "GET not 405");
    assert((await post("wrong")).status === 401, "wrong secret not 401");
    assert(count() === 0, "onUpdate ran for a rejected request");
    assert((await post("smoke_secret")).status === 200, "right secret not 200");
    assert(count() === 1, "onUpdate not called once");
    state.boom = true;
    assert((await post("smoke_secret")).status === 200, "throwing onUpdate not 200");
  });

  await check("S16", "poll stops cleanly on abort", true, async () => {
    const before = unhandled.length;
    const ac = new AbortController();
    const poller = tg.poll({ onUpdate: () => {}, signal: ac.signal });
    setTimeout(() => ac.abort(), 2000);
    await poller.done;
    await sleep(200);
    assert(unhandled.length === before, `unhandled rejection: ${String(unhandled[before])}`);
  });
} finally {
  if (live) {
    for (const id of threads) {
      try {
        await tg.api.deleteForumTopic({ chat_id: CHAT, message_thread_id: id });
      } catch {
        // Already deleted by the check itself.
      }
    }
  }
}

console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 || skipped > 0 ? 1 : 0);
