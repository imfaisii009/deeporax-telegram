const BRAND = Symbol.for("@deeporax/telegram.Html");

export interface Html {
  readonly value: string;
  toString(): string;
}

/** A string is escaped text; Html is trusted markup. */
export type Content = string | Html;

export function isHtml(value: unknown): value is Html {
  return typeof value === "object" && value !== null && BRAND in value;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function raw(markup: string): Html {
  return {
    value: markup,
    toString: () => markup,
    [BRAND]: true,
  } as Html;
}

function render(value: unknown): string {
  if (isHtml(value)) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === null || value === undefined || value === false) return "";
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return raw(out);
}

// Telegram HTML knows only these four named entities.
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"' };

export function plain(markup: Html | string): string {
  const text = typeof markup === "string" ? markup : markup.value;
  return text
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot));/g, (whole, dec, hex, name) => {
      if (name) return NAMED[name] as string;
      const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    });
}

const content = (c: Content): string => (isHtml(c) ? c.value : escapeHtml(c));
const wrap = (tag: string) => (c: Content) => raw(`<${tag}>${content(c)}</${tag}>`);

export const b = wrap("b");
export const i = wrap("i");
export const u = wrap("u");
export const s = wrap("s");
export const code = wrap("code");
export const spoiler = wrap("tg-spoiler");

export function pre(text: string, lang?: string): Html {
  const body = escapeHtml(text);
  return raw(
    lang === undefined
      ? `<pre>${body}</pre>`
      : `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`,
  );
}

export function link(url: string, text: Content): Html {
  return raw(`<a href="${escapeHtml(url)}">${content(text)}</a>`);
}

export function mention(userId: number, name: Content): Html {
  return raw(`<a href="tg://user?id=${userId}">${content(name)}</a>`);
}

export function quote(c: Content, options?: { expandable?: boolean }): Html {
  return raw(`<blockquote${options?.expandable ? " expandable" : ""}>${content(c)}</blockquote>`);
}

export function emoji(customEmojiId: string, fallback: string): Html {
  return raw(
    `<tg-emoji emoji-id="${escapeHtml(customEmojiId)}">${escapeHtml(fallback)}</tg-emoji>`,
  );
}

const BARS = "▁▂▃▄▅▆▇█";

export function sparkline(values: number[]): string {
  const v = values.filter(Number.isFinite);
  if (v.length === 0) return "";
  const min = Math.min(...v);
  const max = Math.max(...v);
  if (min === max) return "▄".repeat(v.length);
  return v.map((x) => BARS[Math.round(((x - min) / (max - min)) * 7)]).join("");
}

export function progress(part: number, whole: number, cells = 10): string {
  const ratio = whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
  const filled = Math.round((Number.isFinite(ratio) ? ratio : 0) * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

export function flag(countryCode: string): string {
  if (!/^[A-Za-z]{2}$/.test(countryCode)) return "";
  return [...countryCode.toUpperCase()]
    .map((ch) => String.fromCodePoint(0x1f1e6 + ch.charCodeAt(0) - 65))
    .join("");
}

export function kv(rows: Record<string, Content> | Array<[string, Content]>): Html {
  const entries = Array.isArray(rows) ? rows : Object.entries(rows);
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  return raw(
    entries.map(([k, v]) => `<code>${escapeHtml(k.padEnd(width))}</code> ${content(v)}`).join("\n"),
  );
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}
