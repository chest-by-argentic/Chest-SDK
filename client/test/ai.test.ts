import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";
import * as ai from "../src/ai.js";
import { AiCapReached, AiModelNotAllowed, AiRefused, AiUnavailable, CapabilityNotGranted, ChestError, RateLimited, TooLarge, Unavailable } from "../src/errors.js";

// A Chest's API as its AI gateway answers (chat, streamed or not,
// embeddings, models, usage): the SDK is tested against its routes, its
// shapes and its codes.
const camille = "mbr_camille" + "a".repeat(19);

let seen: { method: string; url: string; type: string | undefined; body: unknown }[] = [];
let reply: (response: ServerResponse, body: unknown) => void = response => json(response, 404, { error: "not_found" });
let closed = false;

function json(response: ServerResponse, status: number, value: unknown): void {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(raw)) }).end(raw);
}
function events(response: ServerResponse, parts: string[], end = true): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const part of parts) response.write(part);
  if (end) response.end();
}
const server: Server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  const body = raw ? JSON.parse(raw) as unknown : null;
  seen.push({ method: request.method ?? "", url: request.url ?? "", type: request.headers["content-type"], body });
  response.on("close", () => { closed = true; });
  reply(response, body);
});

const given = process.env["CHEST_API"];
before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  process.env["CHEST_API"] = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
after(() => {
  server.closeAllConnections();
  server.close();
  if (given === undefined) delete process.env["CHEST_API"];
  else process.env["CHEST_API"] = given;
});
afterEach(() => {
  seen = [];
  closed = false;
});

