import type { IncomingMessage } from "node:http";
import { ask, chestLink, errorCode, json, openerTicket, read, refusal } from "./api.js";
import { CapabilityNotGranted, ChestError, MemberRequired, NotAllowed, TooLarge, Unavailable } from "./errors.js";

// The folders of Files — the company's storage in the Chest — that the
// owner or an admin gave the tool, for a server tool whose chest.json
// declares "capabilities": ["folders"] with what for and at which level:
//
//   "folders": { "purpose": "Keeps receipts with their expenses", "level": "edit" }
//
// Installing gives no folder: the owner gives one on the tool's page. The
// tool never lists the tree, never learns of a folder it was not given,
// never shares; it reaches the folders through the Chest's API (CHEST_API,
// api.ts), never a mount.
//
//   import * as folders from "@argentic/chest-sdk/folders";
//   // On a member's request: only what that member also sees, at the lower level.
//   const given = await folders.list(request);
//   const page = await folders.files(request, given[0].id);
//   const receipt = await folders.put(request, given[0].id, "Taxi 12 March.pdf", bytes);
//   const { url } = await folders.url(request, receipt.id);   // 5 min, the documents host
//   // A schedule or an event, with nobody behind it: the tool's own grants.
//   const all = await folders.list(null);
//
// Who acts is the first argument of every call, never left out: the
// request of a member (its Chest-Opener ticket travels with it: the Chest
// gives the intersection of the tool's grants and that member's access), or
// null for nobody (a schedule, an event: the tool's grants, as the owner
// read when giving the folder: “Expenses will see 61 documents, also when
// nobody is using it”). A request without a ticket is MemberRequired: it is
// never read as nobody, which would reach more. Every open is journaled in
// the Chest under the tool's name for its member (“Expenses for Claire”).
//
// Errors: MemberRequired (401: no member's ticket, or it expired — a
// request lasts 60 seconds), NotAllowed (403: the member is no longer in
// the team), CapabilityNotGranted (403: no folders, or a write of a version
// that asks view), ChestError forbidden (403: the folder is not editable
// for this asker), not_found (404: a folder or a document the asker does
// not reach, or none), invalid_name, invalid_size (400), StorageFull (507),
// TooLarge (a document beyond 2 GiB), Unavailable (503, or the Chest not
// reached).

// The level of a folder: open and download (view), or also add, replace
// and remove documents (edit).
export type Level = "view" | "edit";
// Who a call acts for: the request of a member, or null for nobody.
export type Asker = IncomingMessage | Request | null;
// A folder the tool was given, as it reaches it now.
export type Folder = { id: string; name: string; level: Level };
// A document of a folder: never who added it. added and updated are ISO
// 8601 instants; type is what its content is, as the Chest recognised it.
export type FolderFile = { id: string; name: string; type: string; size: number; added: string; updated: string };
// A folder's page: the folder and its level, the folders inside it, a page
// of its documents (200 at most, by name) and the document to ask after for
// the next (null at the end). Never the path above it, nor who else holds it.
export type FolderPage = { folder: Folder; folders: { id: string; name: string }[]; files: FolderFile[]; next: string | null };
// A document's content.
export type FolderFileData = { data: Uint8Array; type: string; size: number };

// The largest document of Files (officefiles.MaxDocument).
const maxDocument = 2 * 1024 ** 3;
// The identifier of a folder or a document (officefiles.ValidID).
const idPattern = /^[0-9a-f]{32}$/u;
// What a link to a document and an upload link are on the documents host,
// and how long the Chest makes them live, in seconds.
const documentPath = "/d/", uploadPath = "/u/", documentLife = 300, uploadLife = 900;
// A page of a folder (officefiles.FilesPage).
const filesPage = 200;

const isId = (id: unknown): id is string => typeof id === "string" && idPattern.test(id);
// checkId holds an identifier to its grammar: one of another shape names
// nothing the asker reaches.
function checkId(id: unknown, what: string): string {
  if (!isId(id)) throw new ChestError("not_found", 404, `no such ${what}`);
  return id;
}

