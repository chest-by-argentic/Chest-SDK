import type { IncomingMessage } from "node:http";
import { member, type Member } from "./member.js";
import { actionChannel, delivery, json, object } from "./signed.js";

// What Perseus may read and do in a server tool, in a member's name: its
// chest.json declares each action, a sentence the member reads and the
// shape of its input, and whether it changes anything; each is approved
// at install (“Perseus may: Add a task”):
//
//   "actions": {
//     "add-task": { "description": "Add a task",
//                   "input": { "title": "text", "due": "date?", "document": "document?" },
//                   "changes": true },
//     "tasks":    { "description": "List my open tasks", "input": {}, "changes": false }
//   }
//
// The kinds of a field are those of an event's data (id, text, number,
// boolean, time, date, member, members; ? for an optional one), a document
// (the id of a document of Files the member reads in a folder given to the
// tool, which it opens with folders.open) and an amount
// ({ value: "240.00", currency: "GBP" }, ISO 4217). Perseus calls an action
// that only reads by itself; one that changes, only once the member
// confirmed its proposal. The Chest checks every input against the
// declaration before the tool sees it, then posts it to the tool's POST
// /chest-actions/<name> through its launcher only, signed, with the
// member's assertion as a request of theirs carries:
//
//   // app/chest-actions/[name]/route.ts (Next.js): outside /chest, never behind a session
//   import * as actions from "@argentic/chest-sdk/actions";
//   export async function POST(request: Request) {
//     const { status, body } = await actions.handle(request, {
//       "add-task": async ({ input, member }) => ({ said: `Added “${await addTask(input, member)}”` }),
//       tasks: async ({ member }) => ({ said: "Your open tasks", data: await openTasks(member) }),
//     });
//     return new Response(body, { status, headers: { "Content-Type": "application/json" } });
//   }
//
// The tool answers within 10 seconds { said, data? }: said, the sentence
// Perseus shows the member (“Added “Renew the insurance”, due 1 March”), 1 to
// 280 characters; data, what a read returns, JSON of 64 KiB at most. A
// handler refuses with Refused: “invalid_input” for an input it cannot
// take, “refused” for what the member may not do.

// A call: its id (“act_…”), the action's name, its input as the Chest
// checked it, and the member it is made for.
export type Call = { id: string; name: string; input: Record<string, unknown>; member: Member };

// What a handler answers.
export type Answer = { said: string; data?: unknown };

// What handle() calls for each action, by its name.
export type Handlers = Record<string, (call: Call) => Answer | Promise<Answer>>;

// A refusal of the handler, as the Chest tells Perseus.
export class Refused extends Error {
  readonly code: "invalid_input" | "refused";
  constructor(code: "invalid_input" | "refused", message: string = code) {
    super(message);
    this.name = "Refused";
    this.code = code;
  }
}

// The grammar of an action's name, and the bounds of an answer.
const actionNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,2}$/u;
const maxSaid = 280;
const maxAnswer = 64 << 10;

// nameOf is the action a request's path names: /chest-actions/<name>.
function nameOf(request: IncomingMessage | Request): string | null {
  try {
    const path = new URL(request.url ?? "", "http://tool").pathname;
    const name = path.startsWith("/chest-actions/") ? path.slice("/chest-actions/".length) : "";
    return name.length <= 48 && actionNamePattern.test(name) ? name : null;
  } catch {
    return null;
  }
}

// read returns the call a request carries, or null when it is not one the
// Chest made for this tool: not a POST to /chest-actions/<name>, no or
// another signature, another tool, expired, a body other than the one
// signed or not {"input": {…}}, no member's assertion. It reads the body
// (64 KiB at most): call it before anything else reads it. It never throws
// for what a request carries.
export async function read(request: IncomingMessage | Request): Promise<Call | null> {
  const name = nameOf(request);
  const asked = name === null ? null : member(request);
  if (name === null || asked === null) return null;
  const signed = await delivery(request, actionChannel);
  if (!signed) return null;
  const body = object(json(signed.body.toString("utf8")));
  const input = body && Object.keys(body).length === 1 ? object(body["input"]) : null;
  return input ? { id: signed.id, name, input, member: asked } : null;
}

// answer is the body of an answer: { said, data? }. It throws for a
// sentence empty or longer than 280 characters, or an answer beyond 64 KiB.
export function answer(said: string, data?: unknown): string {
  const sentence = said.trim();
  if (sentence === "" || [...sentence].length > maxSaid || /[\p{Cc}\p{Cf}]/u.test(sentence)) throw new Error("an action's sentence is 1 to 280 printable characters");
  const body = JSON.stringify(data === undefined ? { said: sentence } : { said: sentence, data });
  if (Buffer.byteLength(body) > maxAnswer) throw new Error("an action's answer is 64 KiB at most");
  return body;
}

// handle reads one call and runs the handler of its action: the status and
// the body to answer the Chest. 401 for a call that is not the Chest's;
// 404 for an action without a handler; 200 and { said, data? } once the
// handler answered; 400 { error: "invalid_input" } or 403 { error:
// "refused" } when it threw Refused. Any other error is thrown: answer 500.
export async function handle(request: IncomingMessage | Request, handlers: Handlers): Promise<{ status: number; body: string }> {
  const call = await read(request);
  if (!call) return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
  const handler = Object.hasOwn(handlers, call.name) ? handlers[call.name] : undefined;
  if (!handler) return { status: 404, body: JSON.stringify({ error: "not_found" }) };
  try {
    const result = await handler(call);
    return { status: 200, body: answer(result.said, result.data) };
  } catch (error) {
    if (error instanceof Refused) return { status: error.code === "invalid_input" ? 400 : 403, body: JSON.stringify({ error: error.code }) };
    throw error;
  }
}
