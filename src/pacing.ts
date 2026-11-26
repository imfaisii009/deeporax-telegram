export interface PacingLimits {
  perChatPerSec: number;
  perGroupPerMin: number;
  globalPerSec: number;
}

// ponytail: limits from memory of the Bots FAQ, verify
export const DEFAULT_PACING: PacingLimits = {
  perChatPerSec: 1,
  perGroupPerMin: 20,
  globalPerSec: 30,
};

export type Pacer = (method: string, chatId: unknown) => Promise<void>;

const PACED = /^(send(?!ChatAction)|copyMessages?|forwardMessages?)/;
const MAX_BUCKETS = 1000;

class Bucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly rate: number, // tokens per second
  ) {
    this.tokens = capacity;
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  // Tokens go negative so concurrent callers queue fairly instead of all waking together.
  reserve(): number {
    this.refill(Date.now());
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : (-this.tokens / this.rate) * 1000;
  }

  idle(): boolean {
    this.refill(Date.now());
    return this.tokens >= this.capacity;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPacer(limits: PacingLimits | false): Pacer {
  if (limits === false) return async () => {};

  const global = new Bucket(limits.globalPerSec, limits.globalPerSec);
  // ponytail: per-process buckets; cross-instance limits rely on 429 handling
  const chats = new Map<string, Bucket>();

  const chatBucket = (chatId: string | number): Bucket => {
    const key = String(chatId);
    let bucket = chats.get(key);
    if (!bucket) {
      if (chats.size >= MAX_BUCKETS) {
        for (const [k, b] of chats) if (b.idle()) chats.delete(k);
      }
      // Only numeric ids can be private chats; negative ids and @names are groups/channels.
      const isPrivate = Number(chatId) > 0;
      bucket = isPrivate
        ? new Bucket(1, limits.perChatPerSec)
        : new Bucket(limits.perGroupPerMin, limits.perGroupPerMin / 60);
      chats.set(key, bucket);
    }
    return bucket;
  };

  return async (method, chatId) => {
    if (!PACED.test(method)) return;
    const hasChat = typeof chatId === "number" || (typeof chatId === "string" && chatId !== "");
    const wait = Math.max(global.reserve(), hasChat ? chatBucket(chatId).reserve() : 0);
    if (wait > 0) await sleep(wait);
  };
}
