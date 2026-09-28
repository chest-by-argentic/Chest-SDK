import { ask, json, read } from "./api.js";
import { AiCapReached, AiModelNotAllowed, AiRefused, AiUnavailable, CapabilityNotGranted, ChestError, RateLimited, TooLarge, Unavailable, type AiUnavailableReason } from "./errors.js";
import { memberIdPattern } from "./member.js";

// AI models through the Chest, for a server tool whose chest.json declares
// "capabilities": ["ai"] and "ai": {"monthly", "models", "purpose"}: the
// Chest's owner connects the providers (their own keys) and maps the aliases
// the tool names (default, fast, smart, embedding) to models; the Chest meters
// every call against the tool's monthly cap. The tool never holds a key.
//
//   import * as ai from "@argentic/chest-sdk/ai";
//   const r = await ai.chat({ model: "default", messages: [{ role: "user", content: "Summarise: …" }], maxTokens: 800, member: who.id });
//   r.text; r.toolCalls; r.usage.cost;                        // estimated euros
//   for await (const chunk of ai.chat({ model: "fast", messages, stream: true })) write(chunk.text);
//   const { embeddings } = await ai.embed({ model: "embedding", input: ["a", "b"] });
//   const mapped = await ai.models();                         // the declared aliases, their models and prices
//   const { spent, cap, resetsAt } = await ai.usage();        // this tool's month
//
// AI can stop at any time — the month's budget spent, no connector, the
// provider down: keep the tool usable without it.
//
//   import { AiCapReached, AiUnavailable } from "@argentic/chest-sdk/errors";
//   let summary: string | null = null;
//   try {
//     summary = (await ai.chat({ model: "default", messages, maxTokens: 300 })).text;
//   } catch (error) {
//     if (!(error instanceof AiCapReached || error instanceof AiUnavailable)) throw error;
//     // summary stays null: the page says "AI features are paused" and works without it
//   }
//
// Errors: AiCapReached (402: the tool's or the Chest's month cap, scope and
// resetsAt), AiModelNotAllowed (403: a model the tool did not declare),
// CapabilityNotGranted (403), AiRefused (422: the provider's moderation),
// RateLimited (429: 60 requests a minute, 8 streams at once), TooLarge (413:
// a body beyond 10 MiB, or a context beyond the model's), AiUnavailable (503
// no_connector, 502 provider_key_invalid, 503 provider_unavailable),
// Unavailable (the Chest not reached, or an answer that is not its own),
// ChestError otherwise (invalid_body, invalid_request 400: the provider
// rejected the request's parameters, its message in the error's).

// The names a tool gives models: the owner maps each to a provider's model.
export type Alias = "default" | "fast" | "smart" | "embedding";
// The providers a Chest connects.
export type Provider = "openrouter";

// A message of a conversation, in the OpenAI Chat Completions shape: content
// is text, or parts (text, images) passed as they are; an assistant's message
// may carry tool_calls, and a tool's answer names the tool_call_id it answers.
export type ChatMessage = {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: string | unknown[] | null;
  name?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};
// A tool the model may call (the gateway never runs one): its name, what it
// does and the JSON Schema of its arguments.
export type ChatTool = { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean } };
// Whether and which tool the model calls.
export type ToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };
// The shape of the answer: text, any JSON object, or JSON of that schema.
export type ResponseFormat = { type: "text" } | { type: "json_object" } | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean; description?: string } };

