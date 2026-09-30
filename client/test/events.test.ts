import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mock, test } from "node:test";
import { CapabilityNotGranted, ChestError } from "../src/errors.js";
import * as events from "../src/events.js";
import type { ChestEvent } from "../src/events.js";
import type { Member } from "../src/member.js";
import * as members from "../src/members.js";
import { fakeChest } from "../src/testing.js";

const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const camille: Member = { id: id("camille"), firstName: "Camille", lastName: "Martin", name: "Camille Martin", photo: null, role: "editor", isAdmin: false, isBuilder: false, groups: [], language: "en", timeZone: "Europe/Paris" };
const erasure = "era_" + "b".repeat(26);

// An event the Chest signed (chest/toolfront.EventSignature, Go) for the
// tool "web", at 1790000000, with the instance key 00 01 … 1f: the
// derivation of the key, the claims and the digest are the Chest's, not this
// test's (the Go test pins the same vector).
const chestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const signedAt = 1790000000;
const signedBody = `{"id":"evt_k2qhx4mzc7v3b6nfp5r2t7w4ya","type":"member.erased","occurredAt":"2026-09-21T14:13:20Z","data":{"deadline":"2026-10-21T14:13:20Z","erasure":"era_n4rdq7w2xkz5m3bvc6hy2tpl4e","id":"mbr_k2qhx4mzc7v3b6nfp5r2t7w4ya"}}`;
const signedByChest = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJ3ZWIiLCJkaWdlc3QiOiJGak1fNmMyeEM1LUJmemxTS3RvdnBvc2RScnlNVXZqN1RCWW1Yc3dWVnlFIiwiZXhwIjoxNzkwMDAwMDYwLCJpYXQiOjE3OTAwMDAwMDAsImp0aSI6ImV2dF9rMnFoeDRtemM3djNiNm5mcDVyMnQ3dzR5YSJ9.4g3iZvqtIFG2VfBV1OVcYaCsvs6xJi1H40GhAUKDaJE";

