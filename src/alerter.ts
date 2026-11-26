import type { Message } from "@grammyjs/types";
import type { Buttons } from "./buttons.js";
import type { EventSink } from "./events.js";
import type { SendContent, SendFn } from "./send.js";
import type { SafeStore } from "./store.js";
import type { ChatId, IconColor } from "./topics.js";

export interface AlertRoute {
  topic?: string | number;
  iconColor?: IconColor;
  silent?: boolean;
}
export interface AlerterConfig<R extends string> {
  chat: ChatId;
  routes: Record<R, AlertRoute>;
  dedupe?: { windowSec: number };
  fallbackRoute?: R;
}
export interface AlertOptions {
  key?: string;
  silent?: boolean;
  buttons?: Buttons;
}
export type AlertResult =
  | { ok: true; messages: Message[] }
  | { ok: false; skipped?: "disabled" | "deduped"; error?: Error };
export type Alert<R extends string> = (
  route: R,
  content: SendContent,
  options?: AlertOptions,
) => Promise<AlertResult>;

const PRUNE_AT = 1000;
let warnedDisabled = false;

const toError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

export function createAlerter<R extends string>(
  deps: { enabled: boolean; send: SendFn; store: SafeStore; emit: EventSink },
  config: AlerterConfig<R>,
): Alert<R> {
  const { enabled, send, store, emit } = deps;
  const memory = new Map<string, number>(); // dedupe key → expiresAt (ms)

  return async (route, content, options = {}) => {
    try {
      if (!enabled) {
        if (!warnedDisabled) {
          warnedDisabled = true;
          console.warn("[telegram] bot token is not set; alerts are skipped");
        }
        return { ok: false, skipped: "disabled" };
      }

      const primary = config.routes[route] as AlertRoute | undefined;
      if (!primary) {
        const error = new TypeError(`unknown alert route "${route}"`);
        emit({ type: "dropped", error, detail: "alert" });
        return { ok: false, error };
      }

      let dedupeKey: string | undefined;
      if (options.key !== undefined && config.dedupe) {
        const { windowSec } = config.dedupe;
        dedupeKey = `dedupe:${String(config.chat)}:${options.key}`;
        const now = Date.now();
        const expiresAt = memory.get(dedupeKey);
        let hit = expiresAt !== undefined && expiresAt > now;
        if (!hit && (await store.get(dedupeKey)) !== null) {
          hit = true;
          memory.set(dedupeKey, now + windowSec * 1000);
        }
        if (hit) {
          emit({ type: "deduped", key: options.key });
          return { ok: false, skipped: "deduped" };
        }
        if (memory.size > PRUNE_AT) {
          for (const [k, exp] of memory) if (exp <= now) memory.delete(k);
        }
        memory.set(dedupeKey, now + windowSec * 1000);
        await store.put(dedupeKey, "1", windowSec);
      }

      const attempt = (r: AlertRoute) =>
        send(
          {
            chat: config.chat,
            topic: r.topic,
            topicOptions: r.iconColor !== undefined ? { iconColor: r.iconColor } : undefined,
          },
          content,
          { silent: options.silent ?? r.silent, buttons: options.buttons },
        );

      let error: Error;
      try {
        return { ok: true, messages: await attempt(primary) };
      } catch (e) {
        error = toError(e);
        emit({ type: "error", error, detail: `alert route ${route} failed` });
      }

      // A failed topic route can still reach the chat through the fallback (General) route.
      const { fallbackRoute } = config;
      const fallback = fallbackRoute !== undefined ? config.routes[fallbackRoute] : undefined;
      if (fallback && fallbackRoute !== route && primary.topic !== undefined) {
        try {
          return { ok: true, messages: await attempt(fallback) };
        } catch (e) {
          error = toError(e);
        }
      }

      emit({ type: "dropped", error, detail: `alert route ${route}` });
      if (dedupeKey) {
        memory.delete(dedupeKey);
        await store.delete(dedupeKey);
      }
      return { ok: false, error };
    } catch (e) {
      // Content errors (e.g. empty text) throw synchronously from send; never reject.
      const error = toError(e);
      try {
        emit({ type: "dropped", error, detail: "alert" });
      } catch {}
      return { ok: false, error };
    }
  };
}