// What chat asks: an alias the tool declared, the conversation, and the
// options of the OpenAI shape (maxTokens 1 to 128,000, 4,096 when not said).
// member is the member the call is made for: attribution in the Chest's usage
// log only. signal aborts the call (its reason is thrown); the Chest ends a
// call after 10 minutes. With stream: true the answer comes in chunks.
export type ChatOptions = {
  model: Alias;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  tools?: ChatTool[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  parallelToolCalls?: boolean;
  seed?: number;
  reasoningEffort?: string;
  member?: string;
  signal?: AbortSignal;
};
// A call of a tool the model asks: its id (to name in the tool's answer), the
// tool's name, and its arguments as the model wrote them (JSON text).
export type ToolCall = { id: string; name: string; arguments: string };
// A piece of a tool call, in a stream: index says which call it continues;
// id and name come first, arguments in pieces to join.
export type ToolCallDelta = { index: number; id?: string; name?: string; arguments?: string };
// The tokens of a call (input, output, input read from the provider's cache)
// and its estimated cost in euros, counted against the caps.
export type Usage = { input: number; output: number; cached: number; cost: number };
// A whole answer: its text ("" when none), the assistant's message as it is
// added to the conversation, the tool calls asked, why it ended (stop,
// length, tool_calls, content_filter), the provider's model and the usage.
export type ChatResult = { text: string; message: ChatMessage; toolCalls: ToolCall[]; finishReason: string; model: string; usage: Usage };
// A piece of a streamed answer: its text ("" when none), tool call pieces,
// why it ended (once), and the usage (in the last chunk).
export type ChatChunk = { text: string; toolCalls?: ToolCallDelta[]; finishReason?: string; usage?: Usage };

// What embed asks: an alias the tool declared, 1 to 256 texts, the size of
// the vectors when the model can shorten them, and the member it is for.
export type EmbedOptions = { model: Alias; input: string | string[]; dimensions?: number; member?: string };
// One vector per text, in the order given, the provider's model, the input
// tokens and the estimated cost in euros.
export type Embeddings = { embeddings: number[][]; model: string; usage: { input: number; cost: number } };
// A declared alias the owner mapped: its provider's model and its prices, in
// US dollars per million tokens (as providers publish them).
export type AiModel = { alias: Alias; model: string; provider: Provider; input: number; output: number };
// This tool's month (YYYY-MM, UTC): estimated euros spent, the cap in force,
// and when the next month starts.
export type AiUsage = { month: string; spent: number; cap: number; resetsAt: Date };

const aliases: readonly string[] = ["default", "fast", "smart", "embedding"];
const providers: readonly string[] = ["openrouter"];
const reasons: readonly string[] = ["no_connector", "provider_key_invalid", "provider_unavailable"];
// The bounds of the Chest's gateway, and of what the SDK reads of it.
const maxBody = 10 << 20, maxAnswer = 16 << 20, maxLine = 1 << 20, maxOutput = 128000, maxInputs = 256;
const chatDeadline = 600_000;
// The HTTP status of each code the gateway sends, to map one that comes in a
// stream.
const statuses: Record<string, number> = { capability_not_granted: 403, model_not_allowed: 403, cap_reached: 402, rate_limited: 429, no_connector: 503, provider_key_invalid: 502, provider_unavailable: 503, content_refused: 422, too_large: 413, invalid_body: 400, invalid_request: 400 };
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

const invalid = (message: string): ChestError => new ChestError("invalid_body", 400, message);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const tokens = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function time(value: unknown): Date | null {
  if (typeof value !== "string" || !rfc3339.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function checkModel(model: unknown): void {
  if (typeof model !== "string" || !aliases.includes(model)) throw new AiModelNotAllowed();
}
function checkMember(member: unknown): string {
  if (typeof member !== "string" || !memberIdPattern.test(member)) throw invalid("member is a member identifier (mbr_…)");
  return member;
}

// request is the wire body of a chat, checked as the Chest checks it.
function request(options: ChatOptions, stream: boolean): Record<string, unknown> {
  const o = options as Partial<ChatOptions> | null;
  if (!o) throw invalid("chat takes options");
  checkModel(o.model);
  if (!Array.isArray(o.messages) || o.messages.length < 1 || !o.messages.every(m => typeof record(m)?.["role"] === "string")) throw invalid("messages are 1 or more {role, content}");
  if (o.maxTokens !== undefined && (!Number.isInteger(o.maxTokens) || o.maxTokens < 1 || o.maxTokens > maxOutput)) throw invalid("maxTokens is 1 to 128000");
  const pairs: [string, unknown][] = [["max_tokens", o.maxTokens], ["temperature", o.temperature], ["top_p", o.topP], ["stop", o.stop], ["tools", o.tools], ["tool_choice", o.toolChoice], ["response_format", o.responseFormat], ["parallel_tool_calls", o.parallelToolCalls], ["seed", o.seed], ["reasoning_effort", o.reasoningEffort], ["member", o.member === undefined ? undefined : checkMember(o.member)]];
  return { model: o.model, messages: o.messages, ...Object.fromEntries(pairs.filter(([, v]) => v !== undefined)), ...(stream ? { stream: true } : {}) };
}

// send posts a body of JSON to the gateway, 10 MiB at most.
async function send(path: string, body: Record<string, unknown>, signal?: AbortSignal, deadline?: number): Promise<Response> {
  const raw = JSON.stringify(body);
  if (Buffer.byteLength(raw) > maxBody) throw new TooLarge();
  return ask("ai", "POST", path, { body: raw, type: "application/json", ...(deadline !== undefined ? { deadline } : {}), ...(signal !== undefined ? { signal } : {}) });
}

// answer reads a success of 16 MiB at most as JSON; anything else is not the
// Chest's.
async function answer(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await read(response, maxAnswer)));
  } catch {
    if (signal?.aborted) throw signal.reason;
    throw new Unavailable();
  }
}

