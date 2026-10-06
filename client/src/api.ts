import { CapabilityNotGranted, ChestError, QuotaExceeded, RateLimited, StorageFull, TooLarge, Unavailable } from "./errors.js";

// The Chest's API as a server tool reaches it, shared by the modules that
// call it (files, members): CHEST_API is http://127.0.0.1:<port>, the tool's
// launcher, which relays each request to the Chest — the container has no
// network. A call reaches what is the tool's only: its instance is its
// identity. Not a published module.

const maxAnswer = 4 << 20;
const deadline = 120000;

// chestLink reads a link to the team host the Chest answered, at path (its
// links, its uploads): the token it carries, or undefined for an address
// that is not one — https, or the origin of the Chest's API itself
// (CHEST_API), where only a fake Chest of a tool's tests serves its links:
// the address the tool already trusts for every call, never another.
export function chestLink(url: unknown, path: string): string | undefined {
  if (typeof url !== "string") return undefined;
  const found = /^(https:\/\/[A-Za-z0-9.-]{1,253}(?::[0-9]{1,5})?|http:\/\/127\.0\.0\.1:[0-9]{1,5})(\/_chest\/[a-z/]+\/)([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(url);
  if (!found || found[2] !== path || (found[1]!.startsWith("http:") && found[1] !== process.env["CHEST_API"])) return undefined;
  return found[3];
}

// base is the Chest's API as the launcher gives it; without, the version holds
// none of the capabilities that use it.
function base(capability: string): string {
  const value = process.env["CHEST_API"];
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value) || Number(value.slice(17)) > 65535) throw new CapabilityNotGranted(capability);
  return value;
}

// ask sends one request of a capability to the Chest; a failure to reach it
// is Unavailable. The request and the reading of its answer end after
// deadline milliseconds (120 seconds unless said), or when the caller's
// signal aborts: its reason is then thrown.
export async function ask(capability: string, method: string, path: string, init: { body?: Uint8Array<ArrayBuffer> | string; type?: string; headers?: Record<string, string>; deadline?: number; signal?: AbortSignal } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.type !== undefined) headers["Content-Type"] = init.type;
  const url = base(capability) + path;
  const timeout = AbortSignal.timeout(init.deadline ?? deadline);
  try {
    return await fetch(url, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "error", signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout });
  } catch {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new Unavailable();
  }
}

// read takes a body of limit bytes at most; beyond, or cut, the answer is not
// the Chest's.
export async function read(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Unavailable();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limit) throw new Unavailable();
      chunks.push(chunk);
    }
  } catch {
    throw new Unavailable();
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return all;
}

// json reads an answer of the Chest as JSON; anything else is Unavailable.
export async function json(response: Response): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(response, maxAnswer)));
  } catch {
    throw new Unavailable();
  }
}

// errorCode is the code of a refusal of the Chest ({"error": code}), or
// "refused" for an answer that says none.
export async function errorCode(response: Response): Promise<string> {
  try {
    const given = ((await json(response)) as { error?: unknown } | null)?.error;
    if (typeof given === "string" && /^[a-z_]{1,40}$/u.test(given)) return given;
  } catch {
    // No code of the Chest's.
  }
  return "refused";
}

// refusal turns an answer that is not a success into what the tool tests.
export async function refusal(response: Response, capability: string): Promise<ChestError> {
  const code = await errorCode(response);
  if (response.status === 403) return new CapabilityNotGranted(capability);
  if (response.status === 413) return new TooLarge();
  if (response.status === 429) return code === "rate_limited" ? new RateLimited() : new QuotaExceeded();
  if (response.status === 507 && code === "storage_full") return new StorageFull();
  if (response.status >= 500) return new Unavailable();
  return new ChestError(code, response.status, `the Chest refused: ${code}`);
}
