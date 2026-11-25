import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Level } from "./folders.js";
import type { Member } from "./member.js";

// The folders of Files of a fake Chest (testing.ts): the tool's API
// (/folders, /documents/*) and the documents host — on the fake Chest's own
// origin — under the rules of a Chest (files.md, “For apps: the SDK”): the
// tool reaches only the folders it was given and those inside them, at its
// grant capped by the level its version asks; on a member's request (their
// Chest-Opener ticket) only what that member also sees, at the lower of
// both; nobody's request gets the tool's grants. Not a published module.

// A folder as a test gives it: its identifier (32 hex characters, a new one
// when not said), its name, the tool's grant on it (for a folder given —
// the top ones —: the version's level when not said, never above it), the
// members who see it and at which level (inherited by the folders inside
// it, which may give more), its documents by name, and its folders.
export type FakeFolder = { id?: string; name: string; level?: Level; members?: Record<string, Level>; files?: Record<string, Uint8Array | string>; folders?: FakeFolder[] };
// The folders of a fake Chest: the level the tool's version asks ("edit"
// when not said) and the folders the owner gave it.
export type FakeFoldersOptions = { level?: Level; given?: FakeFolder[] };
// A document as a fake Chest keeps it: its folder, name, type (what its
// content is), content, when it was added and last replaced, whether it is
// in Recently removed, and how many versions came before this one.
export type FakeDocument = { id: string; folder: string; name: string; type: string; data: Uint8Array; added: string; updated: string; removed: boolean; versions: number };
// An open of a document, as the Chest journals it: the document, and the
// member the tool opened it for (null: for nobody).
export type FakeDocumentOpen = { document: string; member: string | null };
// What a test reads and changes: the folders as given, with their
// identifiers; the documents by identifier; the opens, in order.
export type FakeFolders = { given: FakeFolder[]; documents: Map<string, FakeDocument>; opens: FakeDocumentOpen[] };

// What the fake Chest gives the folders: where it serves, the member a
// ticket proves (null for none valid), who has the tool, what a content is,
// and how it reads a body and answers.
export type FakeFoldersDeps = {
  origin: () => string;
  ticketMember: (ticket: string | string[] | undefined) => string | null;
  members: () => Member[];
  typeOf: (data: Buffer) => string;
  body: (request: IncomingMessage, limit: number) => Promise<Buffer | null>;
  send: (response: ServerResponse, status: number, value?: unknown, headers?: Record<string, string>) => void;
};

// The bounds of a Chest (chest/officefiles, chest/portal): a page of a
// folder, the largest document the fake keeps (a Chest keeps 2 GiB), the
// lives of a link and of an upload link in seconds.
const filesPage = 200, maxDocument = 64 << 20, documentLife = 300, uploadLife = 900;
const newId = (): string => randomBytes(16).toString("hex");
const newToken = (): string => randomBytes(18).toString("base64url") + "." + randomBytes(12).toString("base64url");
const rank = (level: Level | undefined): number => level === "edit" ? 2 : level === "view" ? 1 : 0;
const lower = (a: Level | undefined, b: Level | undefined): Level | undefined => rank(a) <= rank(b) ? a : b;
const higher = (a: Level | undefined, b: Level | undefined): Level | undefined => rank(a) >= rank(b) ? a : b;
// The Chest's rule of a document's name (officefiles validName).
const validName = (name: string): boolean => name === name.trim() && name !== "" && name !== "." && name !== ".." && [...name].length <= 255 && !/[\p{Cc}\p{Cf}\p{Cs}/\\]/u.test(name);

// A folder as the fake keeps it: its parent, the tool's grant (a folder
// given) and its members' levels, its own only.
type Node = { id: string; name: string; parent: string | null; grant?: Level; members: Record<string, Level> };
// Who acts: the member of the request, or nobody.
type Asker = { member: string | null };