// mapped turns a refusal of the gateway, with the status it came with, into
// what the tool tests.
function mapped(status: number, error: Record<string, unknown> | null): ChestError {
  const code = error?.["error"];
  const resets = time(error?.["resets"]), scope = error?.["scope"];
  if (status === 402 && code === "cap_reached" && resets && (scope === "tool" || scope === "chest")) return new AiCapReached(scope, resets);
  if (status === 403) return code === "model_not_allowed" ? new AiModelNotAllowed() : new CapabilityNotGranted("ai");
  if (status === 429) return new RateLimited();
  if (status === 413) return new TooLarge();
  if (status === 422 && code === "content_refused") return new AiRefused();
  if (typeof code === "string" && reasons.includes(code) && statuses[code] === status) return new AiUnavailable(code as AiUnavailableReason);
  if (status === 400 && typeof code === "string" && /^[a-z_]{1,40}$/u.test(code)) {
    const message = error?.["message"];
    return new ChestError(code, 400, code === "invalid_request" && typeof message === "string" && message.length <= 300 ? `the AI provider rejected the request: ${message}` : `the Chest refused: ${code}`);
  }
  return new Unavailable();
}
async function refused(response: Response): Promise<ChestError> {
  if (response.status < 400) {
    await response.body?.cancel();
    return new Unavailable();
  }
  let error: Record<string, unknown> | null = null;
  try {
    error = record(await json(response));
  } catch {
    // Not the gateway's refusal: mapped by its status alone.
  }
  return mapped(response.status, error);
}

function usageOf(value: unknown): Usage {
  const u = record(value), cached = record(u?.["prompt_tokens_details"])?.["cached_tokens"];
  if (!u || !tokens(u["prompt_tokens"]) || !tokens(u["completion_tokens"]) || !tokens(u["total_tokens"]) || !tokens(cached) || !amount(u["cost"])) throw new Unavailable();
  return { input: u["prompt_tokens"], output: u["completion_tokens"], cached, cost: u["cost"] };
}

// result reads a chat completion; anything else is not the Chest's.
function result(value: unknown): ChatResult {
  const c = record(value), choices = c?.["choices"];
  if (!c || c["object"] !== "chat.completion" || typeof c["model"] !== "string" || !Array.isArray(choices) || choices.length !== 1) throw new Unavailable();
  const choice = record(choices[0]), m = record(choice?.["message"]);
  const content = m?.["content"], calls = m?.["tool_calls"];
  if (!choice || choice["index"] !== 0 || typeof choice["finish_reason"] !== "string" || !m || m["role"] !== "assistant" || !(content === null || typeof content === "string") || !(calls === undefined || Array.isArray(calls))) throw new Unavailable();
  const toolCalls = (calls ?? []).map((value: unknown): ToolCall => {
    const call = record(value), f = record(call?.["function"]);
    if (!call || typeof call["id"] !== "string" || call["type"] !== "function" || !f || typeof f["name"] !== "string" || typeof f["arguments"] !== "string") throw new Unavailable();
    return { id: call["id"], name: f["name"], arguments: f["arguments"] };
  });
  const message: ChatMessage = { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls.map(t => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) } : {}) };
  return { text: content ?? "", message, toolCalls, finishReason: choice["finish_reason"], model: c["model"], usage: usageOf(c["usage"]) };
}

