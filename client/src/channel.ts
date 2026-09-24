import { Agent, request } from "node:http";
import type { ClientRequest } from "node:http";
import { Duplex } from "node:stream";

export class ChestServiceError extends Error {
  constructor(readonly status: number) { super("Chest service operation not confirmed"); }
}
class PipeAgent extends Agent {
  #used = false;
  constructor(private readonly channel: Duplex) { super({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1 });
    // Own late pipe errors too, after the HTTP request detaches its listeners.
    channel.on("error", () => this.destroy());
  }
  override createConnection(): Duplex {
    if (this.#used) throw new Error("Chest channel is closed");
    this.#used = true;
    return this.channel;
  }
  // Generic Duplex pipes have no TCP keepalive/ref methods. Their lifetime is
  // controlled by the workload; never open a replacement network connection.
  override keepSocketAlive(): boolean { return true; }
  override reuseSocket(_socket: Duplex, req: ClientRequest): void { req.reusedSocket = true; }
}

// Shared private transport; no replacement network connection is possible.
export class ChestChannel {
  readonly #agent: PipeAgent;
  constructor(channel: Duplex) { this.#agent = new PipeAgent(channel); }
  static stdio(): ChestChannel {
    return new ChestChannel(Duplex.from({ readable: process.stdin, writable: process.stdout }));
  }
  close(): void { this.#agent.destroy(); }
  async exchange(method: "GET" | "PUT" | "POST", path: "/record" | "/requests/next" | "/requests/reply", value: string, expected: number[]): Promise<{status: number; body: string}> {
    const body = Buffer.from(value, "utf8");
    if (body.length > 64 * 1024) throw new ChestServiceError(413);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<{status: number; body: string}>((resolve, reject) => {
        const req = request({
          host: "chest", path, method, agent: this.#agent,
          maxHeaderSize: 4096, headers: { "Content-Length": body.length, "Content-Type": "application/octet-stream" },
        }, res => {
          void (async () => {
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of res) {
              const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
              size += bytes.length;
              if (size > 64 * 1024) { req.destroy(); throw new ChestServiceError(503); }
              chunks.push(bytes);
            }
            if (!res.complete || !expected.includes(res.statusCode ?? 0)) throw new ChestServiceError(res.statusCode ?? 503);
            resolve({status: res.statusCode!, body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))});
          })().catch(reject);
        });
        req.once("error", () => reject(new ChestServiceError(503)));
        timer = setTimeout(() => req.destroy(new Error("Chest channel deadline exceeded")), 2000);
        req.end(body);
      });
    } finally { clearTimeout(timer); }
  }
}
