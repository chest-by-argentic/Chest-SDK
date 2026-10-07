import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityNotGranted, ChestError, TooLarge, Unavailable } from "../src/errors.js";
import * as events from "../src/events.js";
import type { Handlers, MemberUpdated, ReceivedEvent, ToolEvent } from "../src/events.js";
import type { Member } from "../src/member.js";
import { eventChannel, sign } from "../src/signed.js";
import { fakeChest, type FakeChest, type FakeChestOptions } from "../src/testing.js";

const id = (name: string): string => "mbr_" + name + "a".repeat(26 - name.length);
const nord = "grp_nordaaaaaaaaaaaaaaaaaaaaaa";
const evt = (letter: string): string => "evt_" + letter.repeat(26);
const camille: Member = { id: id("camille"), firstName: "Camille", lastName: "Martin", name: "Camille Martin", photo: null, role: "editor", isAdmin: false, isBuilder: false, groups: [nord], language: "en", timeZone: "Europe/Paris" };
const emile: Member = { ...camille, id: id("emile"), firstName: "Émile", lastName: "Durand", name: "Émile Durand", groups: [] };
const quoteAccepted = { description: "A quote is accepted", data: { quote: "id", client: "text", total: "number", acceptedBy: "member", note: "text?" } };
const data = { quote: "q-2026-001", client: "Atelier Nord", total: 1250.5, acceptedBy: camille.id };

// withChest runs a test against a fake Chest of the tool "tasks" that emits
// quote.accepted, and closes it.
async function withChest(run: (chest: FakeChest) => Promise<void>, options: FakeChestOptions = {}): Promise<void> {
  const chest = await fakeChest({ members: [camille, emile], former: [{ id: id("dan") }], groups: [{ id: nord, name: "Nord", members: [camille.id] }], emits: { "quote.accepted": quoteAccepted }, ...options });
  try {
    await run(chest);
  } finally {
    await chest.close();
  }
}

// refused says an error is a ChestError of that code and status.
const refused = (code: string, status = 400) => (error: unknown): boolean => error instanceof ChestError && error.code === code && error.status === status;

// signed is a delivery of that envelope, signed as the Chest signs it.
function signed(chest: FakeChest, envelope: Record<string, unknown>): Request {
  const body = JSON.stringify(envelope);
  return new Request("http://tool.test/chest-events", { method: "POST", headers: { "Content-Type": "application/json", "Chest-Event": sign(eventChannel, envelope["id"] as string, body, { token: chest.token, tool: chest.tool }) }, body });
}

// capture keeps what a fake Chest delivered, and answers what the tool would.
function capture(): { requests: Request[]; tool: (request: Request) => Response } {
  const requests: Request[] = [];
  return { requests, tool: request => { requests.push(request); return new Response(null, { status: 204 }); } };
}

test("emit sends the event and answers its id; the fake Chest keeps it", async () => {
  await withChest(async chest => {
    const at = new Date(Date.now() - 3600_000);
    const told = await events.emit("quote.accepted", { ...data, note: "Signed on site" }, { subject: "q-2026-001", key: "accepted:q-2026-001", occurredAt: at, audience: { members: [camille.id, camille.id], groups: [nord], roles: [] } });
    assert.match(told.id, /^evt_[a-z2-7]{26}$/u);
    assert.equal(told.receivers, 0);
    // The members once each, the empty list left out, the time as an instant.
    assert.deepEqual(chest.emitted, [{ id: told.id, type: "quote.accepted", data: { ...data, note: "Signed on site" }, subject: "q-2026-001", key: "accepted:q-2026-001", occurredAt: at.toISOString(), audience: { members: [camille.id], groups: [nord] } }]);
    // Without options: the Chest's time, nobody named (everyone who has the tool).
    const plain = await events.emit("quote.accepted", data);
    assert.deepEqual(Object.keys(chest.emitted[1]!).sort(), ["data", "id", "occurredAt", "type"]);
    assert.equal(chest.emitted[1]!.id, plain.id);
    // An optional field given as null is a field left out.
    await events.emit("quote.accepted", { ...data, note: null });
    assert.equal(chest.emitted.length, 3);
  });
});

