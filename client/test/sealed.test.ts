import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { CapabilityNotGranted, ChestError, MemberRequired, NotAllowed, SealedInvalid, SealedLocked, SealedLost, Unavailable } from "../src/errors.js";
import type { Member } from "../src/member.js";
import { isSealed, open, openMany, seal, sealMany } from "../src/sealed.js";
import { fakeChest, withMember } from "../src/testing.js";

// Sealed values against a fake Chest, which seals and opens with the rules
// of a Chest (chest/toolseal): roles, contexts, tickets, the journal.
const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const person = (name: string, role: string): Member => ({ id: id(name), firstName: name, lastName: "", name, photo: null, role, isAdmin: false, isBuilder: false, groups: [], language: "en", timeZone: "UTC" });
const camille = person("camille", "hr"), dan = person("dan", "member");

test("a value sealed for a role opens for a member who holds it, in its context, and nowhere else", async t => {
  const chest = await fakeChest({ members: [camille, dan], capabilities: ["sealed"], roles: ["hr", "member"] });
  t.after(() => chest.close());
  const iban = await seal("FR76 3000 6000 0112 3456 7890 189", { context: "employee:42", roles: ["hr"] });
  assert.ok(isSealed(iban) && iban.startsWith("chest:sealed:1:hr:") && !iban.includes("FR76"));
  const asCamille = withMember(new Request("http://tool/chest"), camille), asDan = withMember(new Request("http://tool/chest"), dan);
  assert.equal(await open(asCamille, iban, { context: "employee:42" }), "FR76 3000 6000 0112 3456 7890 189");
  await assert.rejects(open(asDan, iban, { context: "employee:42" }), NotAllowed);
  await assert.rejects(open(asCamille, iban, { context: "employee:43" }), SealedInvalid);
  await assert.rejects(open(asCamille, iban.replace(":hr:", ":member:"), { context: "employee:42" }), SealedInvalid);
  const [note, other] = await sealMany([{ value: "a note" }, { value: "another", context: "x" }]);
  assert.deepEqual(await openMany(asDan, [{ sealed: iban, context: "employee:42" }, { sealed: note! }, { sealed: other!, context: "x" }, { sealed: "plain" }]), [null, "a note", "another", null]);
  // The journal: who, how many opened and refused; never a value.
  assert.deepEqual(chest.opens.map(o => [o.member, o.opened, o.refused]), [[camille.id, 1, 0], [dan.id, 0, 1], [camille.id, 0, 1], [camille.id, 0, 1], [dan.id, 2, 2]]);
});

test("opening needs a member's ticket, of a member who still has the tool", async t => {
  const chest = await fakeChest({ members: [camille], capabilities: ["sealed"] });
  t.after(() => chest.close());
  const sealed = await seal("x");
  // No ticket: a public page, a schedule, a request the Chest did not make.
  await assert.rejects(open(new Request("http://tool/chest"), sealed), MemberRequired);
  await assert.rejects(open(new Request("http://tool/chest", { headers: { "Chest-Opener": "1." + camille.id + ".9999999999.forged" } }), sealed), MemberRequired);
  const request = withMember(new Request("http://tool/chest"), camille);
  chest.members.splice(0);
  await assert.rejects(open(request, sealed), NotAllowed);
});

test("what a tool asks is checked before it is sent; a Chest without the capability refuses", async t => {
  const chest = await fakeChest({ members: [camille], capabilities: ["files"], roles: ["hr"] });
  t.after(() => chest.close());
  for (const options of [{ roles: [] }, { roles: ["HR"] }, { roles: ["hr", "hr"] }]) {
    await assert.rejects(seal("x", options), (error: unknown) => error instanceof ChestError && error.code === "invalid_role", JSON.stringify(options));
  }
  await assert.rejects(seal("x", { context: "c".repeat(257) }), (error: unknown) => error instanceof ChestError && error.code === "invalid_body");
  await assert.rejects(seal("v".repeat((512 << 10) + 1)), (error: unknown) => error instanceof ChestError && error.code === "invalid_body");
  await assert.rejects(seal("x"), CapabilityNotGranted);
});

test("a locked or lost key, and an answer that is not the Chest's, are told apart", async t => {
  let status = 503, value: unknown = { error: "sealed_locked" };
  const server = createServer((_, response) => {
    const raw = JSON.stringify(value);
    response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }).end(raw);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const given = process.env["CHEST_API"];
  process.env["CHEST_API"] = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  t.after(() => {
    server.close();
    if (given === undefined) delete process.env["CHEST_API"];
    else process.env["CHEST_API"] = given;
  });
  const request = new Request("http://tool/chest", { headers: { "Chest-Opener": "ticket" } });
  await assert.rejects(seal("x"), SealedLocked);
  value = { error: "sealed_lost" };
  await assert.rejects(open(request, "chest:sealed:1::AAAA"), SealedLost);
  [status, value] = [200, { values: [{ value: 1 }] }];
  await assert.rejects(open(request, "chest:sealed:1::AAAA"), Unavailable);
  [status, value] = [200, { sealed: ["not sealed"] }];
  await assert.rejects(seal("x"), Unavailable);
});

test("isSealed reads the shape only", () => {
  for (const [text, sealed] of [["chest:sealed:1::AbC-_", true], ["chest:sealed:1:hr,payroll:AbC", true], ["chest:sealed:1:hr", false], ["chest:sealed:1:HR:AbC", false], ["chest:sealed:2::AbC", false], ["FR76 3000", false], [42, false]] as const) {
    assert.equal(isSealed(text), sealed, String(text));
  }
});