// checkName holds a document's name to the Chest's rule (officefiles
// validName): 1 to 255 characters, no space around it, not "." nor "..",
// no slash, backslash, control or format character, nor half a surrogate
// pair (not UTF-8).
function checkName(name: unknown): string {
  if (typeof name !== "string" || name !== name.trim() || name === "" || name === "." || name === ".." || [...name].length > 255 || /[\p{Cc}\p{Cf}\p{Cs}/\\]/u.test(name)) throw new ChestError("invalid_name", 400, "a document's name is 1 to 255 characters, without a slash or a control character");
  return name;
}

// headersOf are the headers that say who acts: the member's ticket, none
// for nobody. A request without a ticket is refused here.
function headersOf(asker: Asker): Record<string, string> {
  if (asker === null) return {};
  if (typeof asker !== "object" || !("headers" in asker)) throw new TypeError("who acts is a member's request, or null for nobody");
  const ticket = openerTicket(asker);
  if (ticket === null) throw new MemberRequired();
  return { "Chest-Opener": ticket };
}

// failed turns an answer that is not a success into what the tool tests.
async function failed(response: Response): Promise<ChestError> {
  if (response.status === 401) {
    await response.body?.cancel();
    return new MemberRequired();
  }
  if (response.status !== 403) return refusal(response, "folders");
  const code = await errorCode(response);
  if (code === "access_removed") return new NotAllowed();
  if (code === "capability_not_granted") return new CapabilityNotGranted("folders");
  return new ChestError(code, 403, `the Chest refused: ${code}`);
}

async function call(asker: Asker, method: string, path: string, init: { body?: Uint8Array<ArrayBuffer> | string; type?: string } = {}): Promise<Response> {
  return ask("folders", method, path, { ...init, headers: headersOf(asker) });
}

// answer reads the JSON of an answer of status, or throws its refusal.
async function answer(response: Response, status: number): Promise<Record<string, unknown>> {
  if (response.status !== status) throw await failed(response);
  const body = await json(response);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Unavailable();
  return body as Record<string, unknown>;
}

const isLevel = (value: unknown): value is Level => value === "view" || value === "edit";
const isInstant = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;

function folder(value: unknown): Folder {
  const f = value as Record<string, unknown> | null;
  if (!f || !isId(f.id) || !isName(f.name) || !isLevel(f.level)) throw new Unavailable();
  return { id: f.id, name: f.name, level: f.level };
}

function file(value: unknown): FolderFile {
  const f = value as Record<string, unknown> | null;
  if (!f || !isId(f.id) || !isName(f.name) || typeof f.type !== "string" || f.type.length > 255 || typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > maxDocument || !isInstant(f.added) || !isInstant(f.updated)) throw new Unavailable();
  return { id: f.id, name: f.name, type: f.type, size: f.size, added: f.added, updated: f.updated };
}

// list says the folders the tool was given that the asker reaches now, each
// at the lower of the tool's level and the member's.
export async function list(asker: Asker): Promise<Folder[]> {
  const body = await answer(await call(asker, "GET", "/folders"), 200);
  if (!Array.isArray(body.folders)) throw new Unavailable();
  return body.folders.map(folder);
}

// files says a folder the asker reaches — one given, or one inside it —:
// its folders and a page of its documents, after the document after.
export async function files(asker: Asker, folderId: string, options: { after?: string } = {}): Promise<FolderPage> {
  checkId(folderId, "folder");
  const after = options.after === undefined ? "" : "?after=" + checkId(options.after, "document");
  const body = await answer(await call(asker, "GET", `/folders/${folderId}/files${after}`), 200);
  const { folders, files: documents, next } = body;
  if (!Array.isArray(folders) || !Array.isArray(documents) || documents.length > filesPage || !(next === null || isId(next))) throw new Unavailable();
  const inside = folders.map(value => {
    const f = value as Record<string, unknown> | null;
    if (!f || !isId(f.id) || !isName(f.name)) throw new Unavailable();
    return { id: f.id, name: f.name };
  });
  return { folder: folder(body.folder), folders: inside, files: documents.map(file), next };
}

