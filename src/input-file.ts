import { TelegramError } from "./errors.js";
import type { FetchLike } from "./request.js";

export type InputFileData = Blob | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

// Symbol.for brand instead of instanceof: ESM and CJS copies of this package can both load.
const BRAND = Symbol.for("@deeporax/telegram.InputFile");

export class InputFile {
  readonly [BRAND] = true;
  readonly filename: string | undefined;
  #source: InputFileData | URL;
  #blob: Promise<Blob> | undefined;

  constructor(data: InputFileData, filename?: string) {
    this.#source = data;
    this.filename = filename;
  }

  static fromUrl(url: string | URL, filename?: string): InputFile {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("InputFile.fromUrl only accepts http(s) URLs");
    }
    const file = new InputFile(
      new Blob(),
      filename ?? (parsed.pathname.split("/").pop() || "file"),
    );
    file.#source = parsed;
    return file;
  }

  // Memoised so a retry can reuse a stream that was already consumed.
  // A failure is not cached, so a transient download error can succeed on retry.
  toBlob(fetchFn: FetchLike): Promise<Blob> {
    this.#blob ??= this.#load(fetchFn).catch((e) => {
      this.#blob = undefined;
      throw e;
    });
    return this.#blob;
  }

  async #load(fetchFn: FetchLike): Promise<Blob> {
    const src = this.#source;
    if (src instanceof Blob) return src;
    // Cast: under lib DOM, Uint8Array's ArrayBufferLike is not accepted as BlobPart.
    if (src instanceof Uint8Array || src instanceof ArrayBuffer) return new Blob([src as BlobPart]);
    if (src instanceof URL) {
      const res = await fetchFn(src);
      if (!res.ok) {
        throw new TelegramError("InputFile.fromUrl", 0, `download failed: HTTP ${res.status}`);
      }
      return res.blob();
    }
    return new Response(src).blob();
  }
}

export function isInputFile(value: unknown): value is InputFile {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true
  );
}
