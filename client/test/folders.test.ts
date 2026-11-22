import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { CapabilityNotGranted, ChestError, MemberRequired, NotAllowed, Unavailable } from "../src/errors.js";
import * as events from "../src/events.js";
import * as folders from "../src/folders.js";
import type { Member } from "../src/member.js";
import { fakeChest, withMember } from "../src/testing.js";

// The folders of Files against a fake Chest, which gives them with the
// rules of a Chest (files.md, “For apps: the SDK”): the folders given only,
// the intersection on a member's request, the version's level as a cap.
const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const person = (name: string): Member => ({ id: id(name), firstName: name, lastName: "", name, photo: null, role: null, isAdmin: false, isBuilder: false, groups: [], language: "en", timeZone: "UTC" });
const claire = person("claire"), leo = person("leo");
const receipts = "a".repeat(32), taxis = "b".repeat(32), hr = "c".repeat(32);
const code = (expected: string) => (error: unknown) => error instanceof ChestError && error.code === expected;

// Expenses is given Receipts (edit), with Taxis inside; Claire edits
// Receipts, Léo views Taxis only. HR is not given to the tool.
const given = () => ({ given: [{ id: receipts, name: "Receipts", members: { [claire.id]: "edit" as const }, files: { "March.pdf": "%PDF-1.7 march" }, folders: [{ id: taxis, name: "Taxis", members: { [leo.id]: "view" as const }, files: { "Taxi.txt": "12 EUR" } }] }] });

test("a member's request reaches what the tool was given and the member also sees, at the lower level", async t => {
  const chest = await fakeChest({ members: [claire, leo], capabilities: ["folders"], folders: given() });
  t.after(() => chest.close());
  const asClaire = withMember(new Request("http://tool/chest"), claire), asLeo = withMember(new Request("http://tool/chest"), leo);
  assert.deepEqual(await folders.list(asClaire), [{ id: receipts, name: "Receipts", level: "edit" }]);
  assert.deepEqual(await folders.list(asLeo), [], "Léo does not see Receipts: the tool does not list it for him");
  const page = await folders.files(asClaire, receipts);
  assert.deepEqual([page.folder, page.folders, page.files.map(f => [f.name, f.type]), page.next], [{ id: receipts, name: "Receipts", level: "edit" }, [{ id: taxis, name: "Taxis" }], [["March.pdf", "application/pdf"]], null]);
  assert.equal((await folders.files(asLeo, taxis)).folder.level, "view");
  await assert.rejects(folders.files(asLeo, receipts), code("not_found"));
  await assert.rejects(folders.files(asClaire, hr), code("not_found"), "a folder not given is none");
  // Léo views Taxis: he never writes there, whatever the tool's grant.
  await assert.rejects(folders.put(asLeo, taxis, "Bus.txt", "3 EUR"), code("forbidden"));
  const taxi = (await folders.files(asLeo, taxis)).files[0]!;
  assert.equal(new TextDecoder().decode((await folders.get(asLeo, taxi.id))!.data), "12 EUR");
  assert.equal(await folders.remove(asLeo, taxi.id).catch((error: unknown) => error instanceof ChestError && error.code), "forbidden");
  // Every open is journaled for the member it was for.
  assert.deepEqual(chest.folders.opens, [{ document: taxi.id, member: leo.id }]);
});

test("nobody's request — a schedule, an event — gets the tool's grants; a request never stands for nobody", async t => {
  const chest = await fakeChest({ members: [claire], capabilities: ["folders"], folders: given() });
  t.after(() => chest.close());
  assert.deepEqual((await folders.list(null)).map(f => f.id), [receipts]);
  const added = await folders.put(null, taxis, "Night taxi.txt", "40 EUR");
  assert.deepEqual([added.name, added.type, added.size], ["Night taxi.txt", "text/plain", 6]);
  assert.equal(chest.folders.documents.get(added.id)?.folder, taxis);
  // The same name, letter case aside: a new version of the same document.
  const again = await folders.put(null, taxis, "NIGHT TAXI.txt", "41 EUR");
  assert.deepEqual([again.id, chest.folders.documents.get(added.id)?.versions], [added.id, 1]);
  assert.equal(await folders.remove(null, added.id), true);
  assert.equal(chest.folders.documents.get(added.id)?.removed, true);
  assert.equal(await folders.remove(null, added.id), false, "a document removed is reached no more");
  assert.equal(await folders.get(null, added.id), null);
  assert.equal(await folders.get(null, "not an id"), null);
  // A request without a member's ticket is refused before it is sent: it
  // would otherwise reach all of the tool's grants.
  await assert.rejects(folders.list(new Request("http://tool/chest")), MemberRequired);
  await assert.rejects(folders.list(new Request("http://tool/chest", { headers: { "Chest-Opener": "1." + claire.id + ".9999999999.forged" } })), MemberRequired);
  const request = withMember(new Request("http://tool/chest"), claire);
  chest.members.splice(0);
  await assert.rejects(folders.list(request), NotAllowed);
});

test("a version that asks view never writes; a version without folders reaches none", async t => {
  const viewing = await fakeChest({ members: [claire], capabilities: ["folders"], folders: { level: "view", given: given().given } });
  const asClaire = withMember(new Request("http://tool/chest"), claire);
  assert.deepEqual((await folders.list(asClaire))[0]?.level, "view", "the grant never exceeds what the version asks");
  await assert.rejects(folders.put(asClaire, receipts, "x.txt", "x"), CapabilityNotGranted);
  await assert.rejects(folders.uploadUrl(null, receipts, "x.txt", 1), CapabilityNotGranted);
  await viewing.close();
  const without = await fakeChest({ members: [claire], capabilities: ["files"] });
  t.after(() => without.close());
  await assert.rejects(folders.list(null), CapabilityNotGranted);
});

