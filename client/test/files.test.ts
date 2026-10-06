import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { CapabilityNotGranted, ChestError, QuotaExceeded, StorageFull, TooLarge, Unavailable } from "../src/errors.js";
import * as files from "../src/files.js";

// A Chest's API as the broker answers it (chest/toolfiles of the Chest
// repository), in memory: the SDK is tested against its routes and codes.
type Kept = { type: string; data: Buffer; updated: string; width?: number; height?: number };
const kept = new Map<string, Kept>();
let refuse: { status: number; code: string } | null = null;
// An answer that is not the Chest's, given as it is with a 200.
let forged: { value: unknown } | null = null;
let seen: { method: string; url: string; type: string | undefined; body: string }[] = [];
const link = "https://web-chest.atelier.example/_chest/files/eyJ0b29sIjoid2ViIn0.c2lnbmF0dXJl";
const upload = "https://web-chest.atelier.example/_chest/files/upload/eyJ0b29sIjoid2ViIiwidXAiOjF9.c2lnbmF0dXJl";
// A visitor's: a path, on whichever address of the public part its page is.
const visitorUpload = "/_chest/files/upload/eyJ0b29sIjoid2ViIiwicHVibGljIjp0cnVlfQ.c2lnbmF0dXJl";

function answer(response: ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) return void response.writeHead(status).end();
  const raw = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }).end(raw);
}
async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const describe = (name: string, k: Kept) => ({ name, type: k.type, size: k.data.length, sha256: sha256(k.data), updated: k.updated, ...(k.width ? { width: k.width, height: k.height } : {}) });

const server: Server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const raw = await body(request);
  seen.push({ method: request.method ?? "", url: request.url ?? "", type: request.headers["content-type"], body: raw.toString() });
  if (refuse) return answer(response, refuse.status, { error: refuse.code });
  if (forged) return answer(response, 200, forged.value);
  if (request.method === "GET" && url.pathname === "/files") {
    const prefix = url.searchParams.get("prefix") ?? "", after = url.searchParams.get("after") ?? "";
    const names = [...kept.keys()].filter(n => n.startsWith(prefix) && n > after).sort();
    return answer(response, 200, { files: names.map(n => describe(n, kept.get(n)!)), next: null });
  }
  if (request.method === "POST" && url.pathname === "/files/url") {
    const { name, thumbnail } = JSON.parse(raw.toString()) as { name: string; thumbnail?: number };
    const object = kept.get(name);
    if (!object) return answer(response, 404, { error: "not_found" });
    if (thumbnail !== undefined && !object.width) return answer(response, 400, { error: "no_thumbnail" });
    return answer(response, 200, { url: link, expires_in: 900 });
  }
  if (request.method === "POST" && url.pathname === "/files/move") {
    const { from, to } = JSON.parse(raw.toString()) as { from: string; to: string };
    const object = kept.get(from);
    if (!object) return answer(response, 404, { error: "not_found" });
    kept.delete(from);
    kept.set(to, object);
    return answer(response, 200, describe(to, object));
  }
  if (request.method === "POST" && url.pathname === "/files/upload-url") {
    const command = JSON.parse(raw.toString()) as { max_size?: number; expires_in?: number; public?: boolean };
    // The tool's largest object: 32 MiB, as without a "files" key in its manifest.
    if ((command.max_size ?? 0) > 32 << 20) return answer(response, 413, { error: "too_large" });
    return answer(response, 200, { url: command.public ? visitorUpload : upload, method: "PUT", expires_in: command.expires_in ?? 900 });
  }
  const name = url.pathname.slice("/files/".length);
  const object = kept.get(name);
  if (request.method === "PUT") {
    const k = { type: request.headers["content-type"] ?? "application/octet-stream", data: raw, updated: new Date(0).toISOString() };
    kept.set(name, k);
    return answer(response, 201, describe(name, k));
  }
  if (!object) return answer(response, 404, { error: "not_found" });
  if (request.method === "GET" && url.search === "?stat") return answer(response, 200, describe(name, object));
  if (request.method === "GET") return void response.writeHead(200, { "Content-Type": object.type, "Content-Length": String(object.data.length) }).end(object.data);
  if (request.method === "DELETE") {
    kept.delete(name);
    return answer(response, 204);
  }
  answer(response, 405, { error: "method_not_allowed" });
});

const given = process.env["CHEST_API"];
before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env["CHEST_API"] = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
after(() => {
  server.close();
  if (given === undefined) delete process.env["CHEST_API"];
  else process.env["CHEST_API"] = given;
});
afterEach(() => {
  kept.clear();
  refuse = null;
  forged = null;
  seen = [];
});

