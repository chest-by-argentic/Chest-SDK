import type { IncomingMessage } from "node:http";
import { delivery, instant, json, memorySeen, object, scheduleChannel, type Seen } from "./signed.js";

// Work a server tool does by itself, at set times, without anyone opening
// it: a morning digest, reminders, a purge, a badge kept true overnight.
// Nothing runs in the tool's container between requests — the tool may be
// asleep —: the Chest calls it. Its chest.json declares each schedule, a
// name and a cron line read on the wall clock of the Chest's time zone
// (chest.timeZone), which the owner approves in words ("Runs by itself:
// morning, weekdays at 7:30 AM"):
//
//   "schedules": [{ "name": "morning", "cron": "30 7 * * 1-5" }]
//
// At each time, the Chest posts the run to the tool's POST /chest-schedules,
// through its launcher only (never from the Internet), signed for this tool,
// the tool woken first when it sleeps:
//
//   // app/chest-schedules/route.ts (Next.js): outside /chest, never behind a session
//   import * as schedules from "@argentic/chest-sdk/schedules";
//   export async function POST(request: Request) {
//     return new Response(null, { status: await schedules.handle(request, {
//       morning: async run => { await remindDueToday(); },
//     }, { seen }) });
//   }
//
// The tool answers once its work is done, within 5 minutes. A run is
// delivered at least once, with the same id every time: one not answered
// with a success is delivered again after 1, 5 and 15 minutes (run.attempt
// counts, 4 at most), unless the next time of its schedule comes first.
// Runs of one schedule never overlap: a time that comes while the previous
// run still runs is skipped. A server that was stopped runs a missed time
// once when it starts again. Whoever runs the tool sees each run on its
// page, and may run a schedule now.
//
// Bounds (the Chest's): 8 schedules, each 15 minutes apart at least; 5
// minutes a run.

// A run: its id ("run_…", the same on every delivery of it), its schedule,
// the time it stands for (RFC 3339, UTC: a run asked now stands for the time
// it was asked), and its attempt (1 to 4).
export type Run = { id: string; name: string; scheduledAt: string; attempt: number };

// What handle() calls for each schedule, by its name.
export type Handlers = Record<string, (run: Run) => void | Promise<void>>;

export type { Seen };

// The grammar of a schedule's name, as the Chest keeps it.
const scheduleNamePattern = /^[a-z][a-z0-9-]{0,31}$/u;

// verify returns the run a delivery carries, or null when it is not one the
// Chest made for this tool: not a POST, no or another signature, another
// tool, expired, a body other than the one signed or not of a run's shape.
// It reads the body (1 KiB at most): call it before anything else reads it.
// It never throws for what a request carries.
export async function verify(request: IncomingMessage | Request): Promise<Run | null> {
  const signed = await delivery(request, scheduleChannel);
  if (!signed) return null;
  const r = object(json(signed.body.toString("utf8")));
  if (!r || Object.keys(r).sort().join(",") !== "attempt,id,name,scheduledAt" || r["id"] !== signed.id) return null;
  const { name, scheduledAt, attempt } = r;
  if (typeof name !== "string" || !scheduleNamePattern.test(name) || !instant(scheduledAt) || typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > 4) return null;
  return { id: signed.id, name, scheduledAt, attempt };
}

const remembered = memorySeen();

// handle verifies one delivery and runs the handler of its schedule, once:
// the status to answer the Chest. 401 for a delivery that is not the
// Chest's; 404 for a schedule without a handler (the Chest does not try
// again: the version in service does not do it); 204 once the handler
// returned, or for a run already handled (seen.has). A handler that throws
// leaves the run unseen and handle throws: answer 500, the Chest delivers
// it again. seen is the store of the runs handled (memorySeen by default,
// lost at a restart: give a durable one — events' store serves both, the
// ids never meet).
export async function handle(request: IncomingMessage | Request, handlers: Handlers, options: { seen?: Seen } = {}): Promise<number> {
  const run = await verify(request);
  if (!run) return 401;
  const handler = Object.hasOwn(handlers, run.name) ? handlers[run.name] : undefined;
  if (!handler) return 404;
  const seen = options.seen ?? remembered;
  if (await seen.has(run.id)) return 204;
  await handler(run);
  await seen.add(run.id);
  return 204;
}