test("an event signed by the Chest reads as its envelope, within its minute and the skew", async () => {
  const saved = [process.env["CHEST_TOKEN"], process.env["CHEST_TOOL"]];
  process.env["CHEST_TOKEN"] = chestToken;
  process.env["CHEST_TOOL"] = "web";
  const delivery = () => new Request("http://tool.test/chest-events", { method: "POST", headers: { "Content-Type": "application/json", "Chest-Event": signedByChest }, body: signedBody });
  try {
    mock.timers.enable({ apis: ["Date"], now: signedAt * 1000 });
    assert.deepEqual(await events.verify(delivery()), { id: "evt_k2qhx4mzc7v3b6nfp5r2t7w4ya", type: "member.erased", occurredAt: "2026-09-21T14:13:20Z", data: { id: "mbr_k2qhx4mzc7v3b6nfp5r2t7w4ya", erasure: "era_n4rdq7w2xkz5m3bvc6hy2tpl4e", deadline: "2026-10-21T14:13:20Z" } });
    mock.timers.setTime((signedAt + 64) * 1000);
    assert.notEqual(await events.verify(delivery()), null);
    mock.timers.setTime((signedAt + 65) * 1000);
    assert.equal(await events.verify(delivery()), null);
    mock.timers.setTime((signedAt - 6) * 1000);
    assert.equal(await events.verify(delivery()), null);
  } finally {
    mock.timers.reset();
    for (const [name, value] of [["CHEST_TOKEN", saved[0]], ["CHEST_TOOL", saved[1]]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// capture keeps what a fake Chest delivered, and answers what the tool would.
function capture(): { requests: Request[]; tool: (request: Request) => Response } {
  const requests: Request[] = [];
  return { requests, tool: request => { requests.push(request); return new Response(null, { status: 204 }); } };
}

test("an event delivered is handled once by its handler, whatever the times it comes", async () => {
  const chest = await fakeChest({ members: [camille] });
  try {
    const told: ChestEvent[] = [];
    const seen = events.memorySeen();
    const tool = async (request: Request) => new Response(null, { status: await events.handle(request, { "access.revoked": e => { told.push(e); } }, { seen }) });
    const event = { id: "evt_" + "c".repeat(26), type: "access.revoked" as const, data: { id: camille.id } };
    assert.equal(await chest.emit(event, tool), 204);
    assert.equal(await chest.emit(event, tool), 204);
    assert.equal(told.length, 1);
    assert.deepEqual({ ...told[0], occurredAt: "" }, { id: event.id, type: "access.revoked", occurredAt: "", data: { id: camille.id } });
    // A type without a handler is accepted and ignored.
    assert.equal(await chest.emit({ type: "member.removed", data: { id: camille.id } }, tool), 204);
    assert.equal(told.length, 1);
  } finally {
    await chest.close();
  }
});

test("each event is typed by its type", async () => {
  const chest = await fakeChest({ members: [camille] });
  const { requests, tool } = capture();
  try {
    await chest.emit({ type: "member.updated", data: { id: camille.id, changed: ["name", "role", "language", "timeZone"] } }, tool);
    await chest.emit({ type: "member.erased", data: { id: camille.id, erasure, deadline: "2026-10-28T10:00:00Z" } }, tool);
    const [updated, erased] = [await events.verify(requests[0]!), await events.verify(requests[1]!)];
    assert.ok(updated?.type === "member.updated" && erased?.type === "member.erased");
    assert.deepEqual(updated.data.changed, ["name", "role", "language", "timeZone"]);
    assert.deepEqual(erased.data, { id: camille.id, erasure, deadline: "2026-10-28T10:00:00Z" });
    // Read once: the body is gone.
    assert.equal(await events.verify(requests[0]!), null);
  } finally {
    await chest.close();
  }
});

test("a delivery that is not the Chest's for this tool is refused", async () => {
  const chest = await fakeChest({ members: [camille] });
  const { requests, tool } = capture();
  try {
    await chest.emit({ type: "access.revoked", data: { id: camille.id } }, tool);
    const original = requests[0]!;
    const signature = original.headers.get("chest-event")!;
    const body = await original.clone().text();
    const post = (headers: Record<string, string>, text = body, method = "POST") => new Request("http://tool.test/chest-events", { method, headers, ...(method === "POST" ? { body: text } : {}) });
    const cases: [string, Request][] = [
      ["no signature", post({})],
      ["another body", post({ "chest-event": signature }, body.replace(camille.id, id("mallory")))],
      ["a GET", post({ "chest-event": signature }, "", "GET")],
      ["a signature cut", post({ "chest-event": signature.slice(0, -2) })],
      ["the assertion's header", post({ "chest-member": signature })],
    ];
    for (const [what, request] of cases) assert.equal(await events.handle(request, {}), 401, what);
    // Signed for another tool, or with another token.
    process.env["CHEST_TOOL"] = "other";
    assert.equal(await events.verify(post({ "chest-event": signature })), null);
    process.env["CHEST_TOOL"] = chest.tool;
    process.env["CHEST_TOKEN"] = "x".repeat(43);
    assert.equal(await events.verify(post({ "chest-event": signature })), null);
    process.env["CHEST_TOKEN"] = chest.token;
    assert.notEqual(await events.verify(post({ "chest-event": signature })), null);
    // A signed envelope that says what an event of its type cannot say.
    const bad = capture();
    await chest.emit({ type: "member.updated", data: { id: camille.id, changed: ["password" as "name"] } }, bad.tool);
    await chest.emit({ type: "member.erased", data: { id: camille.id, erasure: "era_x", deadline: "soon" } }, bad.tool);
    for (const request of bad.requests) assert.equal(await events.handle(request, {}), 401);
    // A type of a later Chest, signed: accepted, and ignored.
    const later = capture();
    await chest.emit({ type: "member.aliased", data: { id: camille.id } } as unknown as Parameters<typeof chest.emit>[0], later.tool);
    assert.equal(await events.handle(later.requests[0]!.clone(), {}), 204);
    assert.equal(await events.verify(later.requests[0]!), null);
  } finally {
    await chest.close();
  }
});

test("a handler that throws leaves the event to be delivered again", async () => {
  const chest = await fakeChest({ members: [camille] });
  const { requests, tool } = capture();
  try {
    const event = { id: "evt_" + "d".repeat(26), type: "member.removed" as const, data: { id: camille.id } };
    await chest.emit(event, tool);
    await chest.emit(event, tool);
    const seen = events.memorySeen();
    let calls = 0;
    const handlers = { "member.removed": () => { calls++; if (calls === 1) throw new Error("database down"); } };
    await assert.rejects(events.handle(requests[0]!, handlers, { seen }), /database down/u);
    assert.equal(await events.handle(requests[1]!, handlers, { seen }), 204);
    assert.equal(calls, 2);
  } finally {
    await chest.close();
  }
});

test("a node:http server handles events at /chest-events; what lookup kept is forgotten", async () => {
  const chest = await fakeChest({ members: [camille], former: [{ id: id("dan"), name: "Dan" }] });
  const server = createServer((request, response) => {
    void events.handle(request, {}).then(status => response.writeHead(status).end(), () => response.writeHead(500).end());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.deepEqual((await members.lookup([id("dan")])).former, [{ id: id("dan"), name: "Dan", status: "former" }]);
    // Dan's data is erased: the lookup, kept a minute, is asked again once the event comes.
    chest.members.splice(0);
    const address = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    assert.equal(await chest.emit({ type: "member.erased", data: { id: id("dan"), erasure, deadline: new Date().toISOString() } }, address), 204);
    assert.deepEqual((await members.lookup([camille.id])).unknown, [camille.id]);
  } finally {
    server.close();
    await chest.close();
  }
});

test("a tool acknowledges the erasures it was told of", async () => {
  const chest = await fakeChest({ members: [camille] });
  try {
    await assert.rejects(events.acknowledgeErasure(erasure), (error: unknown) => error instanceof ChestError && error.code === "erasure_not_found" && error.status === 404);
    await chest.emit({ type: "member.erased", data: { id: camille.id, erasure, deadline: new Date().toISOString() } }, capture().tool);
    await events.acknowledgeErasure(erasure);
    await events.acknowledgeErasure(erasure);
    assert.deepEqual(chest.acknowledged, [erasure]);
    await assert.rejects(events.acknowledgeErasure("era_x"), (error: unknown) => error instanceof ChestError && error.code === "invalid_id");
  } finally {
    await chest.close();
  }
  const deaf = await fakeChest({ members: [camille], receives: [] });
  try {
    await assert.rejects(events.acknowledgeErasure(erasure), CapabilityNotGranted);
  } finally {
    await deaf.close();
  }
  await assert.rejects(events.acknowledgeErasure(erasure), CapabilityNotGranted);
});

test("the ids kept in memory are bounded", () => {
  const seen = events.memorySeen(2);
  for (const n of ["a", "b", "c"]) seen.add(n);
  assert.deepEqual([seen.has("a"), seen.has("b"), seen.has("c")], [false, true, true]);
});