test("put, get, list, delete and url, as the Chest's API answers them", async () => {
  assert.deepEqual(await files.put("notes/a.txt", "hello"), { name: "notes/a.txt", type: "text/plain; charset=utf-8", size: 5, sha256: sha256("hello"), updated: "1970-01-01T00:00:00.000Z" });
  await files.put("photos/cat.png", new Uint8Array([0x89, 0x50]), "image/png");
  await files.put("raw.bin", new Uint8Array([1, 2, 3]));
  assert.deepEqual(seen.map(s => [s.method, s.url, s.type]), [["PUT", "/files/notes/a.txt", "text/plain; charset=utf-8"], ["PUT", "/files/photos/cat.png", "image/png"], ["PUT", "/files/raw.bin", "application/octet-stream"]]);
  const got = await files.get("photos/cat.png");
  assert.deepEqual(got && { data: [...got.data], type: got.type, size: got.size }, { data: [0x89, 0x50], type: "image/png", size: 2 });
  assert.equal(await files.get("none"), null);
  const page = await files.list({ prefix: "notes/" });
  assert.deepEqual(page.files.map(f => f.name), ["notes/a.txt"]);
  assert.equal(page.next, null);
  assert.equal(seen.at(-1)?.url, "/files?prefix=notes%2F");
  assert.deepEqual((await files.list()).files.map(f => f.name), ["notes/a.txt", "photos/cat.png", "raw.bin"]);
  assert.deepEqual(await files.url("photos/cat.png"), { url: "https://web-chest.atelier.example/_chest/files/eyJ0b29sIjoid2ViIn0.c2lnbmF0dXJl", expiresIn: 900 });
  await assert.rejects(files.url("none"), (error: unknown) => error instanceof ChestError && error.code === "not_found" && error.status === 404);
  assert.equal(await files.delete("raw.bin"), true);
  assert.equal(await files.delete("raw.bin"), false);
});

test("the Chest's refusals are errors the tool tests", async () => {
  for (const [status, code, kind] of [[403, "capability_not_granted", CapabilityNotGranted], [413, "too_large", TooLarge], [429, "quota_exceeded", QuotaExceeded], [503, "unavailable", Unavailable]] as const) {
    refuse = { status, code };
    await assert.rejects(files.put("a", "x"), (error: unknown) => error instanceof kind && error instanceof ChestError && error.status === status && error.code === code, code);
  }
  refuse = { status: 400, code: "invalid_type" };
  await assert.rejects(files.put("a", "x", "nope"), (error: unknown) => error instanceof ChestError && error.code === "invalid_type" && error.status === 400);
});

test("stat, move and the options of a link, as the Chest's API answers them", async () => {
  await files.put("photos/cat.png", new Uint8Array([0x89, 0x50]), "image/png");
  kept.get("photos/cat.png")!.width = 640;
  kept.get("photos/cat.png")!.height = 480;
  await files.put("notes/a.txt", "hello");
  assert.deepEqual(await files.stat("photos/cat.png"), { name: "photos/cat.png", type: "image/png", size: 2, sha256: sha256(Buffer.from([0x89, 0x50])), updated: "1970-01-01T00:00:00.000Z", width: 640, height: 480 });
  assert.equal(seen.at(-1)?.url, "/files/photos/cat.png?stat");
  assert.deepEqual(await files.stat("notes/a.txt"), { name: "notes/a.txt", type: "text/plain; charset=utf-8", size: 5, sha256: sha256("hello"), updated: "1970-01-01T00:00:00.000Z" });
  assert.equal(await files.stat("none"), null);
  assert.deepEqual(await files.move("notes/a.txt", "archive/a.txt"), { name: "archive/a.txt", type: "text/plain; charset=utf-8", size: 5, sha256: sha256("hello"), updated: "1970-01-01T00:00:00.000Z" });
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { from: "notes/a.txt", to: "archive/a.txt" });
  assert.equal(await files.stat("notes/a.txt"), null);
  await assert.rejects(files.move("notes/a.txt", "b.txt"), (error: unknown) => error instanceof ChestError && error.code === "not_found" && error.status === 404);
  assert.deepEqual(await files.url("photos/cat.png", { thumbnail: 256 }), { url: link, expiresIn: 900 });
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { name: "photos/cat.png", thumbnail: 256 });
  await files.url("archive/a.txt", { download: true });
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { name: "archive/a.txt", download: true });
  await assert.rejects(files.url("archive/a.txt", { thumbnail: 1024 }), (error: unknown) => error instanceof ChestError && error.code === "no_thumbnail" && error.status === 400);
  const count = seen.length;
  await assert.rejects(files.url("photos/cat.png", { thumbnail: 512 as 256 }), (error: unknown) => error instanceof ChestError && error.code === "invalid_body");
  await assert.rejects(files.move("a", "../b"), (error: unknown) => error instanceof ChestError && error.code === "invalid_name");
  await assert.rejects(files.stat("a/"), ChestError);
  assert.equal(seen.length, count);
});

