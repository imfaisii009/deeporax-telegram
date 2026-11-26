import { escapeHtml, plain } from "./html.js";

export const TEXT_LIMIT = 4096;
export const CAPTION_LIMIT = 1024;

export function visibleLength(markup: string): number {
  return plain(markup).length;
}

const TOKEN = /<\/?[a-zA-Z][^>]*>|&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);|[^<&]+|[<&]/g;

interface Tag {
  open: string;
  name: string;
}

interface Candidate {
  pos: number; // offset in `cur` just after the break character
  len: number; // visible length up to pos
  stack: Tag[];
}

const closeAll = (stack: Tag[]) =>
  stack
    .map((t) => `</${t.name}>`)
    .reverse()
    .join("");
const reopen = (stack: Tag[]) => stack.map((t) => t.open).join("");

/**
 * Splits markup into chunks of at most `limit` visible characters. Open tags are
 * closed at each cut and reopened in the next chunk; neither counts toward the limit.
 */
export function splitHtml(markup: string, limit: number): string[] {
  const total = visibleLength(markup);
  if (total === 0) return [];
  if (total <= limit) return [markup];

  const chunks: string[] = [];
  let cur = "";
  let len = 0;
  let stack: Tag[] = [];
  let prev = "";
  // Indexed by preference: paragraph, line, space.
  let cands: Array<Candidate | undefined> = [undefined, undefined, undefined];

  const cut = () => {
    // A break that leaves a tiny chunk is skipped; with none eligible, the latest break wins.
    const found = cands.filter((c): c is Candidate => c !== undefined);
    const best =
      found.find((c) => c.len >= Math.floor(limit / 2)) ?? found.sort((a, c) => c.pos - a.pos)[0];
    if (best) {
      chunks.push(cur.slice(0, best.pos) + closeAll(best.stack));
      const prefix = reopen(best.stack);
      cands = cands.map((c) =>
        c && c.pos > best.pos
          ? { pos: c.pos - best.pos + prefix.length, len: c.len - best.len, stack: c.stack }
          : undefined,
      );
      cur = prefix + cur.slice(best.pos);
      len -= best.len;
    } else {
      chunks.push(cur + closeAll(stack));
      cur = reopen(stack);
      len = 0;
    }
  };

  for (const token of markup.match(TOKEN) ?? []) {
    if (token.startsWith("<") && token.length > 1) {
      const name = /^<\/?([a-zA-Z][\w-]*)/.exec(token)?.[1]?.toLowerCase() as string;
      if (token.startsWith("</")) {
        const at = stack.map((t) => t.name).lastIndexOf(name);
        if (at >= 0) stack = stack.slice(0, at);
      } else if (!token.endsWith("/>")) {
        stack = [...stack, { open: token, name }];
      }
      cur += token;
      continue;
    }
    // An entity is atomic; a text run is split into code points so a surrogate pair stays whole.
    const units = token.startsWith("&") && token.length > 1 ? [token] : [...token];
    for (const unit of units) {
      const text = plain(unit);
      while (len > 0 && len + text.length > limit) cut();
      cur += unit;
      len += text.length;
      if (text.endsWith("\n")) {
        if (prev === "\n") cands[0] = { pos: cur.length, len, stack };
        cands[1] = { pos: cur.length, len, stack };
      } else if (text.endsWith(" ")) {
        cands[2] = { pos: cur.length, len, stack };
      }
      prev = text.slice(-1);
    }
  }
  chunks.push(cur + closeAll(stack));
  return chunks.filter((c) => visibleLength(c) > 0);
}

// Escaping first makes `&`/`<` into atomic entities, so the HTML walk handles plain text unchanged.
export function splitPlain(text: string, limit: number): string[] {
  return splitHtml(escapeHtml(text), limit).map(plain);
}