test("what a tool asks is checked before it is sent", async t => {
  const chest = await fakeChest({ capabilities: ["folders"], folders: given() });
  t.after(() => chest.close());
  for (const name of ["", " a", "a/b", "a\\b", ".", "..", "a\u0007", "a‮", "a\ud800", "x".repeat(256)]) {
    await assert.rejects(folders.put(null, receipts, name, "x"), code("invalid_name"), JSON.stringify(name));
  }
  await assert.rejects(folders.files(null, "../" + receipts), code("not_found"));
  await assert.rejects(folders.files(null, receipts, { after: "x" }), code("not_found"));
  await assert.rejects(folders.uploadUrl(null, receipts, "a.pdf", -1), code("invalid_size"));
  await assert.rejects(folders.uploadUrl(null, receipts, "a.pdf", 2 * 1024 ** 3 + 1), (error: unknown) => error instanceof ChestError && error.status === 413);
  await assert.rejects(folders.list(undefined as unknown as null), TypeError);
});

test("a member's browser opens a document and adds one on the documents host, as signed for them", async t => {
  const chest = await fakeChest({ members: [claire, leo], capabilities: ["folders"], folders: given() });
  t.after(() => chest.close());
  const asClaire = withMember(new Request("http://tool/chest"), claire);
  const march = (await folders.files(asClaire, receipts)).files[0]!;
  const link = await folders.url(asClaire, march.id, { download: true });
  assert.equal(link.expiresIn, 300);
  const opened = await fetch(link.url);
  assert.deepEqual([opened.status, opened.headers.get("content-disposition"), await opened.text()], [200, "attachment", "%PDF-1.7 march"]);
  assert.deepEqual(chest.folders.opens, [{ document: march.id, member: claire.id }]);
  const up = await folders.uploadUrl(asClaire, receipts, "April.pdf", 14);
  assert.deepEqual([up.method, up.expiresIn], ["PUT", 900]);
  const sent = await fetch(up.url, { method: "PUT", body: "%PDF-1.7 april" });
  assert.equal(sent.status, 201);
  assert.equal(((await sent.json()) as { type: string }).type, "application/pdf");
  assert.equal((await fetch(up.url, { method: "PUT", body: "%PDF-1.7 april" })).status, 403, "an upload link is taken once");
  // A link holds only while its member does.
  const later = await folders.url(asClaire, march.id);
  chest.members.splice(0, 1);
  assert.equal((await fetch(later.url)).status, 404);
});

test("an answer that is not the Chest's is Unavailable: a link elsewhere is never handed on", async t => {
  let value: unknown = {};
  const server = createServer((_, response) => {
    const raw = JSON.stringify(value);
    response.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }).end(raw);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const before = process.env["CHEST_API"];
  process.env["CHEST_API"] = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  t.after(() => {
    server.close();
    if (before === undefined) delete process.env["CHEST_API"];
    else process.env["CHEST_API"] = before;
  });
  for (const url of ["https://documents.example/_chest/files/a.b", "http://documents.example/d/a.b", "https://documents.example/d/a.b?x", "javascript:alert(1)//d/a.b"]) {
    value = { url, expires_in: 300 };
    await assert.rejects(folders.url(null, receipts), Unavailable, url);
  }
  value = { url: "https://documents.example/d/a.b", expires_in: 3600 };
  await assert.rejects(folders.url(null, receipts), Unavailable, "a link that lives longer than a Chest's");
  value = { url: "https://documents.example/d/a.b", expires_in: 300 };
  assert.equal((await folders.url(null, receipts)).url, "https://documents.example/d/a.b");
  value = { folders: [{ id: "x", name: "Receipts", level: "edit" }] };
  await assert.rejects(folders.list(null), Unavailable);
  value = { folders: [{ id: receipts, name: "Receipts", level: "owner" }] };
  await assert.rejects(folders.list(null), Unavailable);
});

test("the Chest tells the tool of the documents of its folders, never who; no tool tells one in its name", async t => {
  const chest = await fakeChest({ capabilities: ["folders"], folders: given(), emits: { "receipt.filed": { description: "A receipt is filed", data: { receipt: "id" } } } });
  t.after(() => chest.close());
  const told: events.ChestEvent[] = [];
  const tool = (request: Request) => events.handle(request, { "folders.file.added": e => { told.push(e); }, "folders.file.removed": e => { told.push(e); } }).then(status => new Response(null, { status }));
  const file = { id: "d".repeat(32), name: "May.pdf", type: "application/pdf", size: 9 };
  assert.equal(await chest.deliver({ type: "folders.file.added", data: { folder: receipts, file } }, tool), 204);
  assert.equal(await chest.deliver({ type: "folders.file.removed", data: { folder: receipts, file } }, tool), 204);
  assert.deepEqual(told.map(e => [e.type, e.data]), [["folders.file.added", { folder: receipts, file }], ["folders.file.removed", { folder: receipts, file }]]);
  // An envelope the Chest never sends — who did it, a folder of no grammar.
  for (const data of [{ folder: receipts, file, by: claire.id }, { folder: "Receipts", file }, { folder: receipts, file: { ...file, addedBy: claire.id } }]) {
    assert.equal(await chest.deliver({ type: "folders.file.added", data } as never, tool), 401, JSON.stringify(data));
  }
  await assert.rejects(events.emit("folders.file.added", { receipt: "r-1" }), code("invalid_type"));
  // A manifest never emits a type of the Chest's (a fake Chest that took one is closed at once).
  await assert.rejects(fakeChest({ emits: { "folders.file.added": { description: "A receipt is filed", data: {} } } }).then(c => c.close()), /refuses "emits"/u);
});
