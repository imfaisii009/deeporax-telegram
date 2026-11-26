import type { Opts } from "@grammyjs/types";
import type { Api } from "./api.js";
import { TelegramError } from "./errors.js";
import type { EventSink } from "./events.js";
import type { InputFile } from "./input-file.js";
import type { SafeStore } from "./store.js";

export type ChatId = number | string;
export type IconColor = NonNullable<Opts<InputFile>["createForumTopic"]["icon_color"]>;

export interface TopicOptions {
  iconColor?: IconColor;
  iconCustomEmojiId?: string;
}

export interface Topics {
  /** Resolve the thread id, creating the topic when it does not exist yet. */
  ensure(chat: ChatId, name: string, options?: TopicOptions): Promise<number>;
  /** Resolve the thread id without creating anything. */
  id(chat: ChatId, name: string): Promise<number | undefined>;
  rename(chat: ChatId, name: string, newName: string): Promise<void>;
  close(chat: ChatId, name: string): Promise<void>;
  reopen(chat: ChatId, name: string): Promise<void>;
  delete(chat: ChatId, name: string): Promise<void>;
  /** Drop the cached id; the topic itself is untouched. */
  forget(chat: ChatId, name: string): Promise<void>;
}

export interface TopicsInternal extends Topics {
  heal(
    chat: ChatId,
    name: string,
    failedId: number,
    error: TelegramError,
    options?: TopicOptions,
  ): Promise<number>;
}

export function isTopicDeleted(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    /message thread not found|TOPIC_DELETED|TOPIC_ID_INVALID/i.test(error.description)
  );
}

export function isTopicClosed(error: unknown): boolean {
  return error instanceof TelegramError && /TOPIC_CLOSED/i.test(error.description);
}

interface Entry {
  id: number;
  over?: number;
}

