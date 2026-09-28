import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import { CapabilityNotGranted, ChestError, RateLimited, TooLarge } from "../src/errors.js";
import * as files from "../src/files.js";
import { member, type Member } from "../src/member.js";
import * as members from "../src/members.js";
import { fakeChest, signAssertion, withMember } from "../src/testing.js";

const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const nord = "grp_nordaaaaaaaaaaaaaaaaaaaaaa";
const camille: Member = { id: id("camille"), firstName: "Camille", lastName: "Martin", name: "Camille Martin", photo: null, role: "editor", isAdmin: false, isBuilder: false, groups: [nord], email: "camille@example.test" };
const emile: Member = { id: id("emile"), firstName: "Émile", lastName: "Durand", name: "Émile Durand", photo: null, role: "reader", isAdmin: true, isBuilder: false, groups: [] };
const zoe: Member = { id: id("zoe"), firstName: "Zoé", lastName: "Petit", name: "Zoé Petit", photo: null, role: "reader", isAdmin: false, isBuilder: true, groups: [] };

test("a fake Chest points the environment at itself, and restores it when closed", async () => {
  process.env["CHEST_TOOL"] = "notes";
  delete process.env["CHEST_API"];
  delete process.env["CHEST_TOKEN"];
  const chest = await fakeChest({ members: [camille] });
  try {
    assert.equal(process.env["CHEST_API"], chest.api);
    assert.match(chest.api, /^http:\/\/127\.0\.0\.1:[0-9]+$/u);
    assert.equal(process.env["CHEST_TOKEN"], chest.token);
    assert.equal(chest.tool, "notes");
  } finally {
    await chest.close();
  }
  assert.equal(process.env["CHEST_API"], undefined);
  assert.equal(process.env["CHEST_TOKEN"], undefined);
  assert.equal(process.env["CHEST_TOOL"], "notes");
  delete process.env["CHEST_TOOL"];
});

test("an assertion signed for a member reads as that member, on a Web Request and a Node request", async () => {
  const chest = await fakeChest();
  try {
    assert.deepEqual(member(withMember(new Request("http://tool.test/chest"), camille)), camille);
    const request = withMember(new IncomingMessage(new Socket()), emile);
    assert.deepEqual(member(request), emile);
    // Signed for another tool, or long ago, it is nobody.
    assert.equal(member(withMember(new Request("http://tool.test/chest"), camille, { tool: "other" })), null);
    assert.equal(member(withMember(new Request("http://tool.test/chest"), camille, { now: new Date(Date.now() - 120_000) })), null);
    assert.throws(() => signAssertion({ ...camille, id: "camille" }), /identifiers/u);
  } finally {
    await chest.close();
  }
  assert.throws(() => signAssertion(camille), /token/u);
});

test("its members answer as a Chest's: order, pages, search, lookup, groups, addresses only with members.email", async () => {
  const chest = await fakeChest({ members: [zoe, camille, emile], former: [{ id: id("dan"), name: "Dan" }], groups: [{ id: nord, name: "Nord", members: [camille.id] }], capabilities: ["members"] });
  try {
    const first = await members.list({ limit: 2 });
    assert.deepEqual(first.members.map(m => m.name), ["Camille Martin", "Émile Durand"]);
    assert.equal(first.members[0]?.email, undefined);
    assert.deepEqual((await members.list({ after: first.next! })).members.map(m => m.name), ["Zoé Petit"]);
    assert.deepEqual((await members.list({ q: "emi" })).members.map(m => m.id), [emile.id]);
    assert.deepEqual((await members.list({ group: nord })).members.map(m => m.id), [camille.id]);
    assert.equal(await members.get(id("mallory")), null);
    const found = await members.lookup([id("dan"), zoe.id, id("mallory")]);
    assert.deepEqual([found.members.map(m => m.id), found.former, found.unknown], [[zoe.id], [{ id: id("dan"), name: "Dan", status: "former" }], [id("mallory")]]);
    assert.deepEqual(await members.groups.list(), [{ id: nord, name: "Nord", members: [camille.id] }]);
    await assert.rejects(files.get("a.txt"), CapabilityNotGranted);
  } finally {
    await chest.close();
  }
  const withEmail = await fakeChest({ members: [camille], capabilities: ["members", "members.email"] });
  try {
    assert.equal((await members.get(camille.id))?.email, "camille@example.test");
  } finally {
    await withEmail.close();
  }
});

test("its bounds and refusals are a Chest's", async () => {
  const chest = await fakeChest({ members: [camille], capabilities: ["files"], files: { "hello.txt": { data: "hello", type: "text/plain" } } });
  try {
    await assert.rejects(members.list(), CapabilityNotGranted);
    assert.equal(new TextDecoder().decode((await files.get("hello.txt"))?.data), "hello");
    await files.put("notes/a.txt", "a");
    assert.equal((await files.stat("notes/a.txt"))?.size, 1);
    assert.equal(await files.stat("none.txt"), null);
    assert.equal((await files.move("notes/a.txt", "notes/b.txt")).name, "notes/b.txt");
    assert.equal((await files.move("notes/b.txt", "notes/a.txt")).name, "notes/a.txt");
    assert.match((await files.uploadUrl("photos/", { maxSize: 1024, types: ["image/*"] })).url, /^https:\/\/tool-chest\.chest\.test\/_chest\/files\/upload\//u);
    assert.deepEqual([...chest.files.keys()].sort(), ["hello.txt", "notes/a.txt"]);
    assert.match((await files.url("notes/a.txt")).url, /^https:\/\/tool-chest\.chest\.test\/_chest\/files\//u);
    await assert.rejects(files.url("none.txt"), (error: unknown) => error instanceof ChestError && error.code === "not_found");
    assert.equal(await files.delete("hello.txt"), true);
    await assert.rejects(files.put("big", new Uint8Array((32 << 20) + 1)), TooLarge);
  } finally {
    await chest.close();
  }
  const busy = await fakeChest({ members: [camille] });
  try {
    for (let i = 0; i < 600; i++) await members.groups.list();
    await assert.rejects(members.groups.list(), RateLimited);
  } finally {
    await busy.close();
  }
});
