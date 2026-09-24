import { ChestChannel } from "./channel.js";
// role is the member's role among those the package declares, the default one
// when the owner named none; absent for a package that declares no role.
export type Actor = { subject: string; manage: boolean; publish: boolean; role?: string };
export type Invocation = { id: string; operation: string; input: unknown; actor: Actor; deadline: number };
function object(input: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input) || !Object.keys(input).every(k => keys.includes(k) || optional.includes(k)) || !keys.every(k => Object.hasOwn(input, k))) throw new Error("Invalid invocation envelope");
  return input as Record<string, unknown>;
}
export function invocation(input: unknown): Invocation {
  const value = object(input, ["id", "operation", "input", "actor", "deadline"]);
  const actor = object(value["actor"], ["subject", "manage", "publish"], ["role"]);
  if (typeof value["id"] !== "string" || !/^[A-Za-z0-9_-]{16,64}$/u.test(value["id"]) || typeof value["operation"] !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(value["operation"]) || typeof value["deadline"] !== "number" || !Number.isSafeInteger(value["deadline"]) || typeof actor["subject"] !== "string" || actor["subject"].length > 255 || typeof actor["manage"] !== "boolean" || typeof actor["publish"] !== "boolean") throw new Error("Invalid invocation envelope");
  const role = actor["role"];
  if (role !== undefined && (typeof role !== "string" || !/^[a-z][a-z0-9-]{0,47}$/u.test(role))) throw new Error("Invalid invocation envelope");
  // Empty subject is exclusively anonymous, and can never carry member rights nor a role.
  if (actor["subject"] === "" && (actor["manage"] || actor["publish"] || role !== undefined)) throw new Error("Invalid invocation envelope");
  return { id: value["id"], operation: value["operation"], input: value["input"], deadline: value["deadline"], actor: { subject: actor["subject"], manage: actor["manage"], publish: actor["publish"], ...(role === undefined ? {} : { role }) } };
}
export class ChestRequests {
  constructor(private readonly channel: ChestChannel) {}
  async next(): Promise<Invocation | null> {
    const response = await this.channel.exchange("GET", "/requests/next", "", [200, 204]);
    return response.status === 204 ? null : invocation(JSON.parse(response.body) as unknown);
  }
  async reply(id: string, status: number, body: unknown): Promise<void> {
    await this.channel.exchange("POST", "/requests/reply", JSON.stringify({ id, status, body }), [204]);
  }
}