// get reads a document's content; null when the asker reaches no document
// of that identifier. For a large document a member opens, url is lighter:
// the browser downloads it from the documents host.
export async function get(asker: Asker, fileId: string): Promise<FolderFileData | null> {
  if (!isId(fileId)) return null;
  const response = await call(asker, "GET", `/documents/${fileId}`);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (response.status !== 200) throw await failed(response);
  const data = await read(response, maxDocument);
  return { data, type: response.headers.get("content-type") ?? "application/octet-stream", size: data.byteLength };
}

// url signs a link to a document as it is now, on the documents host of
// the Chest (an origin of its own, never the tool's): it opens it without
// signing in for expiresIn seconds (5 minutes), and only while the asker
// still reaches it, checked at each open; downloaded when download is
// true, otherwise shown when it is an image (downloaded otherwise). Give
// it to the member's browser.
export async function url(asker: Asker, fileId: string, options: { download?: boolean } = {}): Promise<{ url: string; expiresIn: number }> {
  checkId(fileId, "document");
  if (options.download !== undefined && typeof options.download !== "boolean") throw new TypeError("download must be true or false");
  const body = await answer(await call(asker, "POST", `/documents/${fileId}/url`, { body: JSON.stringify({ download: options.download ?? false }), type: "application/json" }), 200);
  const token = chestLink(body.url, documentPath);
  if (token === undefined || token.length > 1536 || typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > documentLife) throw new Unavailable();
  return { url: body.url as string, expiresIn: body.expires_in };
}

// put adds a document named name to a folder the asker can edit; a
// document of that name there (letter case aside) gets it as a new version,
// the one before kept. Its type is what its content is.
export async function put(asker: Asker, folderId: string, name: string, data: Uint8Array | string): Promise<FolderFile> {
  checkId(folderId, "folder");
  checkName(name);
  if (!(data instanceof Uint8Array) && typeof data !== "string") throw new TypeError("data must be bytes or text");
  const body = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  if (body.byteLength > maxDocument) throw new TooLarge();
  return file(await answer(await call(asker, "PUT", `/folders/${folderId}/files?name=${encodeURIComponent(name)}`, { body }), 201));
}

// uploadUrl authorises the member's browser to add one document of size
// bytes, named name, to a folder the asker can edit, sending it itself to
// the documents host — from the tool's team host only —, once, within
// expiresIn seconds (15 minutes); the right to edit is checked again when
// it comes:
//   const sent = await fetch(up.url, { method: "PUT", body: file }); // 201 {id, name, type, size, added, updated}
export async function uploadUrl(asker: Asker, folderId: string, name: string, size: number): Promise<{ url: string; method: "PUT"; expiresIn: number }> {
  checkId(folderId, "folder");
  checkName(name);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) throw new ChestError("invalid_size", 400, "size is a number of bytes");
  if (size > maxDocument) throw new TooLarge();
  const body = await answer(await call(asker, "POST", `/folders/${folderId}/upload-url`, { body: JSON.stringify({ name, size }), type: "application/json" }), 200);
  const token = chestLink(body.url, uploadPath);
  if (token === undefined || token.length > 2048 || typeof body.expires_in !== "number" || !Number.isInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > uploadLife) throw new Unavailable();
  return { url: body.url as string, method: "PUT", expiresIn: body.expires_in };
}

// remove moves a document of a folder the asker can edit to Recently
// removed, where the owner and the team can restore it; false when the
// asker reaches no document of that identifier.
export async function remove(asker: Asker, fileId: string): Promise<boolean> {
  if (!isId(fileId)) return false;
  const response = await call(asker, "POST", `/documents/${fileId}/remove`);
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  await answer(response, 200);
  return true;
}