// fakeFolders makes the folders of a fake Chest from what a test gives.
export function fakeFolders(options: FakeFoldersOptions, deps: FakeFoldersDeps) {
  const asked: Level = options.level ?? "edit";
  const nodes = new Map<string, Node>();
  const state: FakeFolders = { given: [], documents: new Map(), opens: [] };
  const now = () => new Date().toISOString();
  // Links on the documents host: what each token opens, until when.
  const links = new Map<string, { document: string; member: string | null; download: boolean; exp: number }>();
  const uploads = new Map<string, { folder: string; name: string; size: number; member: string | null; exp: number }>();

  const keep = (given: FakeFolder, parent: string | null): FakeFolder => {
    const id = given.id ?? newId();
    if (!/^[0-9a-f]{32}$/u.test(id) || nodes.has(id)) throw new Error(`fakeChest: a folder's id is 32 hex characters, once: ${id}`);
    nodes.set(id, { id, name: given.name, parent, ...(parent === null ? { grant: lower(given.level ?? asked, asked)! } : {}), members: { ...given.members } });
    for (const [name, content] of Object.entries(given.files ?? {})) add(id, name, Buffer.from(content));
    return { ...given, id, folders: (given.folders ?? []).map(inside => keep(inside, id)) };
  };

  // chain is a folder and the folders above it, up to the one given.
  const chain = (id: string): Node[] => {
    const found: Node[] = [];
    for (let node = nodes.get(id); node; node = node.parent === null ? undefined : nodes.get(node.parent)) found.push(node);
    return found;
  };
  // level is what the asker reaches of a folder: the tool's grant, and on a
  // member's request the lower of it and the member's level there.
  const level = (id: string, asker: Asker): Level | undefined => {
    const above = chain(id);
    const grant = above.at(-1)?.grant;
    if (asker.member === null) return grant;
    return lower(grant, above.reduce<Level | undefined>((best, node) => higher(best, node.members[asker.member!]), undefined));
  };

  function add(folder: string, name: string, data: Buffer): FakeDocument {
    const same = [...state.documents.values()].find(d => d.folder === folder && !d.removed && d.name.toLowerCase() === name.toLowerCase());
    const at = now();
    const document: FakeDocument = same
      ? { ...same, type: deps.typeOf(data), data: new Uint8Array(data), updated: at, versions: same.versions + 1 }
      : { id: newId(), folder, name, type: deps.typeOf(data), data: new Uint8Array(data), added: at, updated: at, removed: false, versions: 0 };
    state.documents.set(document.id, document);
    return document;
  }
  const shown = (d: FakeDocument) => ({ id: d.id, name: d.name, type: d.type, size: d.data.byteLength, added: d.added, updated: d.updated });
  const reached = (id: string, asker: Asker): FakeDocument | undefined => {
    const d = state.documents.get(id);
    return d && !d.removed && level(d.folder, asker) ? d : undefined;
  };

  // asker reads who a request acts for; false once it is refused.
  function askerOf(request: IncomingMessage, response: ServerResponse): Asker | false {
    const ticket = request.headers["chest-opener"];
    if (ticket === undefined) return { member: null };
    const member = deps.ticketMember(ticket);
    if (member === null) return void deps.send(response, 401, { error: "member_required" }), false;
    if (!deps.members().some(m => m.id === member)) return void deps.send(response, 403, { error: "access_removed" }), false;
    return { member };
  }

  // api answers the tool's calls: /folders and /documents/*.
  async function api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const route = `${request.method} ${url.pathname.replace(/[0-9a-f]{32}/gu, "{id}")}`;
    const ids = url.pathname.match(/[0-9a-f]{32}/gu) ?? [];
    const writes = ["PUT /folders/{id}/files", "POST /folders/{id}/upload-url", "POST /documents/{id}/remove"].includes(route);
    if (!["GET /folders", "GET /folders/{id}/files", "GET /documents/{id}", "POST /documents/{id}/url", ...(writes ? [route] : [])].includes(route)) return deps.send(response, 404, { error: "not_found" });
    if (writes && asked !== "edit") return deps.send(response, 403, { error: "capability_not_granted" });
    const asker = askerOf(request, response);
    if (!asker) return;
    const id = ids[0] ?? "";
    switch (route) {
      case "GET /folders": {
        const given = [...nodes.values()].filter(n => n.parent === null).flatMap(n => { const l = level(n.id, asker); return l ? [{ id: n.id, name: n.name, level: l }] : []; });
        return deps.send(response, 200, { folders: given });
      }
      case "GET /folders/{id}/files": {
        const l = level(id, asker), after = url.searchParams.get("after");
        if (!l) return deps.send(response, 404, { error: "not_found" });
        if ([...url.searchParams.keys()].some(k => k !== "after")) return deps.send(response, 400, { error: "invalid_query" });
        const key = (d: FakeDocument) => d.name.toLowerCase() + "\u0000" + d.id;
        const all = [...state.documents.values()].filter(d => d.folder === id && !d.removed).sort((a, b) => key(a) < key(b) ? -1 : 1);
        const from = after === null ? undefined : state.documents.get(after);
        const rest = from ? all.filter(d => key(d) > key(from)) : all;
        const page = rest.slice(0, filesPage);
        const inside = [...nodes.values()].filter(n => n.parent === id && level(n.id, asker)).map(n => ({ id: n.id, name: n.name }));
        return deps.send(response, 200, { folder: { id, name: nodes.get(id)!.name, level: l }, folders: inside, files: page.map(shown), next: rest.length > filesPage ? page.at(-1)!.id : null });
      }
      case "GET /documents/{id}": {
        const d = reached(id, asker);
        if (!d) return deps.send(response, 404, { error: "not_found" });
        state.opens.push({ document: d.id, member: asker.member });
        return void response.writeHead(200, { "Content-Type": d.type, "Content-Length": String(d.data.byteLength) }).end(d.data);
      }
      case "POST /documents/{id}/url": {
        const d = reached(id, asker), raw = await deps.body(request, 4096);
        let download: unknown = false;
        try { download = (JSON.parse(raw?.toString() ?? "") as { download?: unknown }).download ?? false; } catch { download = undefined; }
        if (typeof download !== "boolean") return deps.send(response, 400, { error: "invalid_body" });
        if (!d) return deps.send(response, 404, { error: "not_found" });
        const token = newToken();
        links.set(token, { document: d.id, member: asker.member, download, exp: Date.now() + documentLife * 1000 });
        return deps.send(response, 200, { url: deps.origin() + "/d/" + token, expires_in: documentLife });
      }
      case "PUT /folders/{id}/files": {
        const name = url.searchParams.get("name");
        if (name === null || [...url.searchParams.keys()].length !== 1) return deps.send(response, 400, { error: "invalid_query" });
        const refused = writable(id, name, asker);
        if (refused) return deps.send(response, refused.status, { error: refused.error });
        const data = await deps.body(request, maxDocument);
        if (data === null) return deps.send(response, 400, { error: "invalid_size" });
        return deps.send(response, 201, shown(add(id, name, data)));
      }
      case "POST /folders/{id}/upload-url": {
        const raw = await deps.body(request, 4096);
        let command: { name?: unknown; size?: unknown } | null = null;
        try { command = JSON.parse(raw?.toString() ?? ""); } catch { command = null; }
        const { name, size } = command ?? {};
        if (typeof name !== "string" || typeof size !== "number" || !Number.isSafeInteger(size)) return deps.send(response, 400, { error: "invalid_body" });
        if (size < 0 || size > maxDocument) return deps.send(response, 400, { error: "invalid_size" });
        const refused = writable(id, name, asker);
        if (refused) return deps.send(response, refused.status, { error: refused.error });
        const token = newToken();
        uploads.set(token, { folder: id, name, size, member: asker.member, exp: Date.now() + uploadLife * 1000 });
        return deps.send(response, 200, { url: deps.origin() + "/u/" + token, expires_in: uploadLife });
      }
      case "POST /documents/{id}/remove": {
        const d = reached(id, asker);
        if (!d) return deps.send(response, 404, { error: "not_found" });
        if (level(d.folder, asker) !== "edit") return deps.send(response, 403, { error: "forbidden" });
        d.removed = true;
        return deps.send(response, 200, {});
      }
    }
  }

  // writable says why the asker may not add a document named name to a
  // folder, if they may not.
  function writable(folder: string, name: string, asker: Asker): { status: number; error: string } | null {
    const l = level(folder, asker);
    if (!l) return { status: 404, error: "not_found" };
    if (l !== "edit") return { status: 403, error: "forbidden" };
    return validName(name) ? null : { status: 400, error: "invalid_name" };
  }

  // host serves the documents host: a document by a link (GET /d/), a
  // document added by an upload link, taken once (PUT /u/) — each checked
  // again for who it was signed for.
  async function host(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const token = url.pathname.slice(3);
    if (request.method === "GET" && url.pathname.startsWith("/d/")) {
      const link = links.get(token), d = link && Date.now() < link.exp ? reached(link.document, link) : undefined;
      if (!link || !d || (link.member !== null && !deps.members().some(m => m.id === link.member))) return void response.writeHead(404).end();
      state.opens.push({ document: d.id, member: link.member });
      const shownInline = !link.download && d.type.startsWith("image/");
      return void response.writeHead(200, { "Content-Type": shownInline ? d.type : "application/octet-stream", "Content-Disposition": shownInline ? "inline" : "attachment", "Content-Length": String(d.data.byteLength) }).end(d.data);
    }
    if (request.method === "PUT" && url.pathname.startsWith("/u/")) {
      const up = uploads.get(token);
      uploads.delete(token);
      if (!up || Date.now() >= up.exp || (up.member !== null && !deps.members().some(m => m.id === up.member)) || level(up.folder, up) !== "edit") return deps.send(response, 403, { error: "invalid_token" });
      const data = await deps.body(request, up.size);
      if (data === null || data.length !== up.size) return deps.send(response, 400, { error: "invalid_size" });
      return deps.send(response, 201, shown(add(up.folder, up.name, data)));
    }
    deps.send(response, 404, { error: "not_found" });
  }

  state.given = (options.given ?? []).map(given => keep(given, null));
  return { folders: state, api, host };
}
