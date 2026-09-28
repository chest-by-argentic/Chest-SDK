import { json, read, ask as chest, refusal as refused } from "./api.js";
import { ChestError, TooLarge, Unavailable } from "./errors.js";

// The private files of a server tool whose chest.json declares
// "capabilities": ["files"]: kept by its Chest (1 GiB, 10,000 objects, 32 MiB
// each, unless the manifest asks otherwise: "files": {"quota", "maxObject"}),
// never on the tool's own disk, through the Chest's API (CHEST_API, api.ts).
// A call reaches the tool's files only: its instance is its identity.
//
//   import * as files from "@argentic/chest-sdk/files";
//   await files.put("photos/cat.png", bytes, "image/png");
//   const { url } = await files.url("photos/cat.png");   // 15 min, team host
//   const up = await files.uploadUrl("photos/", { types: ["image/*"] }); // a member's browser sends it
//
// Names: up to 8 segments of 1–100 letters, digits, '.', '_' or '-',
// separated by '/', none starting with '.' or '-'. Errors: CapabilityNotGranted
// (403), TooLarge (413), QuotaExceeded (429), Unavailable (503, or the Chest
// not reached), ChestError otherwise (invalid_name, invalid_type,
// no_thumbnail 400, not_found 404…).

// width and height: of a JPEG, PNG, GIF or WebP image the Chest measured.
export type FileObject = { name: string; type: string; size: number; updated: string; width?: number; height?: number };
export type FileData = { data: Uint8Array; type: string; size: number };
export type FilePage = { files: FileObject[]; next: string | null };

// The largest object a manifest may ask; the Chest holds each tool to its own.
const maxObject = 512 << 20;
// The grammar of a name, the same as the Chest's (chest/toolfiles, name).
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,7}$/u;
// A media type an upload accepts: without parameters, "family/*" for a whole
// family (RFC 6838 names).
const typePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,62})$/u;
// Where the team host serves a link, and where it takes an upload.
const linkPattern = /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?\/_chest\/files\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;
const uploadPattern = /^https:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?\/_chest\/files\/upload\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u;
// The longest an upload may wait, in seconds.
const uploadLife = 900;

function checkName(name: unknown): string {
  if (typeof name !== "string" || !namePattern.test(name)) throw new ChestError("invalid_name", 400, "invalid file name");
  return name;
}

const ask = (method: string, path: string, init?: { body?: Uint8Array<ArrayBuffer> | string; type?: string }) => chest("files", method, path, init);
const refusal = (response: Response) => refused(response, "files");

function isObject(value: unknown): value is FileObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o["name"] === "string" && namePattern.test(o["name"]) && typeof o["type"] === "string" && o["type"].length <= 200 && typeof o["size"] === "number" && Number.isSafeInteger(o["size"]) && o["size"] >= 0 && typeof o["updated"] === "string" && isSide(o["width"]) && isSide(o["height"]) && (o["width"] === undefined) === (o["height"] === undefined);
}
// isSide accepts a side of an image the Chest measured, or none.
function isSide(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65536);
}
function object(value: unknown): FileObject {
  if (!isObject(value)) throw new Unavailable();
  return { name: value.name, type: value.type, size: value.size, updated: value.updated, ...(value.width !== undefined ? { width: value.width, height: value.height! } : {}) };
}

// put keeps data as the file name, of type type (application/octet-stream
// when none), replacing the one of that name.
export async function put(name: string, data: Uint8Array | string, type?: string): Promise<FileObject> {
  checkName(name);
  if (!(data instanceof Uint8Array) && typeof data !== "string") throw new TypeError("data must be bytes or text");
  if (data instanceof Uint8Array && data.byteLength > maxObject) throw new TooLarge();
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

// stat says what the tool keeps as the file name, without reading it; null
// when it has none of that name.
export async function stat(name: string): Promise<FileObject | null> {
  checkName(name);
  const response = await ask("GET", "/files/" + name + "?stat");
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200) throw await refusal(response);
  const found = object(await json(response));
  if (found.name !== name) throw new Unavailable();
  return found;
}