export function createTopics(deps: {
  api: Api;
  store: SafeStore;
  emit: EventSink;
  pinned?: Record<string, Record<string, number>>;
}): TopicsInternal {
  const { api, store, emit, pinned } = deps;
  const memory = new Map<string, number>();
  const inFlight = new Map<string, Promise<number>>();

  const memKey = (chat: ChatId, name: string) => `${String(chat)}:${name}`;
  const storeKey = (chat: ChatId, name: string) => `topic:${memKey(chat, name)}`;
  const pin = (chat: ChatId, name: string) => pinned?.[String(chat)]?.[name];

  function validate(name: string) {
    if (name.length < 1 || name.length > 128) {
      throw new RangeError("topic name must be 1-128 characters");
    }
  }

  async function readEntry(chat: ChatId, name: string): Promise<Entry | undefined> {
    const raw = await store.get(storeKey(chat, name));
    if (raw === null) return undefined;
    try {
      const entry = JSON.parse(raw) as Entry;
      return typeof entry?.id === "number" ? entry : undefined;
    } catch {
      return undefined;
    }
  }

  async function resolve(chat: ChatId, name: string): Promise<number | undefined> {
    validate(name);
    const key = memKey(chat, name);
    const cached = memory.get(key);
    if (cached !== undefined) return cached;

    const p = pin(chat, name);
    const entry = await readEntry(chat, name);
    // An entry that replaced this pin was written by an earlier heal, so it wins over the stale pin.
    const found = p !== undefined ? (entry?.over === p ? entry.id : p) : entry?.id;
    if (found !== undefined) memory.set(key, found);
    return found;
  }

  async function create(chat: ChatId, name: string, options?: TopicOptions): Promise<number> {
    try {
      const topic = await api.createForumTopic({
        chat_id: chat,
        name,
        ...(options?.iconColor !== undefined && { icon_color: options.iconColor }),
        ...(options?.iconCustomEmojiId !== undefined && {
          icon_custom_emoji_id: options.iconCustomEmojiId,
        }),
      });
      return topic.message_thread_id;
    } catch (error) {
      if (
        error instanceof TelegramError &&
        /not enough rights|CHAT_ADMIN_REQUIRED/i.test(error.description)
      ) {
        throw new TelegramError(
          error.method,
          error.code,
          `${error.description} (the bot must be an admin with can_manage_topics)`,
          { retry_after: error.retryAfter, migrate_to_chat_id: error.migrateToChatId },
        );
      }
      throw error;
    }
  }

  // One shared promise per key so concurrent callers never create twice in this isolate.
  // ponytail: KV has no compare-and-set, two isolates can create duplicate topics; pin ids or ensure() from a deploy step/cron
  function shared(key: string, run: () => Promise<number>): Promise<number> {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = run().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  async function need(chat: ChatId, name: string): Promise<number> {
    const id = await resolve(chat, name);
    if (id === undefined) throw new TelegramError("topics", 0, `unknown topic ${name}`);
    return id;
  }

  async function forget(chat: ChatId, name: string): Promise<void> {
    memory.delete(memKey(chat, name));
    await store.delete(storeKey(chat, name));
  }

  return {
    id: resolve,

    ensure(chat, name, options) {
      validate(name);
      return shared(memKey(chat, name), async () => {
        const found = await resolve(chat, name);
        if (found !== undefined) return found;
        const id = await create(chat, name, options);
        memory.set(memKey(chat, name), id);
        await store.put(storeKey(chat, name), JSON.stringify({ id }));
        emit({ type: "topic_created", chatId: chat, topic: name, threadId: id });
        return id;
      });
    },

    async heal(chat, name, failedId, error, options) {
      const key = memKey(chat, name);
      if (isTopicClosed(error)) {
        return shared(`reopen:${key}`, async () => {
          try {
            await api.reopenForumTopic({ chat_id: chat, message_thread_id: failedId });
          } catch (e) {
            // A concurrent or earlier reopen already did the job.
            if (!(e instanceof TelegramError && /TOPIC_NOT_MODIFIED/i.test(e.description))) throw e;
          }
          emit({
            type: "topic_healed",
            chatId: chat,
            topic: name,
            threadId: failedId,
            detail: "reopened",
            error,
          });
          return failedId;
        });
      }
      // An in-flight ensure may resolve to the very id that just failed, so its result is not proof of a heal.
      const pending = inFlight.get(key);
      if (pending) {
        const id = await pending;
        if (id !== failedId) return id;
      }
      return shared(key, async () => {
        // Another caller may have healed between the failure and this call.
        const current = memory.get(key);
        if (current !== undefined && current !== failedId) return current;
        const id = await create(chat, name, options);
        const p = pin(chat, name);
        memory.set(key, id);
        await store.put(
          storeKey(chat, name),
          JSON.stringify(p !== undefined ? { id, over: p } : { id }),
        );
        emit({
          type: "topic_healed",
          chatId: chat,
          topic: name,
          threadId: id,
          detail: "recreated",
          error,
        });
        return id;
      });
    },

    async rename(chat, name, newName) {
      validate(newName);
      const id = await need(chat, name);
      await api.editForumTopic({ chat_id: chat, message_thread_id: id, name: newName });
      const old = await readEntry(chat, name);
      await store.put(
        storeKey(chat, newName),
        JSON.stringify(old?.over !== undefined ? { id, over: old.over } : { id }),
      );
      await forget(chat, name);
      memory.set(memKey(chat, newName), id);
    },

    async close(chat, name) {
      await api.closeForumTopic({ chat_id: chat, message_thread_id: await need(chat, name) });
    },

    async reopen(chat, name) {
      await api.reopenForumTopic({ chat_id: chat, message_thread_id: await need(chat, name) });
    },

    async delete(chat, name) {
      await api.deleteForumTopic({ chat_id: chat, message_thread_id: await need(chat, name) });
      await forget(chat, name);
    },

    forget,
  };
}
