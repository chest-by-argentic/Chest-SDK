import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { connect } from "../src/realtime-client.js";

// A browser whose network phases can hang independently of its clock.
function browser(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const events = new Map<string, () => void>();
  const sockets: Socket[] = [];
  class Socket {
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    constructor() { sockets.push(this); }
    send(): void {}
    close(): void { this.readyState = 3; }
    hello(): void { this.onmessage?.({ data: JSON.stringify({ op: "hello", epoch: "test", member: "member" }) }); }
    drop(): void { this.close(); this.onclose?.({ code: 1006, reason: "" }); }
  }
  const page = globalThis as unknown as Record<string, unknown>;
  const originals = new Map(["WebSocket", "navigator", "addEventListener", "removeEventListener"].map(k => [k, Object.getOwnPropertyDescriptor(page, k)]));
  const network = { onLine: true };
  for (const [key, value] of Object.entries({ WebSocket: Socket, navigator: network, addEventListener: (name: string, fn: () => void) => events.set(name, fn), removeEventListener: (name: string) => events.delete(name) })) {
    Object.defineProperty(page, key, { configurable: true, writable: true, value });
  }
  const live = connect({ url: "wss://example.invalid/_chest/realtime" });
  t.after(() => {
    live.close();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(page, key, descriptor); else delete page[key]; }
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  return { live, sockets, network, events, tick, flush };
}

test("a stalled preflight aborts and recovery can open a replacement socket", async t => {
  const b = browser(t);
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    signal = init.signal;
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  b.sockets[0]!.hello(); b.sockets[0]!.drop();
  await b.tick(501);
  assert.ok(signal);
  await b.tick(10000);
  assert.equal(signal.aborted, true);
  assert.equal(b.sockets.length, 2);
});

test("a missing hello times out and late messages from the old socket are ignored", async t => {
  const b = browser(t);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  const states: boolean[] = []; b.live.on("status", up => states.push(up));
  await b.tick(15000);
  assert.equal(b.sockets[0]!.readyState, 3);
  await b.tick(501);
  assert.equal(b.sockets.length, 2);
  b.sockets[0]!.hello(); assert.deepEqual(states, []);
  b.sockets[1]!.hello(); assert.deepEqual(states, [true]);
});

test("offline cancels a pending preflight and a stale refusal cannot close its successor", async t => {
  const b = browser(t);
  let firstSignal: AbortSignal | null | undefined, finish: ((response: Response) => void) | undefined;
  let requests = 0;
  t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => {
    if (++requests > 1) return Promise.resolve(new Response(null, { status: 204 }));
    firstSignal = init.signal;
    return new Promise<Response>(resolve => { finish = resolve; });
  });
  const closed: string[] = []; b.live.on("closed", reason => closed.push(reason));
  b.sockets[0]!.hello(); b.sockets[0]!.drop(); await b.tick(501);
  b.network.onLine = false; b.events.get("offline")!();
  assert.equal(firstSignal?.aborted, true);
  b.network.onLine = true; b.events.get("online")!(); await b.flush();
  assert.equal(b.sockets.length, 2);
  finish!(new Response(null, { status: 401 })); await b.flush();
  assert.deepEqual(closed, []);
  assert.equal(b.sockets[1]!.readyState, 1);
});

test("closing cancels a preflight without opening a socket after its late answer", async t => {
  const b = browser(t);
  let signal: AbortSignal | null | undefined, finish: ((response: Response) => void) | undefined;
  t.mock.method(globalThis, "fetch", (_url: unknown, init: RequestInit) => { signal = init.signal; return new Promise<Response>(resolve => { finish = resolve; }); });
  b.sockets[0]!.hello(); b.sockets[0]!.drop(); await b.tick(501);
  b.live.close(); assert.equal(signal?.aborted, true);
  finish!(new Response(null, { status: 204 })); await b.flush(); await b.tick(60000);
  assert.equal(b.sockets.length, 1);
});
