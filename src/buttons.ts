import type {
  ForceReply,
  InlineKeyboardButton,
  KeyboardButton,
  LoginUrl,
  ReplyKeyboardMarkup,
  ReplyKeyboardRemove,
} from "@grammyjs/types";

export type Buttons = InlineKeyboardButton[][];

export const button = {
  url: (text: string, url: string): InlineKeyboardButton.UrlButton => ({ text, url }),
  callback(text: string, data: string): InlineKeyboardButton.CallbackButton {
    const bytes = new TextEncoder().encode(data).length;
    if (bytes < 1 || bytes > 64) {
      throw new RangeError(`callback_data must be 1-64 UTF-8 bytes, got ${bytes}`);
    }
    return { text, callback_data: data };
  },
  webApp: (text: string, url: string): InlineKeyboardButton.WebAppButton => ({
    text,
    web_app: { url },
  }),
  copy: (text: string, copyText: string): InlineKeyboardButton.CopyTextButtonButton => ({
    text,
    copy_text: { text: copyText },
  }),
  loginUrl: (text: string, url: string | LoginUrl): InlineKeyboardButton.LoginButton => ({
    text,
    login_url: typeof url === "string" ? { url } : url,
  }),
};

export const keyboard = {
  reply: (
    rows: Array<Array<string | KeyboardButton>>,
    options?: Omit<ReplyKeyboardMarkup, "keyboard">,
  ): ReplyKeyboardMarkup => ({
    keyboard: rows.map((row) => row.map((k) => (typeof k === "string" ? { text: k } : k))),
    ...options,
  }),
  remove: (selective?: boolean): ReplyKeyboardRemove => ({
    remove_keyboard: true,
    ...(selective !== undefined && { selective }),
  }),
  forceReply: (options?: Omit<ForceReply, "force_reply">): ForceReply => ({
    force_reply: true,
    ...options,
  }),
};
