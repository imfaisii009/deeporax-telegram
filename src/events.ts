export type TelegramEventType =
  | "request"
  | "retry"
  | "rate_limited"
  | "topic_created"
  | "topic_healed"
  | "migrated"
  | "parse_fallback"
  | "deduped"
  | "dropped"
  | "error";

export interface TelegramEvent {
  type: TelegramEventType;
  method?: string;
  chatId?: number | string;
  threadId?: number;
  ms?: number;
  attempt?: number;
  error?: Error;
  topic?: string;
  key?: string;
  detail?: string;
}

export type EventSink = (event: TelegramEvent) => void;

export function createEmitter(onEvent?: EventSink): EventSink {
  return (event) => {
    try {
      if (onEvent) onEvent(event);
      else if (event.type === "error" || event.type === "dropped") {
        console.warn(
          "[telegram]",
          event.type,
          event.method ?? "",
          event.error?.message ?? event.detail ?? "",
        );
      }
    } catch {
      // A throwing hook must never break a send.
    }
  };
}