test("uploadUrl authorises one upload of a name or into a folder, within its bounds", async () => {
  assert.deepEqual(await files.uploadUrl("invoices/2026/0042.pdf", { maxSize: 10 << 20, types: ["application/pdf"] }), { url: upload, method: "PUT", expiresIn: 900 });
  assert.deepEqual(seen.map(s => [s.method, s.url, s.type, JSON.parse(s.body)]), [["POST", "/files/upload-url", "application/json", { name: "invoices/2026/0042.pdf", max_size: 10 << 20, types: ["application/pdf"] }]]);
  assert.deepEqual(await files.uploadUrl("photos/", { types: ["image/*", "application/pdf"], expiresIn: 60 }), { url: upload, method: "PUT", expiresIn: 60 });
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { name: "photos/", types: ["image/*", "application/pdf"], expires_in: 60 });
  await files.uploadUrl("a");
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { name: "a" });
  // Beyond the tool's own largest object: the Chest refuses.
  await assert.rejects(files.uploadUrl("big.bin", { maxSize: 100 << 20 }), TooLarge);
  refuse = { status: 503, code: "unavailable" };
  await assert.rejects(files.uploadUrl("a"), Unavailable);
  refuse = null;
  seen = [];
  for (const bad of ["", "/", "a//", "../a/", ".x/", "a/b/c/d/e/f/g/h/"]) await assert.rejects(files.uploadUrl(bad), (error: unknown) => error instanceof ChestError && error.code === "invalid_name", bad);
  for (const types of [["image/png; q=1"], ["Image/PNG"], ["image"], ["*/*"], ["image/png", "image/png"], Array.from({ length: 9 }, (_, i) => `image/x${i}`)]) {
    await assert.rejects(files.uploadUrl("a", { types }), (error: unknown) => error instanceof ChestError && error.code === "invalid_type", String(types));
  }
  for (const expiresIn of [0, 901, 1.5]) await assert.rejects(files.uploadUrl("a", { expiresIn }), (error: unknown) => error instanceof ChestError && error.code === "invalid_body", String(expiresIn));
  for (const maxSize of [0, -1, 1.5]) await assert.rejects(files.uploadUrl("a", { maxSize }), (error: unknown) => error instanceof ChestError && error.code === "invalid_body", String(maxSize));
  await assert.rejects(files.uploadUrl("a", { maxSize: (512 << 20) + 1 }), TooLarge);
  assert.deepEqual(seen, []);
});

test("uploadUrl authorises a visitor's upload into a folder, of the types it names, as a path", async () => {
  assert.deepEqual(await files.uploadUrl("applications/", { public: true, types: ["application/pdf", "image/*"] }), { url: visitorUpload, method: "PUT", expiresIn: 900 });
  assert.deepEqual(JSON.parse(seen.at(-1)!.body), { name: "applications/", types: ["application/pdf", "image/*"], public: true });
  seen = [];
  await assert.rejects(files.uploadUrl("applications/cv.pdf", { public: true, types: ["application/pdf"] }), (e: unknown) => e instanceof ChestError && e.code === "invalid_name");
  for (const types of [undefined, []]) await assert.rejects(files.uploadUrl("applications/", { public: true, ...(types ? { types } : {}) }), (e: unknown) => e instanceof ChestError && e.code === "invalid_type");
  await assert.rejects(files.uploadUrl("applications/", { public: "yes" as unknown as boolean, types: ["application/pdf"] }), TypeError);
  assert.deepEqual(seen, []);
  // A tool without a public part, a type the Chest does not recognise.
  for (const [status, code] of [[409, "no_public_part"], [400, "invalid_type"]] as const) {
    refuse = { status, code };
    await assert.rejects(files.uploadUrl("applications/", { public: true, types: ["text/plain"] }), (e: unknown) => e instanceof ChestError && e.code === code && e.status === status);
  }
  refuse = null;
  // A visitor's upload is a path of the Chest's, nothing else; a member's never one.
  for (const url of [upload, "/_chest/files/upload/a", "/_chest/files/a.b", "//evil.example/_chest/files/upload/a.b", "/_chest/files/upload/a.b?x=1", "/_chest/files/upload/" + "a".repeat(2047) + ".b"]) {
    forged = { value: { url, method: "PUT", expires_in: 900 } };
    await assert.rejects(files.uploadUrl("applications/", { public: true, types: ["application/pdf"] }), Unavailable, url);
  }
  forged = { value: { url: visitorUpload, method: "PUT", expires_in: 900 } };
  await assert.rejects(files.uploadUrl("photos/"), Unavailable);
});

