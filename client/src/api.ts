import { CapabilityNotGranted, ChestError, QuotaExceeded, RateLimited, TooLarge, Unavailable } from "./errors.js";

// The Chest's API as a server tool reaches it, shared by the modules that
// call it (files, members): CHEST_API is http://127.0.0.1:<port>, the tool's
// launcher, which relays each request to the Chest — the container has no
// network. A call reaches what is the tool's only: its instance is its
// identity. Not a published module.

const maxAnswer = 4 << 20;
const deadline = 120000;

// base is the Chest's API as the launcher gives it; without, the version holds
// none of the capabilities that use it.
function base(capability: string): string {
  const value = process.env["CHEST_API"];
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value) || Number(value.slice(17)) > 65535) throw new CapabilityNotGranted(capability);
  return value;
}

// ask sends one request of a capability to the Chest; a failure to reach it
// is Unavailable.
export async function ask(capability: string, method: string, path: string, init: { body?: Uint8Array<ArrayBuffer> | string; type?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.type !== undefined) headers["Content-Type"] = init.type;
  const url = base(capability) + path;
  try {
    return await fetch(url, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "error", signal: AbortSignal.timeout(deadline) });
  } catch {
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

// refusal turns an answer that is not a success into what the tool tests.
export async function refusal(response: Response, capability: string): Promise<ChestError> {
  let code = "refused";
  try {
    const given = ((await json(response)) as { error?: unknown } | null)?.error;
    if (typeof given === "string" && /^[a-z_]{1,40}$/u.test(given)) code = given;
  } catch {
    // The code stays "refused".
  }
  if (response.status === 403) return new CapabilityNotGranted(capability);
  if (response.status === 413) return new TooLarge();
  if (response.status === 429) return code === "rate_limited" ? new RateLimited() : new QuotaExceeded();
  if (response.status >= 500) return new Unavailable();
  return new ChestError(code, response.status, `the Chest refused: ${code}`);
}
