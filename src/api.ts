import type { ApiMethods, Opts } from "@grammyjs/types";
import type { InputFile } from "./input-file.js";
import type { Caller, CallInit } from "./request.js";

type M = ApiMethods<InputFile>;

export type ApiFn<K extends keyof M> = undefined extends Parameters<M[K]>[0]
  ? (args?: Opts<InputFile>[K], init?: CallInit) => Promise<ReturnType<M[K]>>
  : (args: Opts<InputFile>[K], init?: CallInit) => Promise<ReturnType<M[K]>>;

export type Api = { readonly [K in keyof M]: ApiFn<K> };

export function createApi(call: Caller): Api {
  const methods = new Map<string, unknown>();
  // The Proxy answers for every method name, which a mapped type can't express without a cast.
  return new Proxy({} as object, {
    get(_target, name) {
      // `then` stays undefined so `await tg.api` doesn't treat the proxy as a thenable.
      if (typeof name !== "string" || name === "then") return undefined;
      let fn = methods.get(name);
      if (!fn) {
        fn = (args?: unknown, init?: CallInit) =>
          call(name, args as Record<string, unknown> | undefined, init);
        methods.set(name, fn);
      }
      return fn;
    },
  }) as unknown as Api;
}
