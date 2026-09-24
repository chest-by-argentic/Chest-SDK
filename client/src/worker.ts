import { ChestChannel, ChestServiceError } from "./channel.js";
import { ChestRecord } from "./record.js";
import { ChestRequests } from "./requests.js";
import type { Invocation } from "./requests.js";

export type Handler = (request: Invocation, record: ChestRecord) => Promise<{ status: number; body: unknown }>;

// One operation at a time on the private channel. Never repeat a business
// operation when its reply is lost: its write may already have committed.
export async function serve(handler: Handler, channel = ChestChannel.stdio()): Promise<void> {
  const record = new ChestRecord(channel);
  const requests = new ChestRequests(channel);
  try {
    for (;;) {
      const request = await requests.next();
      if (request === null) continue;
      const result = request.deadline <= Date.now()
        ? { status: 503, body: { error: "expired" } }
        : await handler(request, record);
      try { await requests.reply(request.id, result.status, result.body); }
      catch (error) {
        if (!(error instanceof ChestServiceError && error.status === 409)) throw error;
      }
    }
  } finally { channel.close(); }
}

export async function runWorker(handler: Handler): Promise<void> {
  try { await serve(handler); }
  catch (error) {
    // No application data, credential or internal exception is logged.
    process.exitCode = error instanceof ChestServiceError ? (error.status === 403 ? 77 : 69) : 65;
  }
}
