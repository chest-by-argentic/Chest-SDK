import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";
import { CapabilityNotGranted, ChestError, QuotaExceeded, TooLarge, Unavailable } from "../src/errors.js";
import * as files from "../src/files.js";

// A Chest's API as the broker answers it (chest/toolfiles of the Chest
// repository), in memory: the SDK is tested against its routes and codes.
type Kept = { type: string; data: Buffer; updated: string };
const kept = new Map<string, Kept>();
let refuse: { status: number; code: string } | null = null;
let seen: { method: string; url: string; type: string | undefined }[] = [];

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
const describe = (name: string, k: Kept) => ({ name, type: k.type, size: k.data.length, updated: k.updated });

const server: Server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  seen.push({ method: request.method ?? "", url: request.url ?? "", type: request.headers["content-type"] });
  const raw = await body(request);
  if (refuse) return answer(response, refuse.status, { error: refuse.code });
  if (request.method === "GET" && url.pathname === "/files") {
    const prefix = url.searchParams.get("prefix") ?? "", after = url.searchParams.get("after") ?? "";
    const names = [...kept.keys()].filter(n => n.startsWith(prefix) && n > after).sort();
    return answer(response, 200, { files: names.map(n => describe(n, kept.get(n)!)), next: null });
  }
  if (request.method === "POST" && url.pathname === "/files/url") {
    const { name } = JSON.parse(raw.toString()) as { name: string };
    return kept.has(name) ? answer(response, 200, { url: "https://web-chest.atelier.example/_chest/files/eyJ0b29sIjoid2ViIn0.c2lnbmF0dXJl", expires_in: 900 }) : answer(response, 404, { error: "not_found" });
  }
  const name = url.pathname.slice("/files/".length);
  const object = kept.get(name);
  if (request.method === "PUT") {
    const k = { type: request.headers["content-type"] ?? "application/octet-stream", data: raw, updated: new Date(0).toISOString() };
    kept.set(name, k);
    return answer(response, 201, describe(name, k));
  }
  if (!object) return answer(response, 404, { error: "not_found" });
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
  seen = [];
});

test("put, get, list, delete and url, as the Chest's API answers them", async () => {
  assert.deepEqual(await files.put("notes/a.txt", "hello"), { name: "notes/a.txt", type: "text/plain; charset=utf-8", size: 5, updated: "1970-01-01T00:00:00.000Z" });
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

test("names outside the grammar and objects beyond 32 MiB never leave the tool", async () => {
  for (const bad of ["", "/a", "a/", "../etc/passwd", ".hidden", "a b", "a?b", "a%2Fb", "x".repeat(101)]) {
    await assert.rejects(files.put(bad, "x"), (error: unknown) => error instanceof ChestError && error.code === "invalid_name", bad);
    await assert.rejects(files.get(bad), ChestError, bad);
  }
  await assert.rejects(files.list({ prefix: "a?b" }), ChestError);
  await assert.rejects(files.put("big", new Uint8Array((32 << 20) + 1)), TooLarge);
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
