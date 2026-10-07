import { ask as chest, json, refusal } from "./api.js";
import { ChestError, TooLarge, Unavailable } from "./errors.js";
import { memberIdPattern } from "./member.js";

// Live updates of the members' pages, for a server tool whose chest.json
// declares "capabilities": ["realtime"] and, under "realtime", its channels
// and the tables whose writes become events (feeds). The Chest holds every
// page's connection: the tool writes rows as always — a feed turns each
// committed insert, update or delete into "<table>.insert", ".update",
// ".delete" on its channel — and calls this module only for what is not a
// row. The pages listen with @argentic/chest-sdk/realtime/client.
//
//   import * as realtime from "@argentic/chest-sdk/realtime";
//   await realtime.publish("everyone", "rooms.changed", { id: 42 });  // to every page joined there
//   const { reached } = await realtime.send([memberId], "unread", { room: 42, count: 3 });
//   const { online, watching } = await realtime.online(roomMemberIds, { channel: "room:42" });  // notify those not watching it
//   const { members } = await realtime.presence("everyone");
//
// Delivery is at most once: the tool's database is the truth, an event a
// hint that something changed. Errors: CapabilityNotGranted (403),
// TooLarge (413, a payload beyond 64 KiB), RateLimited (429: the members'
// pages fall behind; wait a second), Unavailable (503, or the Chest not
// reached), ChestError otherwise (invalid_channel — no declared channel
// has that name —, invalid_event, invalid_id, invalid_body 400).

// Someone present in a channel, and the state their page tracks.
export type Present = { id: string; state: Record<string, unknown> };

// The grammars of the Chest: a channel is segments of a-z 0-9 _ - joined by
// colons, 128 characters at most; an event 1 to 64 of a-z 0-9 . _ -.
export const channelPattern = /^[a-z0-9_-]{1,64}(?::[a-z0-9_-]{1,64})*$/u;
export const eventPattern = /^[a-z0-9._-]{1,64}$/u;
const maxChannel = 128, maxPayload = 64 << 10;

function checkChannel(channel: unknown): string {
  if (typeof channel !== "string" || channel.length > maxChannel || !channelPattern.test(channel)) throw new ChestError("invalid_channel", 400, "a channel is segments of a-z 0-9 _ - joined by colons");
  return channel;
}
function checkEvent(event: unknown): string {
  if (typeof event !== "string" || !eventPattern.test(event)) throw new ChestError("invalid_event", 400, "an event is 1 to 64 of a-z 0-9 . _ -");
  return event;
}
function checkIds(ids: Iterable<string>): string[] {
  const all = [...ids];
  if (all.length < 1) throw new ChestError("invalid_body", 400, "one member identifier at least");
  if (!all.every(id => typeof id === "string" && memberIdPattern.test(id))) throw new ChestError("invalid_id", 400, "invalid member identifier");
  return all;
}
// body is a call's JSON; a payload the Chest would refuse is refused here.
function body(fields: Record<string, unknown>): string {
  const payload = JSON.stringify(fields["payload"] ?? null);
  if (payload === undefined) throw new ChestError("invalid_body", 400, "a payload is JSON");
  if (Buffer.byteLength(payload) > maxPayload) throw new TooLarge();
  return JSON.stringify(fields);
}

const call = async (method: string, path: string, value?: string): Promise<unknown> => {
  const response = await chest("realtime", method, path, value === undefined ? {} : { body: value, type: "application/json" });
  if (response.status !== 200) {
    if (response.status < 400) {
      await response.body?.cancel();
      throw new Unavailable();
    }
    throw await refusal(response, "realtime");
  }
  return json(response);
};
const record = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Unavailable();
  return v as Record<string, unknown>;
};
const ids = (v: unknown): string[] => {
  if (!Array.isArray(v) || !v.every(id => typeof id === "string" && memberIdPattern.test(id))) throw new Unavailable();
  return [...v] as string[];
};

// publish delivers an event to every page joined to a channel the tool
// declares — numbered, in order, kept a short while for a page that
// reconnects —: its number in the channel.
export async function publish(channel: string, event: string, payload?: unknown): Promise<{ seq: number }> {
  const answer = record(await call("POST", "/realtime/publish", body({ channel: checkChannel(channel), event: checkEvent(event), payload })));
  if (!Number.isSafeInteger(answer["seq"]) || (answer["seq"] as number) < 1) throw new Unavailable();
  return { seq: answer["seq"] as number };
}

// send delivers an event to every page of these members, outside any
// channel: those it reached. The others are not online in the tool.
export async function send(memberIds: Iterable<string>, event: string, payload?: unknown): Promise<{ reached: string[] }> {
  const answer = record(await call("POST", "/realtime/send", body({ members: checkIds(memberIds), event: checkEvent(event), payload })));
  return { reached: ids(answer["reached"]) };
}

// online says which of these members have a page of the tool open now,
// and, given a channel, which of them watch it — a page focused on it
// (live.focus) and in the foreground: what decides whom to notify. A chat
// notifies the members online but not watching the conversation, and every
// member not online: those watching it see the message already.
export async function online(memberIds: Iterable<string>, options: { channel?: string } = {}): Promise<{ online: string[]; watching: string[] }> {
  const members = checkIds(memberIds);
  const channel = options.channel === undefined ? undefined : checkChannel(options.channel);
  const answer = record(await call("POST", "/realtime/online", JSON.stringify({ members, ...(channel === undefined ? {} : { channel }) })));
  return { online: ids(answer["online"]), watching: ids(answer["watching"]) };
}

// presence is who appears in a channel now — merged across their pages —,
// with the state they track.
export async function presence(channel: string): Promise<{ members: Present[] }> {
  const answer = record(await call("GET", "/realtime/presence?channel=" + encodeURIComponent(checkChannel(channel))));
  const members = answer["members"];
  if (!Array.isArray(members)) throw new Unavailable();
  return {
    members: members.map(m => {
      const p = record(m);
      if (typeof p["id"] !== "string" || !memberIdPattern.test(p["id"])) throw new Unavailable();
      return { id: p["id"], state: record(p["state"]) };
    }),
  };
}