test("emit refuses before sending what the Chest would refuse", async () => {
  // No Chest: what reached it would be CapabilityNotGranted.
  {
    for (const type of ["quote", "Quote.accepted", "quote.accepted.", "a.b.c.d.e", "member.joined", "access.granted", "quote.1accepted", "q".repeat(60) + ".done"]) {
      await assert.rejects(events.emit(type, data), refused("invalid_type"), type);
    }
    await assert.rejects(events.emit("quote.accepted", [] as unknown as Record<string, unknown>), refused("invalid_data"));
    await assert.rejects(events.emit("quote.accepted", { big: 1n } as unknown as Record<string, unknown>), refused("invalid_data"));
    await assert.rejects(events.emit("quote.accepted", { ...data, note: "x".repeat(16 << 10) }), TooLarge);
    for (const options of [{ subject: "" }, { subject: "-q" }, { key: "a b" }, { key: "k".repeat(129) }, { occurredAt: "yesterday" }, { occurredAt: new Date(Number.NaN) }, { occurredAt: new Date(Date.now() + 60_000) }, { occurredAt: new Date(Date.now() - 73 * 3600_000) }, { occurredAt: "2026-02-30T10:00:00Z" }]) {
      await assert.rejects(events.emit("quote.accepted", data, options), refused("invalid_event"), JSON.stringify(options));
    }
    for (const audience of [{}, { members: [] }, { members: ["camille"] }, { groups: ["grp_x"] }, { roles: ["Admin"] }, { teams: ["a"] }] as events.EmitAudience[]) {
      await assert.rejects(events.emit("quote.accepted", data, { audience }), refused("invalid_audience"), JSON.stringify(audience));
    }
  }
});

