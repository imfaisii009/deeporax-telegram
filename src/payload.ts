import { type InputFile, isInputFile } from "./input-file.js";
import type { FetchLike } from "./request.js";

// Plain objects and arrays only: a Blob, Date or other class instance is never searched.
function containsFile(value: unknown): boolean {
  if (isInputFile(value)) return true;
  if (Array.isArray(value)) return value.some(containsFile);
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).some(containsFile);
}

export async function buildBody(
  args: Record<string, unknown> | undefined,
  fetchFn: FetchLike,
): Promise<{ body: string | FormData; headers?: Record<string, string> }> {
  if (!containsFile(args)) {
    return { body: JSON.stringify(args ?? {}), headers: { "content-type": "application/json" } };
  }

  const form = new FormData();
  const attached: InputFile[] = [];
  const replacer = (_key: string, value: unknown) => {
    if (!isInputFile(value)) return value;
    attached.push(value);
    return `attach://file${attached.length - 1}`;
  };

  for (const [field, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null) continue;
    if (isInputFile(value)) {
      form.append(field, await value.toBlob(fetchFn), value.filename ?? field);
    } else if (typeof value === "string") {
      form.append(field, value);
    } else {
      form.append(field, JSON.stringify(value, replacer));
    }
  }
  for (const [n, file] of attached.entries()) {
    form.append(`file${n}`, await file.toBlob(fetchFn), file.filename ?? `file${n}`);
  }
  return { body: form };
}