// chunk reads a chunk of a stream: an error of the gateway is thrown, a
// chunk is read as the tool gets it; anything else is not the Chest's.
function chunk(value: unknown): ChatChunk {
  const c = record(value);
  if (c && "error" in c) {
    const code = c["error"];
    throw mapped(typeof code === "string" ? statuses[code] ?? 503 : 503, c);
  }
  const choices = c?.["choices"], usage = c?.["usage"];
  if (!c || c["object"] !== "chat.completion.chunk" || !Array.isArray(choices) || choices.length > 1) throw new Unavailable();
  const piece: ChatChunk = { text: "" };
  if (choices.length === 1) {
    const choice = record(choices[0]), delta = record(choice?.["delta"]);
    const content = delta?.["content"], calls = delta?.["tool_calls"], finish = choice?.["finish_reason"];
    if (!choice || choice["index"] !== 0 || !delta || !(content === undefined || content === null || typeof content === "string") || !(calls === undefined || Array.isArray(calls)) || !(finish === undefined || finish === null || typeof finish === "string")) throw new Unavailable();
    piece.text = content ?? "";
    if (calls?.length) {
      piece.toolCalls = calls.map((value: unknown): ToolCallDelta => {
        const call = record(value), f = call?.["function"] === undefined ? {} : record(call["function"]);
        const index = call?.["index"], id = call?.["id"], name = f?.["name"], args = f?.["arguments"];
        if (!call || !f || !tokens(index) || !(id === undefined || typeof id === "string") || !(call["type"] === undefined || call["type"] === "function") || !(name === undefined || typeof name === "string") || !(args === undefined || typeof args === "string")) throw new Unavailable();
        return { index, ...(id !== undefined ? { id } : {}), ...(name !== undefined ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}) };
      });
    }
    if (typeof finish === "string") piece.finishReason = finish;
  }
  if (usage !== undefined && usage !== null) piece.usage = usageOf(usage);
  else if (choices.length === 0) throw new Unavailable();
  return piece;
}

// lines reads the lines of an event stream, each 1 MiB at most; a line cut
// by the end of the stream is not read.
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const bytes of body) {
    pending += decoder.decode(bytes, { stream: true });
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (Buffer.byteLength(line) > maxLine + 1) throw new Unavailable();
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
    if (Buffer.byteLength(pending) > maxLine) throw new Unavailable();
  }
}

async function completed(options: ChatOptions): Promise<ChatResult> {
  const response = await send("/ai/chat", request(options, false), options.signal, chatDeadline);
  if (response.status !== 200) throw await refused(response);
  return result(await answer(response, options.signal));
}

async function* streamed(options: ChatOptions): AsyncGenerator<ChatChunk> {
  const response = await send("/ai/chat", request(options, true), options.signal, chatDeadline);
  if (response.status !== 200) throw await refused(response);
  if (!/^text\/event-stream(;|$)/iu.test(response.headers.get("content-type") ?? "") || !response.body) {
    await response.body?.cancel();
    throw new Unavailable();
  }
  // The stream ends with the usage, then [DONE]; a stream cut before is not
  // the Chest's.
  let usage = false, done = false;
  try {
    for await (const line of lines(response.body)) {
      options.signal?.throwIfAborted();
      if (line === "" || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) throw new Unavailable();
      const data = line.slice(line.startsWith("data: ") ? 6 : 5);
      if (data === "[DONE]") {
        done = true;
        break;
      }
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        throw new Unavailable();
      }
      const piece = chunk(value);
      if (piece.usage) usage = true;
      yield piece;
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw error instanceof ChestError ? error : new Unavailable();
  }
  if (!done || !usage) throw new Unavailable();
}

