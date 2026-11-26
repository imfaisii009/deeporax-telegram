import type { EventSink } from "./events.js";

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<unknown>;
  delete?(key: string): Promise<unknown>;
}

export function memoryStore(): Store {
  const map = new Map<string, { value: string; expiresAt?: number }>();
  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options) {
      const ttl = options?.expirationTtl;
      map.set(key, { value, expiresAt: ttl === undefined ? undefined : Date.now() + ttl * 1000 });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export interface SafeStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSec?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

// KV backends reject TTLs under 60s.
const MIN_TTL_SEC = 60;

export function createSafeStore(store: Store, prefix: string, emit: EventSink): SafeStore {
  const fail = (op: string, error: unknown) =>
    emit({
      type: "error",
      detail: `store ${op} failed`,
      error: error instanceof Error ? error : new Error(String(error)),
    });

  return {
    async get(key) {
      try {
        return (await store.get(prefix + key)) || null;
      } catch (error) {
        fail("get", error);
        return null;
      }
    },
    async put(key, value, ttlSec) {
      try {
        const options =
          ttlSec === undefined ? undefined : { expirationTtl: Math.max(ttlSec, MIN_TTL_SEC) };
        await store.put(prefix + key, value, options);
      } catch (error) {
        fail("put", error);
      }
    },
    async delete(key) {
      try {
        if (store.delete) await store.delete(prefix + key);
        else await store.put(prefix + key, "", { expirationTtl: MIN_TTL_SEC });
      } catch (error) {
        fail("delete", error);
      }
    },
  };
}