test("the fake Chest refuses an emit as the Chest does", async () => {
  await withChest(async chest => {
    await assert.rejects(events.emit("quote.sent", data), refused("invalid_type"));
    const wrong: Record<string, unknown>[] = [
      { ...data, discount: 10 }, // a field not declared
      { quote: data.quote, total: 1, acceptedBy: camille.id }, // client missing
      { ...data, client: null }, // a required field null
      { ...data, quote: "q 1" }, // id
      { ...data, client: "Nord\u0000" }, { ...data, client: "Nord\r" }, { ...data, client: "‮Nord" }, { ...data, client: "Nord​" }, { ...data, client: "Nord\ud800" }, // text
      { ...data, total: "1250" }, // number
      { ...data, acceptedBy: "mbr_x" }, { ...data, acceptedBy: id("mallory") }, // member: of the grammar, and one the tool had
    ];
    for (const given of wrong) await assert.rejects(events.emit("quote.accepted", given), refused("invalid_data"), JSON.stringify(given));
    // Text keeps line feeds and tabs; a former member is one the tool had.
    await events.emit("quote.accepted", { ...data, client: "Atelier\tNord\nLyon", acceptedBy: id("dan") });
    for (const audience of [{ members: [id("mallory")] }, { groups: ["grp_suduaaaaaaaaaaaaaaaaaaaaaa"] }]) {
      await assert.rejects(events.emit("quote.accepted", data, { audience }), refused("invalid_audience"), JSON.stringify(audience));
    }
    // What the SDK never sends, the fake refuses too.
    const post = (body: unknown) => fetch(chest.api + "/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async r => [r.status, await r.json()]);
    assert.deepEqual(await post({ type: "quote.accepted", data, cause: "evt_x" }), [400, { error: "invalid_event" }]);
    assert.deepEqual(await post({ type: "quote.accepted", data, from: "quotes" }), [400, { error: "invalid_event" }]);
    assert.deepEqual(await post({ type: "quote.accepted", data, audience: { members: [camille.id, camille.id] } }), [400, { error: "invalid_audience" }]);
    assert.deepEqual(await post({ type: "quote.accepted", data: { ...data, client: "x".repeat(16 << 10) } }), [413, { error: "too_large" }]);
    assert.equal(chest.emitted.length, 1);
  });
});

test("every kind of field is checked", async () => {
  const kinds = { description: "Everything", data: { ref: "id", label: "text", count: "number", done: "boolean", at: "time", day: "date", owner: "member", team: "members", maybe: "date?" } };
  await withChest(async chest => {
    const good = { ref: "a:b.c_d-1", label: "Libellé ✓", count: -0.5, done: false, at: "2026-10-06T10:00:00.123456789+02:00", day: "2028-02-29", owner: camille.id, team: [] };
    await events.emit("all.kinds", good);
    await events.emit("all.kinds", { ...good, team: [camille.id, id("dan")], maybe: "2026-10-06" });
    const wrong: Record<string, unknown>[] = [
      { ref: 1 }, { ref: "x".repeat(129) }, { label: 3 }, { count: true }, { done: "false" }, { at: "2026-10-06 10:00:00Z" }, { at: "2026-10-06T24:00:00Z" }, { at: "2026-10-06T10:00:00" },
      { day: "2027-02-29" }, { day: "2026-13-01" }, { day: "2026-10-06T00:00:00Z" }, { owner: [camille.id] }, { team: [camille.id, camille.id] }, { team: camille.id }, { maybe: "soon" },
    ];
    for (const change of wrong) await assert.rejects(events.emit("all.kinds", { ...good, ...change }), refused("invalid_data"), JSON.stringify(change));
    assert.equal(chest.emitted.length, 2);
  }, { emits: { "all.kinds": kinds } });
});

test("an idempotency key answers its first event for the same content, and refuses other content", async () => {
  await withChest(async chest => {
    const first = await events.emit("quote.accepted", data, { key: "accepted:1", subject: "q-1" });
    // The same content, its keys in another order: the same event, told once.
    const again = await events.emit("quote.accepted", { acceptedBy: data.acceptedBy, total: data.total, client: data.client, quote: data.quote }, { subject: "q-1", key: "accepted:1" });
    assert.deepEqual(again, first);
    assert.equal(chest.emitted.length, 1);
    await assert.rejects(events.emit("quote.accepted", { ...data, total: 1 }, { key: "accepted:1", subject: "q-1" }), refused("key_reused", 409));
    await assert.rejects(events.emit("quote.accepted", data, { key: "accepted:1" }), refused("key_reused", 409));
    assert.notEqual((await events.emit("quote.accepted", data, { key: "accepted:2", subject: "q-1" })).id, first.id);
  });
});

test("a version that emits nothing is refused, and so is a tool outside a Chest; the fake refuses a manifest the Chest refuses", async () => {
  await withChest(async () => {
    await assert.rejects(events.emit("quote.accepted", data), CapabilityNotGranted);
  }, { emits: {} });
  await assert.rejects(events.emit("quote.accepted", data), CapabilityNotGranted);
  await assert.rejects(fakeChest({ emits: { "quote.accepted": { description: "", data: {} } } }), /emits/u);
  await assert.rejects(fakeChest({ emits: { "member.joined": { description: "Joined", data: {} } } }), /emits/u);
  await assert.rejects(fakeChest({ emits: { "quote.accepted": { description: "Accepted", data: { Total: "number" } } } }), /emits/u);
  await assert.rejects(fakeChest({ emits: { "quote.accepted": { description: "Accepted", data: { total: "money" } } } }), /emits/u);
});

test("the answers of the Chest are read as the Chest gives them", async () => {
  await withChest(async () => {
    // An answer that is not the Chest's: Unavailable.
    const saved = globalThis.fetch;
    for (const [status, body] of [[202, { id: "evt_x", receivers: 1 }], [202, { id: evt("a"), receivers: -1 }], [204, null], [500, { error: "unavailable" }], [413, { error: "too_large" }]] as const) {
      globalThis.fetch = async () => new Response(body === null ? null : JSON.stringify(body), { status });
      try {
        await assert.rejects(events.emit("quote.accepted", data), status === 413 ? TooLarge : Unavailable, String(status));
      } finally {
        globalThis.fetch = saved;
      }
    }
  });
});

test("a tool event is handed to its handler, with its source, subject and audience", async () => {
  await withChest(async chest => {
    const told: ToolEvent[] = [];
    const seen = events.memorySeen();
    const tool = async (request: Request) => new Response(null, { status: await events.handle(request, { "quote.accepted": e => { told.push(e); } }, { seen }) });
    const event = { id: evt("c"), type: "quote.accepted", source: "quotes", subject: "q-1", occurredAt: "2026-10-06T08:00:00Z", data: { ...data, addedLater: { nested: true } } };
    assert.equal(await chest.deliver(event, tool), 204);
    assert.equal(await chest.deliver(event, tool), 204);
    assert.deepEqual(told, [{ ...event, audience: "all" }]);
    assert.equal(await chest.deliver({ type: "quote.accepted", source: "quotes", audience: [camille.id], data: {} }, tool), 204);
    assert.deepEqual([told[1]?.audience, Object.hasOwn(told[1]!, "subject")], [[camille.id], false]);
    // A type without a handler is accepted and ignored.
    assert.equal(await chest.deliver({ type: "hire.made", source: "hiring", data: {} }, tool), 204);
    assert.equal(told.length, 2);
    // Member events keep their own handlers and shape.
    const members: MemberUpdated[] = [];
    assert.equal(await chest.deliver({ type: "member.updated", data: { id: camille.id, changed: ["name"] } }, request => events.handle(request, { "member.updated": e => { members.push(e); } }).then(status => new Response(null, { status }))), 204);
    assert.deepEqual(members.map(e => e.data), [{ id: camille.id, changed: ["name"] }]);
  });
});

test("an emit inside a tool event's handler carries that event as its cause", async () => {
  await withChest(async chest => {
    const handlers = {
      "quote.accepted": async (e: ToolEvent) => { await events.emit("project.created", { project: String(e.data["quote"]) }); },
      "member.removed": async () => { await events.emit("project.created", { project: "member" }); },
    };
    const tool = async (request: Request) => new Response(null, { status: await events.handle(request, handlers) });
    assert.equal(await chest.deliver({ id: evt("d"), type: "quote.accepted", source: "quotes", data }, tool), 204);
    assert.equal(await chest.deliver({ type: "member.removed", data: { id: camille.id } }, tool), 204);
    await events.emit("project.created", { project: "outside" });
    assert.deepEqual(chest.emitted.map(e => [e.data["project"], e.cause]), [[data.quote, evt("d")], ["member", undefined], ["outside", undefined]]);
  }, { emits: { "project.created": { description: "A project is created", data: { project: "id" } } } });
});

test("a signed envelope that is not a tool event's is refused", async () => {
  await withChest(async chest => {
    const good = { id: evt("e"), type: "quote.accepted", source: "quotes", occurredAt: "2026-10-06T08:00:00Z", audience: "all", data: {} };
    assert.equal(await events.handle(signed(chest, good), {}), 204);
    const { audience: _audience, ...noAudience } = good;
    const { data: _data, ...noData } = good;
    const cases: [string, Record<string, unknown>][] = [
      ["a source of no tool's name", { ...good, source: "Quotes" }],
      ["an empty source", { ...good, source: "" }],
      ["an audience of nobody", { ...good, audience: [] }],
      ["an audience twice the same", { ...good, audience: [camille.id, camille.id] }],
      ["an audience of no member", { ...good, audience: ["camille"] }],
      ["an audience of another word", { ...good, audience: "everyone" }],
      ["no audience", noAudience],
      ["no data", noData],
      ["data that is a list", { ...good, data: [] }],
      ["a key of its own", { ...good, cause: evt("f") }],
      ["a subject null", { ...good, subject: null }],
      ["a subject of no grammar", { ...good, subject: "q 1" }],
      ["a type of the Chest's", { ...good, type: "member.removed" }],
      ["a type of no grammar", { ...good, type: "quote" }],
      ["a time of no instant", { ...good, occurredAt: "2026-10-06" }],
      ["another id than the one signed", { ...good, id: evt("g") }],
    ];
    for (const [what, envelope] of cases) {
      const request = what.startsWith("another id") ? new Request("http://tool.test/chest-events", { method: "POST", headers: { "Chest-Event": sign(eventChannel, good.id, JSON.stringify(envelope), { token: chest.token, tool: chest.tool }) }, body: JSON.stringify(envelope) }) : signed(chest, envelope);
      assert.equal(await events.handle(request, { "quote.accepted": () => assert.fail(what) }), 401, what);
    }
  });
});

test("an event names who may see it, up to a whole team, and the body is read once its signature holds", async () => {
  await withChest(async chest => {
    // A team of 40,000: well beyond 64 KiB, within the bound.
    const base32 = (n: number): string => n.toString(32).padStart(26, "0").replace(/./gu, c => "abcdefghijklmnopqrstuvwxyz234567"[parseInt(c, 32)]!);
    const team = Array.from({ length: 40_000 }, (_, i) => "mbr_" + base32(i));
    assert.equal(new Set(team).size, team.length);
    const { requests, tool } = capture();
    await chest.deliver({ type: "quote.accepted", source: "quotes", audience: team, data }, tool);
    const read = await events.verify(requests[0]!);
    assert.ok(read && "source" in read);
    assert.equal((read.audience as string[]).length, team.length);
    // Beyond the bound: refused, even signed.
    const huge = { id: evt("h"), type: "quote.accepted", source: "quotes", occurredAt: "2026-10-06T08:00:00Z", audience: "all", data: { pad: "x".repeat((32 << 20) + (64 << 10)) } };
    assert.equal(await events.verify(signed(chest, huge)), null);
    // Unsigned: the body is never read.
    let pulled = false;
    const stream = new ReadableStream({ pull: controller => { pulled = true; controller.close(); } }, { highWaterMark: 0 });
    const unsigned = new Request("http://tool.test/chest-events", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    assert.equal(await events.handle(unsigned, {}), 401);
    assert.equal(pulled, false);
  });
});

test("handlers are typed by their type", () => {
  // A member type gets its own event, any other dotted type a ToolEvent.
  const handlers: Handlers<"member.updated" | "quote.accepted"> = { "member.updated": (e: MemberUpdated) => { void e.data.changed; }, "quote.accepted": (e: ToolEvent) => { void e.audience; } };
  const all: Handlers = { "access.revoked": e => { void e.data.id; }, "hire.made": e => { void e.source; } };
  void [handlers, all];
  const never = async (request: Request) => {
    await events.handle(request, { "member.erased": e => { void e.data.erasure; }, "quote.accepted": e => { void e.subject; } });
    // @ts-expect-error a member event has no source
    await events.handle(request, { "member.updated": e => { void e.source; } });
    // @ts-expect-error a tool event is not a member's
    await events.handle(request, { "quote.accepted": (e: MemberUpdated) => { void e; } });
    // @ts-expect-error a type is dotted
    await events.handle(request, { quote: () => {} });
    const read: ReceivedEvent | null = await events.verify(request);
    void read;
  };
  void never;
});