// chat asks a model for the next message of a conversation: the whole answer,
// or with stream: true its pieces as they come (text, tool call pieces, then
// the finish reason and the usage). Breaking out of the loop ends the call;
// what was produced is counted.
export function chat(options: ChatOptions & { stream: true }): AsyncIterable<ChatChunk>;
export function chat(options: ChatOptions & { stream?: false }): Promise<ChatResult>;
export function chat(options: ChatOptions & { stream?: boolean }): Promise<ChatResult> | AsyncIterable<ChatChunk>;
export function chat(options: ChatOptions & { stream?: boolean }): Promise<ChatResult> | AsyncIterable<ChatChunk> {
  return options?.stream === true ? streamed(options) : completed(options);
}

// embed turns 1 to 256 texts into vectors, one per text in the order given.
export async function embed(options: EmbedOptions): Promise<Embeddings> {
  const o = options as Partial<EmbedOptions> | null;
  if (!o) throw invalid("embed takes options");
  checkModel(o.model);
  const inputs = typeof o.input === "string" ? [o.input] : o.input;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > maxInputs || !inputs.every(i => typeof i === "string")) throw invalid("input is 1 to 256 texts");
  if (o.dimensions !== undefined && (!Number.isSafeInteger(o.dimensions) || o.dimensions < 1)) throw invalid("dimensions is a positive integer");
  const body = { model: o.model, input: o.input, ...(o.dimensions !== undefined ? { dimensions: o.dimensions } : {}), ...(o.member !== undefined ? { member: checkMember(o.member) } : {}) };
  const response = await send("/ai/embeddings", body);
  if (response.status !== 200) throw await refused(response);
  const a = record(await answer(response)), data = a?.["data"], u = record(a?.["usage"]);
  if (!a || a["object"] !== "list" || typeof a["model"] !== "string" || !Array.isArray(data) || data.length !== inputs.length || !u || !tokens(u["prompt_tokens"]) || !tokens(u["total_tokens"]) || !amount(u["cost"])) throw new Unavailable();
  const embeddings: number[][] = [];
  for (const value of data) {
    const e = record(value), index = e?.["index"], vector = e?.["embedding"];
    if (!e || e["object"] !== "embedding" || !tokens(index) || index >= inputs.length || embeddings[index] !== undefined || !Array.isArray(vector) || vector.length < 1 || !vector.every(x => typeof x === "number" && Number.isFinite(x))) throw new Unavailable();
    embeddings[index] = [...vector] as number[];
  }
  if (!embeddings.every(v => v.length === embeddings[0]!.length)) throw new Unavailable();
  return { embeddings, model: a["model"], usage: { input: u["prompt_tokens"], cost: u["cost"] } };
}

// models are the aliases the tool declared that the owner mapped, in alias
// order: each one's model, provider and prices.
export async function models(): Promise<AiModel[]> {
  const response = await ask("ai", "GET", "/ai/models");
  if (response.status !== 200) throw await refused(response);
  const list = record(await json(response))?.["models"];
  if (!Array.isArray(list) || list.length > aliases.length) throw new Unavailable();
  const seen: string[] = [];
  return list.map((value: unknown): AiModel => {
    const m = record(value), alias = m?.["alias"], model = m?.["model"], provider = m?.["provider"], input = m?.["input"], output = m?.["output"];
    if (typeof alias !== "string" || !aliases.includes(alias) || aliases.indexOf(alias) <= aliases.indexOf(seen.at(-1) ?? "") || typeof model !== "string" || model.length < 1 || model.length > 200 || typeof provider !== "string" || !providers.includes(provider) || !amount(input) || !amount(output)) throw new Unavailable();
    seen.push(alias);
    return { alias: alias as Alias, model, provider: provider as Provider, input, output };
  });
}

// usage is this tool's month: what it spent, its cap, when both reset.
export async function usage(): Promise<AiUsage> {
  const response = await ask("ai", "GET", "/ai/usage");
  if (response.status !== 200) throw await refused(response);
  const u = record(await json(response)), month = u?.["month"], spent = u?.["spent"], cap = u?.["cap"], resetsAt = time(u?.["resets"]);
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(month) || !amount(spent) || !tokens(cap) || !resetsAt) throw new Unavailable();
  return { month, spent, cap, resetsAt };
}
