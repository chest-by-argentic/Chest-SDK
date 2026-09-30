import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mock, test } from "node:test";
import * as events from "../src/events.js";
import * as schedules from "../src/schedules.js";
import type { Run } from "../src/schedules.js";
import { fakeChest } from "../src/testing.js";

// A run the Chest signed (chest/toolfront, Go: TestRunSignatureVector) for
// the tool "web", at 1790000000, with the instance key 00 01 … 1f: the
// derivation of the key, the claims and the digest are the Chest's, not this
// test's.
const chestToken = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const signedAt = 1790000000;
const signedBody = `{"id":"run_k2qhx4mzc7v3b6nfp5r2t7w4ya","name":"morning","scheduledAt":"2026-09-21T05:30:00Z","attempt":1}`;
const signedByChest = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJ3ZWIiLCJkaWdlc3QiOiJBSzNQenBWMThYVllvWW5Sd2gzWTRUSEhkVU5pby1vamcwZFB5Mm9obHg4IiwiZXhwIjoxNzkwMDAwMDYwLCJpYXQiOjE3OTAwMDAwMDAsImp0aSI6InJ1bl9rMnFoeDRtemM3djNiNm5mcDVyMnQ3dzR5YSJ9.hVeyVDqLIUNfhGgGM94JqZXG-2AUNVLdyHfmrnz5lzY";

async function inChest<T>(body: () => Promise<T>): Promise<T> {
  const saved = [process.env["CHEST_TOKEN"], process.env["CHEST_TOOL"]];
  process.env["CHEST_TOKEN"] = chestToken;
  process.env["CHEST_TOOL"] = "web";
  try {
    return await body();
  } finally {
    mock.timers.reset();
    for (const [name, value] of [["CHEST_TOKEN", saved[0]], ["CHEST_TOOL", saved[1]]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const delivery = (header = "Chest-Schedule", body = signedBody, path = "/chest-schedules") => new Request("http://tool.test" + path, { method: "POST", headers: { "Content-Type": "application/json", [header]: signedByChest }, body });

test("a run signed by the Chest reads as its run, within its minute and the skew", () => inChest(async () => {
  mock.timers.enable({ apis: ["Date"], now: signedAt * 1000 });
  assert.deepEqual(await schedules.verify(delivery()), { id: "run_k2qhx4mzc7v3b6nfp5r2t7w4ya", name: "morning", scheduledAt: "2026-09-21T05:30:00Z", attempt: 1 });
  mock.timers.setTime((signedAt + 64) * 1000);
  assert.notEqual(await schedules.verify(delivery()), null);
  mock.timers.setTime((signedAt + 65) * 1000);
  assert.equal(await schedules.verify(delivery()), null);
}));

test("a run is not an event, nor an event a run: each channel has its own key", () => inChest(async () => {
  mock.timers.enable({ apis: ["Date"], now: signedAt * 1000 });
  // The run's signature in the events' header: the key differs.
  assert.equal(await events.verify(delivery("Chest-Event")), null);
  assert.equal(await schedules.verify(delivery("Chest-Event")), null);
  // Another body under the signature, another tool, a GET.
  assert.equal(await schedules.verify(delivery("Chest-Schedule", signedBody.replace("morning", "evening"))), null);
  process.env["CHEST_TOOL"] = "notes";
  assert.equal(await schedules.verify(delivery()), null);
  process.env["CHEST_TOOL"] = "web";
  assert.equal(await schedules.verify(new Request("http://tool.test/chest-schedules", { headers: { "Chest-Schedule": signedByChest } })), null);
}));

// capture answers what the tool would, and keeps the runs its handlers got.
function tool(handlers: schedules.Handlers, seen = events.memorySeen()) {
  return async (request: Request) => new Response(null, { status: await schedules.handle(request, handlers, { seen }) });
}

test("a run delivered is handled once by the handler of its schedule, whatever the times it comes", async () => {
  const chest = await fakeChest();
  try {
    const told: Run[] = [];
    const app = tool({ morning: run => { told.push(run); } });
    const id = "run_" + "c".repeat(26);
    assert.equal(await chest.run("morning", app, { id, scheduledAt: "2026-10-05T05:30:00Z" }), 204);
    assert.equal(await chest.run("morning", app, { id, attempt: 2 }), 204);
    assert.deepEqual(told, [{ id, name: "morning", scheduledAt: "2026-10-05T05:30:00Z", attempt: 1 }]);
    // A schedule without a handler: 404, the Chest does not try again.
    assert.equal(await chest.run("evening", app), 404);
  } finally {
    await chest.close();
  }
});

test("a handler that throws leaves the run to be delivered again", async () => {
  const chest = await fakeChest();
  try {
    let fail = true;
    const handled: number[] = [];
    const app = async (request: Request) => {
      try {
        return new Response(null, { status: await schedules.handle(request, { morning: run => { if (fail) throw new Error("database away"); handled.push(run.attempt); } }) });
      } catch {
        return new Response(null, { status: 500 });
      }
    };
    const id = "run_" + "d".repeat(26);
    assert.equal(await chest.run("morning", app, { id }), 500);
    fail = false;
    assert.equal(await chest.run("morning", app, { id, attempt: 2 }), 204);
    assert.deepEqual(handled, [2]);
  } finally {
    await chest.close();
  }
});

test("outside a Chest, or signed by another, nothing is a run", async () => {
  assert.equal(await schedules.handle(delivery(), { morning: () => { throw new Error("never"); } }), 401);
  const chest = await fakeChest();
  const other = chest.token;
  await chest.close();
  const again = await fakeChest();
  try {
    assert.notEqual(again.token, other);
    const requests: Request[] = [];
    await again.run("morning", request => { requests.push(request); return new Response(null, { status: 204 }); });
    process.env["CHEST_TOKEN"] = other;
    assert.equal(await schedules.verify(requests[0]!), null);
  } finally {
    await again.close();
  }
});

test("a run reaches a tool served over HTTP, as a Node request", async () => {
  const chest = await fakeChest();
  const told: string[] = [];
  const server = createServer((request, response) => {
    void schedules.handle(request, { morning: run => { told.push(run.name + ":" + request.url); } }).then(status => response.writeHead(status).end());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(await chest.run("morning", `http://127.0.0.1:${(server.address() as AddressInfo).port}/`), 204);
    assert.deepEqual(told, ["morning:/chest-schedules"]);
  } finally {
    server.close();
    await chest.close();
  }
});
