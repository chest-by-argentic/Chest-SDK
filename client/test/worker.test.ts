import assert from "node:assert/strict";
import { test } from "node:test";
import { Duplex } from "node:stream";
import { ChestChannel, ChestServiceError } from "../src/channel.js";
import { serve } from "../src/worker.js";

class ScriptedChannel extends ChestChannel {
  next = 0;
  replies: number[] = [];
  closed = false;
  constructor() { super(new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } })); }
  override async exchange(_method: string, path: string, value: string): Promise<{ status: number; body: string }> {
    if (path === "/requests/next") {
      this.next++;
      if (this.next === 1) return { status: 204, body: "" };
      if (this.next === 5) throw new ChestServiceError(503);
      return { status: 200, body: JSON.stringify({ id: "a".repeat(16), operation: "list", input: null, actor: { subject: "alice", manage: true, publish: false }, deadline: this.next === 2 ? 1 : Date.now() + 5000 }) };
    }
    const reply = JSON.parse(value) as { status: number };
    this.replies.push(reply.status);
    if (this.replies.length === 2) throw new ChestServiceError(409);
    return { status: 204, body: "" };
  }
  override close(): void { this.closed = true; super.close(); }
}
test("worker skips idle polls and expired work, never retries a lost reply, and closes on failure", async () => {
  const channel = new ScriptedChannel(); let calls = 0;
  await assert.rejects(serve(async () => { calls++; return { status: 204, body: null }; }, channel), (error: unknown) => error instanceof ChestServiceError && error.status === 503);
  assert.equal(calls, 2);
  assert.deepEqual(channel.replies, [503, 204, 204]);
  assert.equal(channel.closed, true);
});