// move renames the file from as to, at once, replacing the one named to;
// ChestError not_found when the tool has none named from.
export async function move(from: string, to: string): Promise<FileObject> {
  checkName(from);
  checkName(to);
  const response = await ask("POST", "/files/move", { body: JSON.stringify({ from, to }), type: "application/json" });
  if (response.status !== 200) throw await refusal(response);
  const moved = object(await json(response));
  if (moved.name !== to) throw new Unavailable();
  return moved;
}

// url signs a link to the file as it is now, on the tool's team host: anyone
// who has it opens the file, without signing in, for expiresIn seconds
// (15 minutes), or until the file changes or goes. thumbnail links to the
// image reduced to 256 or 1024 pixels (JPEG, PNG, GIF, WebP; ChestError
// no_thumbnail otherwise); download has it saved rather than shown. Give it
// to a member's browser, never to a public page.
export async function url(name: string, options: { thumbnail?: 256 | 1024; download?: boolean } = {}): Promise<{ url: string; expiresIn: number }> {
  checkName(name);
  const { thumbnail, download } = options;
  if (thumbnail !== undefined && thumbnail !== 256 && thumbnail !== 1024) throw new ChestError("invalid_body", 400, "a thumbnail is 256 or 1024 pixels");
  if (download !== undefined && typeof download !== "boolean") throw new TypeError("download must be true or false");
  const command = { name, ...(thumbnail !== undefined ? { thumbnail } : {}), ...(download !== undefined ? { download } : {}) };
  const response = await ask("POST", "/files/url", { body: JSON.stringify(command), type: "application/json" });
  if (response.status !== 200) throw await refusal(response);
  const body = (await json(response)) as { url?: unknown; expires_in?: unknown } | null;
  const token = body && typeof body.url === "string" ? linkPattern.exec(body.url)?.[2] : undefined;
  if (!body || token === undefined || token.length > 1536 || typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in) || body.expires_in <= 0) throw new Unavailable();
  return { url: body.url as string, expiresIn: body.expires_in };
}

// uploadUrl authorises one upload from a member's browser, which sends the
// file itself to url, the tool's team host, with its session:
//   fetch(up.url, { method: "PUT", body: file, headers: { "Content-Type": file.type } })
// name is the object's, or a folder ending in '/' where the Chest names it;
// maxSize bytes at most (the tool's largest object when not said), of types
// (up to 8, "image/*" for a family; any when not said), within expiresIn
// seconds (1–900, 900 when not said), once. Call it from a /chest route,
// after member(); then stat the name before recording it.
export async function uploadUrl(name: string, options: { maxSize?: number; types?: string[]; expiresIn?: number } = {}): Promise<{ url: string; method: "PUT"; expiresIn: number }> {
  if (typeof name !== "string" || !(name.endsWith("/") ? namePattern.test(name.slice(0, -1)) && name.split("/").length <= 8 : namePattern.test(name))) throw new ChestError("invalid_name", 400, "invalid file or folder name");
  const { maxSize, types, expiresIn } = options;
  if (maxSize !== undefined && (typeof maxSize !== "number" || !Number.isSafeInteger(maxSize) || maxSize < 1)) throw new ChestError("invalid_body", 400, "maxSize is a number of bytes");
  if (maxSize !== undefined && maxSize > maxObject) throw new TooLarge();
  if (types !== undefined && (!Array.isArray(types) || types.length > 8 || types.some((t, i) => typeof t !== "string" || t.length > 100 || !typePattern.test(t) || types.indexOf(t) !== i))) throw new ChestError("invalid_type", 400, "invalid media types");
  if (expiresIn !== undefined && (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > uploadLife)) throw new ChestError("invalid_body", 400, "expiresIn is 1 to 900 seconds");
  const command = { name, ...(maxSize !== undefined ? { max_size: maxSize } : {}), ...(types !== undefined ? { types } : {}), ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}) };
  const response = await ask("POST", "/files/upload-url", { body: JSON.stringify(command), type: "application/json" });
  if (response.status !== 200) throw await refusal(response);
  const body = (await json(response)) as { url?: unknown; method?: unknown; expires_in?: unknown } | null;
  const token = body && typeof body.url === "string" ? uploadPattern.exec(body.url)?.[2] : undefined;
  if (!body || token === undefined || token.length > 2048 || body.method !== "PUT" || typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > uploadLife) throw new Unavailable();
  return { url: body.url as string, method: "PUT", expiresIn: body.expires_in };
}
