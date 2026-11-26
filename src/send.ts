import type { Message } from "@grammyjs/types";
import type { Api } from "./api.js";
import type { Buttons } from "./buttons.js";
import { TelegramError } from "./errors.js";
import type { EventSink } from "./events.js";
import { type Content, isHtml, plain, raw } from "./html.js";
import type { InputFile } from "./input-file.js";
import type { CallInit } from "./request.js";
import { CAPTION_LIMIT, splitHtml, splitPlain, TEXT_LIMIT, visibleLength } from "./split.js";
import {
  type ChatId,
  isTopicClosed,
  isTopicDeleted,
  type TopicOptions,
  type TopicsInternal,
} from "./topics.js";

export interface Target {
  chat: ChatId;
  topic?: string | number;
  topicOptions?: TopicOptions;
}
export type MediaKind = "photo" | "document" | "video" | "audio" | "animation" | "voice";
export interface MediaContent {
  type: MediaKind;
  file: InputFile | string;
  caption?: Content;
}
export interface AlbumContent {
  type: "album";
  items: Array<{
    type: "photo" | "video" | "document" | "audio";
    file: InputFile | string;
    caption?: Content;
  }>;
}
export type SendContent = Content | MediaContent | AlbumContent;
export interface SendOptions {
  silent?: boolean;
  protect?: boolean;
  preview?: boolean; // default false
  buttons?: Buttons;
  replyTo?: number;
  plainFallback?: boolean;
  signal?: AbortSignal;
}
export type SendFn = (
  target: Target | ChatId,
  content: SendContent,
  options?: SendOptions,
) => Promise<Message[]>;

type Params = Record<string, unknown>;
type Raw = (params: Params, init?: CallInit) => Promise<Message | Message[]>;

const MEDIA_METHOD = {
  photo: "sendPhoto",
  document: "sendDocument",
  video: "sendVideo",
  audio: "sendAudio",
  animation: "sendAnimation",
  voice: "sendVoice",
} as const;

const isTarget = (t: Target | ChatId): t is Target =>
  typeof t === "object" && t !== null && "chat" in t;

const isParseError = (e: unknown) =>
  e instanceof TelegramError && /can't parse entities/i.test(e.description);

const splitCaption = (c: Content): string[] =>
  isHtml(c) ? splitHtml(c.value, CAPTION_LIMIT) : splitPlain(c, CAPTION_LIMIT);

const visible = (c: Content) => (isHtml(c) ? visibleLength(c.value) : c.length);

export function createSend(deps: {
  api: Api;
  topics: TopicsInternal;
  emit: EventSink;
  plainFallback: boolean;
}): SendFn {
  const { api, topics, emit } = deps;

  return async (target, content, options = {}) => {
    const { chat, topic, topicOptions } = isTarget(target) ? target : ({ chat: target } as Target);
    const fallback = options.plainFallback ?? deps.plainFallback;
    const init: CallInit = { signal: options.signal };

    // Validate before any request so bad input never half-sends.
    if (typeof content === "object" && !isHtml(content) && content.type === "album") {
      if (content.items.length < 2 || content.items.length > 10) {
        throw new RangeError("an album needs 2-10 items");
      }
      if (options.buttons) throw new TypeError("buttons are not supported on albums");
    } else if (typeof content === "string" || isHtml(content)) {
      if (visible(content) === 0) throw new RangeError("message text is empty");
    }

    let thread: number | undefined;
    if (typeof topic === "string") thread = await topics.ensure(chat, topic, topicOptions);
    else if (typeof topic === "number") thread = topic;

    // Topics given by name self-heal once per call; a healed id sticks for the rest of the send.
    async function withHeal<T>(fn: () => Promise<T>): Promise<T> {
      try {
        return await fn();
      } catch (error) {
        if (typeof topic !== "string" || thread === undefined) throw error;
        if (!isTopicDeleted(error) && !isTopicClosed(error)) throw error;
        thread = await topics.heal(chat, topic, thread, error as TelegramError, topicOptions);
        return fn();
      }
    }

    const common = (): Params => ({
      chat_id: chat,
      ...(thread !== undefined && { message_thread_id: thread }),
      ...(options.silent !== undefined && { disable_notification: options.silent }),
      ...(options.protect !== undefined && { protect_content: options.protect }),
    });
    const reply = (id: number | undefined): Params =>
      id === undefined
        ? {}
        : { reply_parameters: { message_id: id, allow_sending_without_reply: true } };
    const markup = (buttons: Buttons | undefined): Params =>
      buttons ? { reply_markup: { inline_keyboard: buttons } } : {};

    // One request with the topic heal and, for parse errors, a plain-text resend.
    async function request(
      method: string,
      build: (asPlain: boolean) => Params,
    ): Promise<Message | Message[]> {
      const fn = api[method as keyof Api] as unknown as Raw;
      try {
        return await withHeal(() => fn({ ...common(), ...build(false) }, init));
      } catch (error) {
        if (!fallback || !isParseError(error)) throw error;
        emit({
          type: "parse_fallback",
          method,
          chatId: chat,
          threadId: thread,
          error: error as Error,
        });
        return withHeal(() => fn({ ...common(), ...build(true) }, init));
      }
    }

    async function sendText(
      text: Content,
      replyTo: number | undefined,
      buttons: Buttons | undefined,
    ): Promise<Message[]> {
      const html = isHtml(text);
      const chunks = html ? splitHtml(text.value, TEXT_LIMIT) : splitPlain(text, TEXT_LIMIT);
      const sent: Message[] = [];
      for (const [n, chunk] of chunks.entries()) {
        const msg = await request("sendMessage", (asPlain) => ({
          text: html && asPlain ? plain(chunk) : chunk,
          ...(html && !asPlain && { parse_mode: "HTML" }),
          link_preview_options: { is_disabled: !options.preview },
          ...(n === 0 && reply(replyTo)),
          ...(n === chunks.length - 1 && markup(buttons)),
        }));
        sent.push(msg as Message);
      }
      return sent;
    }

    if (typeof content === "string" || isHtml(content)) {
      return sendText(content, options.replyTo, options.buttons);
    }

    if (content.type === "album") {
      const media = content.items.map((item) => {
        const first = item.caption === undefined ? undefined : splitCaption(item.caption)[0];
        return {
          type: item.type,
          media: item.file,
          ...(first !== undefined && { caption: first }),
          ...(first !== undefined && isHtml(item.caption) && { parse_mode: "HTML" }),
        };
      });
      const msgs = await request("sendMediaGroup", (asPlain) => ({
        media: asPlain
          ? media.map(({ parse_mode, caption, ...rest }) => ({
              ...rest,
              ...(caption !== undefined && {
                caption: parse_mode ? plain(caption) : caption,
              }),
            }))
          : media,
        ...reply(options.replyTo),
      }));
      return msgs as Message[];
    }

    const { type, file, caption } = content;
    const chunks = caption === undefined ? [] : splitCaption(caption);
    const [first, ...rest] = chunks;
    const overflow = rest.length > 0;
    const msg = (await request(MEDIA_METHOD[type], (asPlain) => ({
      [type]: file,
      ...(first !== undefined && {
        caption: isHtml(caption) && asPlain ? plain(first) : first,
      }),
      ...(first !== undefined && isHtml(caption) && !asPlain && { parse_mode: "HTML" }),
      ...reply(options.replyTo),
      ...(!overflow && markup(options.buttons)),
    }))) as Message;
    if (!overflow) return [msg];
    const remainder = isHtml(caption) ? raw(rest.join("")) : rest.join("");
    return [msg, ...(await sendText(remainder, msg.message_id, options.buttons))];
  };
}