const usage = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: { cached_tokens: 4 }, cost: 0.000123 };
const completion = (message: Record<string, unknown>, finish = "stop") => ({ id: "chatcmpl-1", object: "chat.completion", created: 1790000000, model: "provider/model-1", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage });
const chunk = (value: Record<string, unknown>) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1790000000, model: "provider/model-1", ...value })}\n\n`;
const delta = (d: Record<string, unknown>, finish: string | null = null) => chunk({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const last = chunk({ choices: [], usage });
const messages: ai.ChatMessage[] = [{ role: "user", content: "Hello" }];

async function collect(stream: AsyncIterable<ai.ChatChunk>): Promise<ai.ChatChunk[]> {
  const all: ai.ChatChunk[] = [];
  for await (const piece of stream) all.push(piece);
  return all;
}
const code = (expected: string) => (error: unknown) => error instanceof ChestError && error.code === expected;

test("chat sends the options under their wire names, and reads the answer", async () => {
  reply = response => json(response, 200, completion({ content: "Hi there" }));
  const tools: ai.ChatTool[] = [{ type: "function", function: { name: "lookup", description: "Finds a task", parameters: { type: "object", properties: { id: { type: "string" } } } } }];
  const r = await ai.chat({ model: "smart", messages, maxTokens: 800, temperature: 0.2, topP: 0.9, stop: ["END"], tools, toolChoice: "auto", responseFormat: { type: "json_object" }, parallelToolCalls: false, seed: 7, reasoningEffort: "low", member: camille });
  assert.deepEqual(r, { text: "Hi there", message: { role: "assistant", content: "Hi there" }, toolCalls: [], finishReason: "stop", model: "provider/model-1", usage: { input: 12, output: 5, cached: 4, cost: 0.000123 } });
  assert.deepEqual(seen, [{ method: "POST", url: "/ai/chat", type: "application/json", body: { model: "smart", messages, max_tokens: 800, temperature: 0.2, top_p: 0.9, stop: ["END"], tools, tool_choice: "auto", response_format: { type: "json_object" }, parallel_tool_calls: false, seed: 7, reasoning_effort: "low", member: camille } }]);
  // Only what is said is sent.
  await ai.chat({ model: "default", messages });
  assert.deepEqual(seen.at(-1)?.body, { model: "default", messages });
});

test("chat reads tool calls, and gives the message to add to the conversation", async () => {
  const calls = [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"id\":\"42\"}" } }, { id: "call_2", type: "function", function: { name: "close", arguments: "{}" } }];
  reply = response => json(response, 200, completion({ content: null, tool_calls: calls }, "tool_calls"));
  const r = await ai.chat({ model: "default", messages });
  assert.equal(r.text, "");
  assert.equal(r.finishReason, "tool_calls");
  assert.deepEqual(r.toolCalls, [{ id: "call_1", name: "lookup", arguments: "{\"id\":\"42\"}" }, { id: "call_2", name: "close", arguments: "{}" }]);
  assert.deepEqual(r.message, { role: "assistant", content: null, tool_calls: calls });
});

test("chat refuses an answer that is not the Chest's", async () => {
  const bad: [number, unknown][] = [
    [200, "not json"],
    [200, { ...completion({ content: "a" }), object: "chat.completion.chunk" }],
    [200, { ...completion({ content: "a" }), choices: [] }],
    [200, completion({ content: 42 })],
    [200, completion({ content: "a", tool_calls: [{ id: "c", type: "other", function: { name: "a", arguments: "{}" } }] })],
    [200, completion({ content: "a", tool_calls: [{ id: "c", type: "function", function: { name: "a", arguments: {} } }] })],
    [200, { ...completion({ content: "a" }), usage: { ...usage, prompt_tokens_details: undefined } }],
    [200, { ...completion({ content: "a" }), usage: { ...usage, cost: -1 } }],
    [200, { ...completion({ content: "a" }), model: undefined }],
    [201, completion({ content: "a" })],
  ];
  for (const [status, value] of bad) {
    reply = response => json(response, status, value);
    await assert.rejects(ai.chat({ model: "default", messages }), Unavailable, JSON.stringify(value));
  }
  // Beyond 16 MiB, it is not read.
  reply = response => json(response, 200, completion({ content: "x".repeat(16 << 20) }));
  await assert.rejects(ai.chat({ model: "default", messages }), Unavailable);
});

test("each refusal of the gateway is its own error", async () => {
  const cases: [number, unknown, (error: unknown) => boolean][] = [
    [402, { error: "cap_reached", scope: "tool", resets: "2026-10-01T00:00:00Z" }, e => e instanceof AiCapReached && e.scope === "tool" && e.resetsAt.getTime() === Date.UTC(2026, 9, 1) && e.status === 402],
    [402, { error: "cap_reached", scope: "chest", resets: "2026-10-01T00:00:00Z" }, e => e instanceof AiCapReached && e.scope === "chest"],
    [402, { error: "cap_reached", scope: "team", resets: "2026-10-01T00:00:00Z" }, e => e instanceof Unavailable],
    [402, { error: "cap_reached", scope: "tool", resets: "soon" }, e => e instanceof Unavailable],
    [403, { error: "capability_not_granted" }, e => e instanceof CapabilityNotGranted],
    [403, { error: "model_not_allowed" }, e => e instanceof AiModelNotAllowed && e.code === "model_not_allowed"],
    [429, { error: "rate_limited" }, e => e instanceof RateLimited],
    [413, { error: "too_large" }, e => e instanceof TooLarge],
    [422, { error: "content_refused" }, e => e instanceof AiRefused && e.status === 422],
    [503, { error: "no_connector" }, e => e instanceof AiUnavailable && e.reason === "no_connector" && e.code === "no_connector"],
    [502, { error: "provider_key_invalid" }, e => e instanceof AiUnavailable && e.reason === "provider_key_invalid" && e.status === 502],
    [503, { error: "provider_unavailable" }, e => e instanceof AiUnavailable && e.reason === "provider_unavailable"],
    [502, { error: "no_connector" }, e => e instanceof Unavailable],
    [503, "gateway down", e => e instanceof Unavailable],
    [400, { error: "invalid_body" }, e => e instanceof ChestError && e.code === "invalid_body" && e.status === 400],
    [400, { error: "invalid_request", message: "temperature must be at most 2" }, e => e instanceof ChestError && e.code === "invalid_request" && /temperature must be at most 2/u.test(e.message)],
    [404, { error: "not_found" }, e => e instanceof Unavailable],
  ];
  for (const [status, value, expected] of cases) {
    reply = response => json(response, status, value);
    await assert.rejects(ai.chat({ model: "default", messages }), expected, `${status} ${JSON.stringify(value)}`);
    await assert.rejects(collect(ai.chat({ model: "default", messages, stream: true })), expected, `streamed: ${status} ${JSON.stringify(value)}`);
  }
  reply = response => json(response, 403, { error: "capability_not_granted" });
  await assert.rejects(ai.embed({ model: "embedding", input: "a" }), CapabilityNotGranted);
  await assert.rejects(ai.models(), CapabilityNotGranted);
  await assert.rejects(ai.usage(), CapabilityNotGranted);
});

test("a streamed chat gives its pieces as they come: text, tool call pieces, finish, usage", async () => {
  reply = response => events(response, [
    ": keep-alive\n\n",
    delta({ role: "assistant", content: "" }),
    delta({ content: "Let me " }),
    delta({ content: "look." }).replace(/\n\n$/u, "\r\n\r\n"),
    delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "{\"id\":" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "\"42\"}" } }] }),
    delta({}, "tool_calls"),
    last,
    "data: [DONE]\n\n",
  ]);
  const pieces = await collect(ai.chat({ model: "fast", messages, stream: true, maxTokens: 100 }));
  assert.deepEqual(seen[0]?.body, { model: "fast", messages, max_tokens: 100, stream: true });
  assert.deepEqual(pieces, [
    { text: "" },
    { text: "Let me " },
    { text: "look." },
    { text: "", toolCalls: [{ index: 0, id: "call_1", name: "lookup", arguments: "" }] },
    { text: "", toolCalls: [{ index: 0, arguments: "{\"id\":" }] },
    { text: "", toolCalls: [{ index: 0, arguments: "\"42\"}" }] },
    { text: "", finishReason: "tool_calls" },
    { text: "", usage: { input: 12, output: 5, cached: 4, cost: 0.000123 } },
  ]);
  assert.equal(pieces.map(p => p.text).join(""), "Let me look.");
});

test("an error in the stream is thrown where it comes, after what came before", async () => {
  const cases: [string, (error: unknown) => boolean][] = [
    ["data: {\"error\": \"provider_unavailable\"}\n\n", e => e instanceof AiUnavailable && e.reason === "provider_unavailable"],
    ["data: {\"error\": \"content_refused\"}\n\n", e => e instanceof AiRefused],
    ["data: {\"error\": \"cap_reached\", \"scope\": \"tool\", \"resets\": \"2026-10-01T00:00:00Z\"}\n\n", e => e instanceof AiCapReached],
    ["data: {\"error\": \"too_large\"}\n\n", e => e instanceof TooLarge],
    ["data: {\"error\": \"something_new\"}\n\n", e => e instanceof Unavailable],
  ];
  for (const [line, expected] of cases) {
    reply = response => events(response, [delta({ role: "assistant", content: "Hel" }), line]);
    const got: string[] = [];
    await assert.rejects((async () => { for await (const piece of ai.chat({ model: "default", messages, stream: true })) got.push(piece.text); })(), expected, line);
    assert.deepEqual(got, ["Hel"]);
  }
});

test("a stream that is not the Chest's is Unavailable", async () => {
  const bad: string[][] = [
    [delta({ content: "a" }), last],                                  // cut before [DONE]
    [delta({ content: "a" }), "data: [DONE]\n\n"],                    // no usage
    [delta({ content: "a" }), "event: ping\n\n", last, "data: [DONE]\n\n"],
    ["data: {not json}\n\n", last, "data: [DONE]\n\n"],
    [chunk({ choices: [] }), "data: [DONE]\n\n"],                     // no choice, no usage
    [delta({ content: 42 }), last, "data: [DONE]\n\n"],
    [delta({ tool_calls: [{ id: "x" }] }), last, "data: [DONE]\n\n"], // no index
    [chunk({ object: "chat.completion", choices: [] , usage }), "data: [DONE]\n\n"],
    [delta({ content: "a" }), last, "data: [DO"],                     // cut in a line
    ["data: " + "x".repeat((1 << 20) + 10) + "\n\n"],                 // a line beyond 1 MiB
  ];
  for (const parts of bad) {
    reply = response => events(response, parts);
    await assert.rejects(collect(ai.chat({ model: "default", messages, stream: true })), Unavailable, parts.join("").slice(0, 120));
  }
  reply = response => json(response, 200, completion({ content: "a" }));
  await assert.rejects(collect(ai.chat({ model: "default", messages, stream: true })), Unavailable);
});

test("breaking out of a stream ends the call; a signal aborts it with its reason", async () => {
  reply = response => events(response, [delta({ content: "a" }), delta({ content: "b" })], false);
  for await (const piece of ai.chat({ model: "default", messages, stream: true })) {
    assert.equal(piece.text, "a");
    break;
  }
  for (let i = 0; i < 50 && !closed; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(closed, true);

  const controller = new AbortController();
  const got: string[] = [];
  await assert.rejects((async () => {
    for await (const piece of ai.chat({ model: "default", messages, stream: true, signal: controller.signal })) {
      got.push(piece.text);
      controller.abort(new Error("stopped by the member"));
    }
  })(), /stopped by the member/u);
  assert.deepEqual(got, ["a"]);

  await assert.rejects(ai.chat({ model: "default", messages, signal: AbortSignal.abort(new Error("never sent")) }), /never sent/u);
  reply = () => {};
  const slow = new AbortController();
  const pending = ai.chat({ model: "default", messages, signal: slow.signal });
  setTimeout(() => slow.abort(new Error("too slow")), 20);
  await assert.rejects(pending, /too slow/u);
});

test("chat and embed refuse what the Chest would refuse, before sending anything", async () => {
  const bad: [() => Promise<unknown>, (error: unknown) => boolean][] = [
    [() => ai.chat({ model: "gpt-5" as ai.Alias, messages }), e => e instanceof AiModelNotAllowed],
    [() => collect(ai.chat({ model: "huge" as ai.Alias, messages, stream: true })), e => e instanceof AiModelNotAllowed],
    [() => ai.chat({ model: "default", messages: [] }), code("invalid_body")],
    [() => ai.chat({ model: "default", messages: [{ content: "a" } as ai.ChatMessage] }), code("invalid_body")],
    [() => ai.chat({ model: "default", messages, maxTokens: 0 }), code("invalid_body")],
    [() => ai.chat({ model: "default", messages, maxTokens: 128001 }), code("invalid_body")],
    [() => ai.chat({ model: "default", messages, maxTokens: 1.5 }), code("invalid_body")],
    [() => ai.chat({ model: "default", messages, member: "camille" }), code("invalid_body")],
    [() => ai.chat({ model: "default", messages: [{ role: "user", content: "x".repeat(10 << 20) }] }), e => e instanceof TooLarge],
    [() => ai.embed({ model: "large" as ai.Alias, input: "a" }), e => e instanceof AiModelNotAllowed],
    [() => ai.embed({ model: "embedding", input: [] }), code("invalid_body")],
    [() => ai.embed({ model: "embedding", input: Array.from({ length: 257 }, () => "a") }), code("invalid_body")],
    [() => ai.embed({ model: "embedding", input: [1 as unknown as string] }), code("invalid_body")],
    [() => ai.embed({ model: "embedding", input: "a", dimensions: 0 }), code("invalid_body")],
    [() => ai.embed({ model: "embedding", input: "a", member: "mbr_x" }), code("invalid_body")],
  ];
  for (const [call, expected] of bad) await assert.rejects(call(), expected, call.toString());
  assert.deepEqual(seen, []);
});

test("embed sends the texts and reads one vector per text, in the order given", async () => {
  reply = response => json(response, 200, { object: "list", data: [{ object: "embedding", index: 1, embedding: [0, 1] }, { object: "embedding", index: 0, embedding: [1, 0] }], model: "provider/embed-1", usage: { prompt_tokens: 3, total_tokens: 3, cost: 0.00001 } });
  assert.deepEqual(await ai.embed({ model: "embedding", input: ["a", "b"], dimensions: 2, member: camille }), { embeddings: [[1, 0], [0, 1]], model: "provider/embed-1", usage: { input: 3, cost: 0.00001 } });
  assert.deepEqual(seen, [{ method: "POST", url: "/ai/embeddings", type: "application/json", body: { model: "embedding", input: ["a", "b"], dimensions: 2, member: camille } }]);
  const bad: unknown[] = [
    { object: "list", data: [{ object: "embedding", index: 0, embedding: [1] }], model: "m", usage: { prompt_tokens: 1, total_tokens: 1, cost: 0 } },
    { object: "list", data: [{ object: "embedding", index: 0, embedding: [1] }, { object: "embedding", index: 0, embedding: [1] }], model: "m", usage: { prompt_tokens: 1, total_tokens: 1, cost: 0 } },
    { object: "list", data: [{ object: "embedding", index: 0, embedding: [1] }, { object: "embedding", index: 1, embedding: [1, 2] }], model: "m", usage: { prompt_tokens: 1, total_tokens: 1, cost: 0 } },
    { object: "list", data: [{ object: "embedding", index: 0, embedding: [1] }, { object: "embedding", index: 1, embedding: ["1"] }], model: "m", usage: { prompt_tokens: 1, total_tokens: 1, cost: 0 } },
    { object: "list", data: [{ object: "embedding", index: 0, embedding: [1] }, { object: "embedding", index: 1, embedding: [1] }], model: "m" },
  ];
  for (const value of bad) {
    reply = response => json(response, 200, value);
    await assert.rejects(ai.embed({ model: "embedding", input: ["a", "b"] }), Unavailable, JSON.stringify(value));
  }
});

test("models and usage read the tool's aliases and its month", async () => {
  const list = [{ alias: "default", model: "anthropic/claude-x", provider: "openrouter", input: 3, output: 15 }, { alias: "embedding", model: "openai/text-embedding-x", provider: "openrouter", input: 0.02, output: 0 }];
  reply = response => json(response, 200, { models: list });
  assert.deepEqual(await ai.models(), list);
  assert.deepEqual(seen.map(s => [s.method, s.url]), [["GET", "/ai/models"]]);
  for (const value of [{ models: [...list].reverse() }, { models: [{ ...list[0], provider: "openai" }] }, { models: [{ ...list[0], input: -1 }] }, { models: [list[0], list[0]] }, {}]) {
    reply = response => json(response, 200, value);
    await assert.rejects(ai.models(), Unavailable, JSON.stringify(value));
  }
  reply = response => json(response, 200, { month: "2026-09", spent: 1.23, cap: 20, resets: "2026-10-01T00:00:00Z" });
  assert.deepEqual(await ai.usage(), { month: "2026-09", spent: 1.23, cap: 20, resetsAt: new Date("2026-10-01T00:00:00Z") });
  for (const value of [{ month: "2026-9", spent: 1, cap: 20, resets: "2026-10-01T00:00:00Z" }, { month: "2026-09", spent: -1, cap: 20, resets: "2026-10-01T00:00:00Z" }, { month: "2026-09", spent: 1, cap: 2.5, resets: "2026-10-01T00:00:00Z" }, { month: "2026-09", spent: 1, cap: 20, resets: "tomorrow" }]) {
    reply = response => json(response, 200, value);
    await assert.rejects(ai.usage(), Unavailable, JSON.stringify(value));
  }
});

test("without the Chest's API, the tool does not hold ai", async () => {
  const api = process.env["CHEST_API"];
  delete process.env["CHEST_API"];
  try {
    await assert.rejects(ai.chat({ model: "default", messages }), CapabilityNotGranted);
    await assert.rejects(ai.usage(), CapabilityNotGranted);
  } finally {
    process.env["CHEST_API"] = api;
  }
});