test("a full disk is StorageFull, whatever the quota", async () => {
  refuse = { status: 507, code: "storage_full" };
  await assert.rejects(files.put("a.txt", "a"), (e: unknown) => e instanceof StorageFull && e.code === "storage_full" && e.status === 507);
});

test("an answer that is not the Chest's is Unavailable", async () => {
  const object = { name: "a", type: "image/png", size: 2, sha256: sha256("ab"), updated: "1970-01-01T00:00:00.000Z" };
  const answers: [() => Promise<unknown>, unknown][] = [
    [() => files.stat("a"), { ...object, name: "b" }],
    [() => files.stat("a"), { ...object, width: 0, height: 1 }],
    [() => files.stat("a"), { ...object, width: 10 }],
    [() => files.stat("a"), { ...object, width: 10, height: 70000 }],
    [() => files.stat("a"), { ...object, sha256: undefined }],
    [() => files.stat("a"), { ...object, sha256: sha256("ab").toUpperCase() }],
    [() => files.move("a", "c"), object],
    [() => files.url("a"), { url: "https://web-chest.atelier.example/_chest/files/upload/" + "a.b", expires_in: 900 }],
    [() => files.url("a"), { url: "https://web-chest.atelier.example/_chest/files/" + "a".repeat(1535) + ".b", expires_in: 900 }],
    [() => files.url("a"), { url: "http://web-chest.atelier.example/_chest/files/a.b", expires_in: 900 }],
    [() => files.url("a"), { url: "https://user@evil.example/_chest/files/a.b", expires_in: 900 }],
    // Local links are those of a fake Chest of this process only.
    [() => files.url("a"), { url: "http://127.0.0.1:3000/_chest/files/a.b", expires_in: 900 }],
    [() => files.url("a"), { url: "http://localhost:3000/_chest/files/a.b", expires_in: 900 }],
    [() => files.uploadUrl("a"), { url: "http://127.0.0.1:3000/_chest/files/upload/a.b", method: "PUT", expires_in: 900 }],
    [() => files.uploadUrl("a"), { url: link, method: "PUT", expires_in: 900 }],
    [() => files.uploadUrl("a"), { url: upload, method: "POST", expires_in: 900 }],
    [() => files.uploadUrl("a"), { url: upload, method: "PUT", expires_in: 901 }],
    [() => files.uploadUrl("a"), { url: upload + "?x=1", method: "PUT", expires_in: 900 }],
    [() => files.uploadUrl("a"), { url: "https://web-chest.atelier.example/_chest/files/upload/" + "a".repeat(2047) + ".b", method: "PUT", expires_in: 900 }],
  ];
  for (const [call, value] of answers) {
    forged = { value };
    await assert.rejects(call(), Unavailable, JSON.stringify(value).slice(0, 120));
  }
});

test("a local link is taken only on the origin of the Chest's API", async () => {
  const api = process.env["CHEST_API"]!;
  forged = { value: { url: api + "/_chest/files/a.b", expires_in: 900 } };
  assert.deepEqual(await files.url("a"), { url: api + "/_chest/files/a.b", expiresIn: 900 });
  for (const other of ["http://127.0.0.1:1", "http://localhost" + api.slice("http://127.0.0.1".length)]) {
    forged = { value: { url: other + "/_chest/files/a.b", expires_in: 900 } };
    await assert.rejects(files.url("a"), Unavailable, other);
  }
});

test("names outside the grammar and objects beyond 512 MiB never leave the tool", async () => {
  for (const bad of ["", "/a", "a/", "../etc/passwd", ".hidden", "a b", "a?b", "a%2Fb", "x".repeat(101)]) {
    await assert.rejects(files.put(bad, "x"), (error: unknown) => error instanceof ChestError && error.code === "invalid_name", bad);
    await assert.rejects(files.get(bad), ChestError, bad);
  }
  await assert.rejects(files.list({ prefix: "a?b" }), ChestError);
  await assert.rejects(files.put("big", new Uint8Array((512 << 20) + 1)), TooLarge);
  assert.deepEqual(seen, []);
});

test("without CHEST_API, or with another address, the version keeps no files", async () => {
  const address = process.env["CHEST_API"];
  try {
    for (const other of [undefined, "", "http://localhost:1234", "https://127.0.0.1:1234", "http://127.0.0.1:99999", "http://10.0.0.1:80", "http://127.0.0.1:1234/x"]) {
      if (other === undefined) delete process.env["CHEST_API"];
      else process.env["CHEST_API"] = other;
      await assert.rejects(files.get("a"), (error: unknown) => error instanceof CapabilityNotGranted && error.status === 403, String(other));
    }
    process.env["CHEST_API"] = "http://127.0.0.1:1";
    await assert.rejects(files.get("a"), Unavailable);
  } finally {
    process.env["CHEST_API"] = address;
  }
});
