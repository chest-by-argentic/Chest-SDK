import { CapabilityNotGranted, ChestError, QuotaExceeded, TooLarge, Unavailable } from "./errors.js";

// The private files of a server tool whose chest.json declares
// "capabilities": ["files"]: kept by its Chest (1 GiB, 10,000 objects, 32 MiB
// each), never on the tool's own disk. The container has no network: the
// Chest's API is at CHEST_API (http://127.0.0.1:<port>, the tool's launcher,
// which relays each request to the Chest). A call reaches the tool's files
// only: its instance is its identity.
//
//   import * as files from "@argentic/chest-sdk/files";
//   await files.put("photos/cat.png", bytes, "image/png");
//   const { url } = await files.url("photos/cat.png");   // 15 min, team host
//
// Names: up to 8 segments of 1–100 letters, digits, '.', '_' or '-',
// separated by '/', none starting with '.' or '-'. Errors: CapabilityNotGranted
// (403), TooLarge (413), QuotaExceeded (429), Unavailable (503, or the Chest
// not reached), ChestError otherwise (invalid_name, invalid_type 400…).

export type FileObject = { name: string; type: string; size: number; updated: string };
export type FileData = { data: Uint8Array; type: string; size: number };
export type FilePage = { files: FileObject[]; next: string | null };

const maxObject = 32 << 20;
const maxAnswer = 4 << 20;
const deadline = 120000;
// The grammar of a name, the same as the Chest's (chest/toolfiles, name).
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/u;

// base is the Chest's API as the launcher gives it; without, the version
// does not keep files.
function base(): string {
  const value = process.env["CHEST_API"];
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value) || Number(value.slice(17)) > 65535) throw new CapabilityNotGranted("files");
  return value;
}

function checkName(name: unknown): string {
  if (typeof name !== "string" || !namePattern.test(name)) throw new ChestError("invalid_name", 400, "invalid file name");
  return name;
}

// ask sends one request to the Chest; a failure to reach it is Unavailable.
async function ask(method: string, path: string, init: { body?: Uint8Array<ArrayBuffer> | string; type?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.type !== undefined) headers["Content-Type"] = init.type;
  try {
    return await fetch(base() + path, { method, headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "error", signal: AbortSignal.timeout(deadline) });
  } catch (error) {
    if (error instanceof ChestError) throw error;
    throw new Unavailable();
  }
}

// read takes a body of limit bytes at most; beyond, or cut, the answer is not
// the Chest's.
async function read(response: Response, limit: number): Promise<Uint8Array> {
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

async function json(response: Response): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(response, maxAnswer)));
  } catch (error) {
    if (error instanceof ChestError) throw error;
    throw new Unavailable();
  }
}

// refusal turns an answer that is not a success into what the tool tests.
async function refusal(response: Response): Promise<ChestError> {
  if (response.status === 403) return new CapabilityNotGranted("files");
  if (response.status === 413) return new TooLarge();
  if (response.status === 429) return new QuotaExceeded();
  if (response.status >= 500) return new Unavailable();
  let code = "refused";
  try {
    const body = await json(response);
    const given = (body as { error?: unknown } | null)?.error;
    if (typeof given === "string" && /^[a-z_]{1,40}$/u.test(given)) code = given;
  } catch {
    // The code stays « refused ».
  }
  return new ChestError(code, response.status, `the Chest refused: ${code}`);
}

function isObject(value: unknown): value is FileObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o["name"] === "string" && namePattern.test(o["name"]) && typeof o["type"] === "string" && o["type"].length <= 200 && typeof o["size"] === "number" && Number.isSafeInteger(o["size"]) && o["size"] >= 0 && typeof o["updated"] === "string";
}
function object(value: unknown): FileObject {
  if (!isObject(value)) throw new Unavailable();
  return { name: value.name, type: value.type, size: value.size, updated: value.updated };
}

// put keeps data as the file name, of type type (application/octet-stream
// when none), replacing the one of that name.
export async function put(name: string, data: Uint8Array | string, type?: string): Promise<FileObject> {
  checkName(name);
  if (!(data instanceof Uint8Array) && typeof data !== "string") throw new TypeError("data must be bytes or text");
  const body = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  if (body.byteLength > maxObject) throw new TooLarge();
  const response = await ask("PUT", "/files/" + name, { body, type: type ?? (typeof data === "string" ? "text/plain; charset=utf-8" : "application/octet-stream") });
  if (response.status !== 201) throw await refusal(response);
  return object(await json(response));
}

// get reads a file; null when the tool has none of that name.
export async function get(name: string): Promise<FileData | null> {
  checkName(name);
  const response = await ask("GET", "/files/" + name);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200) throw await refusal(response);
  const data = await read(response, maxObject);
  return { data, type: response.headers.get("content-type") ?? "application/octet-stream", size: data.byteLength };
}

// list says the files whose name starts with prefix, in the order of their
// names, after the name after, 1000 at most; next is the name to ask after
// for the following page, null once all were said.
export async function list(options: { prefix?: string; after?: string } = {}): Promise<FilePage> {
  const query = new URLSearchParams();
  if (options.prefix !== undefined && options.prefix !== "") {
    if (typeof options.prefix !== "string" || options.prefix.length > 807 || !/^[A-Za-z0-9._\/-]*$/u.test(options.prefix)) throw new ChestError("invalid_name", 400, "invalid prefix");
    query.set("prefix", options.prefix);
  }
  if (options.after !== undefined && options.after !== "") query.set("after", checkName(options.after));
  const response = await ask("GET", "/files" + (query.size ? "?" + query.toString() : ""));
  if (response.status !== 200) throw await refusal(response);
  const body = await json(response);
  const page = body as { files?: unknown; next?: unknown } | null;
  if (!page || !Array.isArray(page.files) || page.files.length > 1000 || !(page.next === null || (typeof page.next === "string" && namePattern.test(page.next)))) throw new Unavailable();
  return { files: page.files.map(object), next: page.next };
}

// remove deletes a file; false when the tool had none of that name.
async function remove(name: string): Promise<boolean> {
  checkName(name);
  const response = await ask("DELETE", "/files/" + name);
  if (response.status === 204) return true;
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  throw await refusal(response);
}
export { remove as delete };

// url signs a link to the file as it is now, on the tool's team host: anyone
// who has it opens the file, without signing in, for expiresIn seconds
// (15 minutes), or until the file changes or goes. Give it to a member's
// browser, never to a public page.
export async function url(name: string): Promise<{ url: string; expiresIn: number }> {
  checkName(name);
  const response = await ask("POST", "/files/url", { body: JSON.stringify({ name }), type: "application/json" });
  if (response.status !== 200) throw await refusal(response);
  const body = (await json(response)) as { url?: unknown; expires_in?: unknown } | null;
  if (!body || typeof body.url !== "string" || !/^https:\/\/[^/?#]+\/_chest\/files\/[A-Za-z0-9_.-]{1,1536}$/u.test(body.url) || typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in) || body.expires_in <= 0) throw new Unavailable();
  return { url: body.url, expiresIn: body.expires_in };
}
