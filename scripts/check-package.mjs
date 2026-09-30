// Check the package as a consumer receives it: npm pack, install the tarball
// into a throwaway project, then import every subpath from Node, through a
// bundler (esbuild, as Next.js and others consume it) and type-check a
// TypeScript consumer under moduleResolution bundler and nodenext.
//
//   npm run check:package        (node scripts/check-package.mjs)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = manifest.name;

// What each subpath gives at run time (tool contract v2); the root gives them
// all, files, members, notifications, events, schedules and ai as namespaces, never
// testing.
const expected = {
  errors: ["AiCapReached", "AiModelNotAllowed", "AiRefused", "AiUnavailable", "CapabilityNotGranted", "ChestError", "QuotaExceeded", "RateLimited", "TooLarge", "Unavailable"],
  member: ["groupIdPattern", "languagePattern", "member", "memberIdPattern", "timeZonePattern"],
  chest: ["chest"],
  database: ["databaseUrl"],
  files: ["delete", "get", "list", "move", "put", "stat", "uploadUrl", "url"],
  members: ["forget", "get", "groups", "list", "lookup"],
  notifications: ["badge", "notify", "withdraw"],
  events: ["acknowledgeErasure", "erasureIdPattern", "handle", "memorySeen", "verify"],
  schedules: ["handle", "verify"],
  ai: ["chat", "embed", "models", "usage"],
  testing: ["fakeChest", "signAssertion", "withMember"],
};
const namespaces = ["files", "members", "notifications", "events", "schedules", "ai"];
const rootExports = [...Object.entries(expected).filter(([sub]) => !namespaces.includes(sub) && sub !== "testing").flatMap(([, names]) => names), ...namespaces].sort();

const subpaths = Object.keys(manifest.exports).filter(key => key !== "./package.json");
assert.deepEqual(subpaths.sort(), [".", ...Object.keys(expected).map(sub => "./" + sub)].sort(), "the exports map and this check name the same subpaths");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Run from prepublishOnly, npm passes its own flags down: a dry run would
// keep npm pack from writing the tarball this check installs.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_dry_run"));
function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}
function step(title) {
  console.log(`\n== ${title}`);
}

const work = mkdtempSync(join(tmpdir(), "chest-sdk-check-"));
try {
  step("npm pack");
  const [packed] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], root).replace(/^[^[]*/su, ""));
  const tarball = join(work, packed.filename);
  const shipped = packed.files.map(file => file.path).sort();
  console.log(`${packed.filename}: ${shipped.length} files, ${packed.size} bytes`);
  for (const path of shipped) console.log("  " + path);
  for (const path of shipped) {
    assert.ok(/^(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts)(\.map)?|client\/index\.ts|client\/src\/[a-z]+\.ts)$/u.test(path), `unexpected file in the package: ${path}`);
  }
  for (const target of Object.values(manifest.exports).flatMap(entry => typeof entry === "string" ? [entry] : Object.values(entry))) {
    assert.ok(shipped.includes(target.slice(2)), `export target missing from the package: ${target}`);
  }

  // The runtime client stays small: the checker is its own package.
  assert.ok(packed.size < 200 * 1024, `${name} packs ${packed.size} bytes: the runtime client must stay small`);
  step("npm pack @argentic/chest-check");
  const [checkPacked] = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", work], join(root, "check")).replace(/^[^[]*/su, ""));
  console.log(`${checkPacked.filename}: ${checkPacked.files.length} files, ${checkPacked.size} bytes (unpacked ${checkPacked.unpackedSize})`);
  assert.deepEqual(checkPacked.files.map(file => file.path).sort(), ["README.md", "check.wasm.gz", "check.wasm.sha256", "dist/cli.js", "package.json"]);
  assert.equal(checkPacked.version, manifest.version, "the checker is released with the SDK");

  step("install the tarball into a throwaway project");
  const consumer = join(work, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }) + "\n");
  run(npm, ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", tarball, join(work, checkPacked.filename)], consumer);
  console.log(`installed ${name} in ${consumer}`);

  // The same probe runs from Node and from the bundle: every subpath, its
  // names, a class shared between subpaths and the root, and two calls that
  // need no Chest.
  const specifiers = subpaths.map(sub => sub === "." ? name : name + sub.slice(1));
  const probe = [
    ...specifiers.map((specifier, i) => `import * as m${i} from ${JSON.stringify(specifier)};`),
    `const modules = { ${specifiers.map((specifier, i) => `${JSON.stringify(specifier)}: m${i}`).join(", ")} };`,
    `const names = {};`,
    `for (const [specifier, module] of Object.entries(modules)) names[specifier] = Object.keys(module).sort();`,
    `const root = modules[${JSON.stringify(name)}];`,
    `const errors = modules[${JSON.stringify(name + "/errors")}];`,
    `const database = modules[${JSON.stringify(name + "/database")}];`,
    `delete process.env.DATABASE_URL; delete process.env.CHEST_TOKEN;`,
    `let refused = false;`,
    `try { database.databaseUrl(); } catch (error) { refused = error instanceof errors.CapabilityNotGranted && error instanceof root.ChestError; }`,
    `const nobody = modules[${JSON.stringify(name + "/member")}].member(new Request("http://tool.test/chest", { headers: { "chest-member": "a.b.c" } }));`,
    `const testing = modules[${JSON.stringify(name + "/testing")}];`,
    `const chest = await testing.fakeChest({ members: [{ id: "mbr_" + "a".repeat(26), firstName: "Ada", lastName: "L", name: "Ada L", photo: null, role: null, isAdmin: false, isBuilder: false, groups: [], language: "en", timeZone: "Europe/Paris" }] });`,
    `const listed = (await root.members.list()).members.map(m => m.name);`,
    `const delivered = (await root.notifications.notify([chest.members[0].id], { title: "Hello" })).delivered;`,
    `const kept = chest.notifications.map(n => n.title);`,
    `const signed = modules[${JSON.stringify(name + "/member")}].member(testing.withMember(new Request("http://tool.test/chest"), chest.members[0]))?.id;`,
    `const told = [];`,
    `const said = (await root.ai.chat({ model: "default", messages: [{ role: "user", content: "Hi" }] })).text;`,
    `let streamed = "";`,
    `for await (const piece of modules[${JSON.stringify(name + "/ai")}].chat({ model: "fast", messages: [{ role: "user", content: "Hi there" }], stream: true })) streamed += piece.text;`,
    `const calls = chest.ai.map(c => c.path);`,
    `const answered = await chest.emit({ type: "access.revoked", data: { id: chest.members[0].id } }, request => root.events.handle(request, { "access.revoked": e => { told.push(e.data.id); } }).then(status => new Response(null, { status })));`,
    `await chest.close();`,
    `console.log(JSON.stringify({ names, sameClass: root.ChestError === errors.ChestError, sameFiles: root.files.put === modules[${JSON.stringify(name + "/files")}].put, sameMembers: root.members.list === modules[${JSON.stringify(name + "/members")}].list, sameAi: root.ai.chat === modules[${JSON.stringify(name + "/ai")}].chat, refused, nobody, listed, delivered, kept, signed, said, streamed, calls, answered, told }));`,
  ].join("\n") + "\n";
  function verify(output, how) {
    const result = JSON.parse(output);
    for (const [sub, names] of Object.entries(expected)) assert.deepEqual(result.names[`${name}/${sub}`], names, `${how}: ${name}/${sub}`);
    assert.deepEqual(result.names[name], rootExports, `${how}: ${name}`);
    assert.equal(result.sameClass, true, `${how}: one ChestError for the root and /errors`);
    assert.equal(result.sameFiles, true, `${how}: one files module for the root and /files`);
    assert.equal(result.refused, true, `${how}: databaseUrl() without DATABASE_URL throws CapabilityNotGranted`);
    assert.equal(result.nobody, null, `${how}: member() without CHEST_TOKEN is null`);
    assert.equal(result.sameMembers, true, `${how}: one members module for the root and /members`);
    assert.deepEqual(result.listed, ["Ada L"], `${how}: members listed from a fake Chest`);
    assert.deepEqual([result.delivered, result.kept], [["mbr_" + "a".repeat(26)], ["Hello"]], `${how}: a notification delivered by a fake Chest`);
    assert.equal(result.sameAi, true, `${how}: one ai module for the root and /ai`);
    assert.deepEqual([result.said, result.streamed, result.calls], ["Hi", "Hi there", ["/ai/chat", "/ai/chat"]], `${how}: a chat answered by a fake Chest, whole and streamed`);
    assert.equal(result.signed, "mbr_" + "a".repeat(26), `${how}: an assertion of the testing module reads as its member`);
    assert.deepEqual([result.answered, result.told], [204, ["mbr_" + "a".repeat(26)]], `${how}: an event emitted by a fake Chest handled once`);
    for (const specifier of specifiers) console.log(`  ${specifier}: ${result.names[specifier].join(", ")}`);
  }

  step("run chest check, @argentic/chest-check's command, on a tool's repository");
  const tool = join(work, "tool");
  mkdirSync(tool);
  writeFileSync(join(tool, "chest.json"), JSON.stringify({ chest: manifest.version.split(".").slice(0, 2).join("."), name: "tasks", build: { runtime: "node", install: "npm ci", start: "npm start", port: 3000 } }));
  writeFileSync(join(tool, "package.json"), "{}");
  writeFileSync(join(tool, "package-lock.json"), "{}");
  run("git", ["init", "-q"], tool);
  const bin = join(consumer, "node_modules", ".bin", "chest");
  const verdict = JSON.parse(run(bin, ["check", tool, "--json"], consumer));
  assert.deepEqual([verdict.ok, verdict.name, verdict.checker], [true, "tasks", manifest.version.split(".").slice(0, 2).join(".")], "chest check, installed, judges a repository");
  assert.equal(run(bin, ["--version"], consumer).trim(), manifest.version);
  console.log(`  chest check: ${verdict.name} would be taken (contract ${verdict.checker})`);

  step("import every subpath from Node");
  writeFileSync(join(consumer, "probe.mjs"), probe);
  verify(run(process.execPath, ["probe.mjs"], consumer), "Node");

  step("bundle every subpath with esbuild");
  const esbuild = await import(pathToFileURL(join(root, "node_modules", "esbuild", "lib", "main.js")).href);
  const bundled = await esbuild.build({
    absWorkingDir: consumer,
    entryPoints: ["probe.mjs"],
    outfile: "bundle.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    metafile: true,
    logLevel: "warning",
  });
  const inputs = Object.keys(bundled.metafile.inputs).filter(input => input.includes(name));
  assert.ok(inputs.length > 0 && inputs.every(input => /\/dist\/.+\.js$/u.test(input)), `the bundle resolves compiled JavaScript only: ${inputs.join(", ")}`);
  console.log(`resolved ${inputs.length} modules: ${inputs.map(input => input.slice(input.indexOf(name) + name.length + 1)).join(", ")}`);
  verify(run(process.execPath, ["bundle.mjs"], consumer), "esbuild bundle");

  step("type-check a TypeScript consumer");
  writeFileSync(join(consumer, "consumer.ts"), `import type { IncomingMessage } from "node:http";
import * as sdk from "${name}";
import { AiCapReached, AiModelNotAllowed, AiRefused, AiUnavailable, CapabilityNotGranted, ChestError, QuotaExceeded, RateLimited, TooLarge, Unavailable, type AiUnavailableReason } from "${name}/errors";
import { member, type Member } from "${name}/member";
import { databaseUrl } from "${name}/database";
import * as files from "${name}/files";
import type { FileData, FileObject, FilePage } from "${name}/files";
import { chest as theChest, type Chest } from "${name}/chest";
import * as members from "${name}/members";
import { groups, type Group, type Lookup, type MemberPage } from "${name}/members";
import * as notifications from "${name}/notifications";
import type { BadgeCount, BadgeWrite, Delivery, Notice } from "${name}/notifications";
import * as events from "${name}/events";
import type { ChestEvent, Handlers, MemberErased, Seen } from "${name}/events";
import * as ai from "${name}/ai";
import type { AiModel, AiUsage, ChatChunk, ChatMessage, ChatResult, ChatTool, Embeddings } from "${name}/ai";
import { fakeChest, signAssertion, withMember, type FakeAi, type FakeAiCall, type FakeChest, type FakeEvent, type FakeNotification } from "${name}/testing";

export function who(request: Request | IncomingMessage): Member | null { return member(request); }
export function where(): [Chest, string, string, string | null] { return [theChest, theChest.currency, new URL("/chest", theChest.tool.teamUrl).href, theChest.tool.publicUrl]; }
export const url: string = databaseUrl();
export async function keep(): Promise<[FileObject, FileData | null, FilePage, boolean, { url: string; expiresIn: number }]> {
  return [await files.put("a.txt", "a", "text/plain"), await files.get("a.txt"), await files.list({ prefix: "a" }), await files.delete("a.txt"), await sdk.files.url("a.txt")];
}
export async function team(): Promise<[MemberPage, Member | null, Lookup, Group[]]> {
  return [await members.list({ q: "a", limit: 10 }), await members.get("mbr_x"), await sdk.members.lookup(["mbr_x"]), await groups.list()];
}
export async function tell(ids: string[], notice: Notice, counts: BadgeCount[]): Promise<[Delivery, void, boolean, BadgeWrite]> {
  return [await notifications.notify(ids, notice), await sdk.notifications.withdraw("task:1", ids), await notifications.badge.set("mbr_x", 1), await notifications.badge.setMany(counts)];
}
export async function receive(request: Request, seen: Seen): Promise<[number, ChestEvent | null]> {
  const handlers: Handlers = { "member.erased": async (e: MemberErased) => { await events.acknowledgeErasure(e.data.erasure); }, "member.updated": e => { void e.data.changed; } };
  return [await events.handle(request, handlers, { seen }), await sdk.events.verify(request)];
}
export async function think(messages: ChatMessage[], tools: ChatTool[], signal: AbortSignal): Promise<[ChatResult, string, Embeddings, AiModel[], AiUsage]> {
  const result: ChatResult = await ai.chat({ model: "default", messages, tools, toolChoice: "auto", responseFormat: { type: "json_object" }, maxTokens: 800, signal });
  let text = "";
  for await (const piece of sdk.ai.chat({ model: "fast", messages, stream: true })) text += (piece satisfies ChatChunk).text + (piece.usage?.cost ?? 0);
  return [result, text, await ai.embed({ model: "embedding", input: ["a", "b"] }), await ai.models(), await ai.usage()];
}
export function paused(error: unknown): string | null {
  if (error instanceof AiCapReached) return error.scope + " until " + error.resetsAt.toISOString();
  if (error instanceof AiUnavailable) return error.reason satisfies AiUnavailableReason;
  return error instanceof AiModelNotAllowed || error instanceof AiRefused ? error.code : null;
}
export async function testAi(): Promise<FakeAiCall[]> {
  const options: FakeAi = { models: [{ alias: "default", model: "m" }], reply: request => ({ text: String(request["model"]), toolCalls: [{ name: "a", arguments: "{}" }] }), cap: 1, unavailable: "no_connector" };
  const chest = await fakeChest({ ai: options });
  await chest.close();
  return chest.ai;
}
export async function test(someone: Member): Promise<string> {
  const chest: FakeChest = await fakeChest({ members: [someone], capabilities: ["members", "notifications"] });
  const sent: FakeNotification[] = chest.notifications;
  const badges: Map<string, number> = chest.badges;
  const request: Request = withMember(new Request("http://tool.test/chest"), someone);
  const event: FakeEvent = { type: "member.erased", data: { id: someone.id, erasure: "era_" + "a".repeat(26), deadline: new Date().toISOString() } };
  await chest.emit(event, "http://127.0.0.1:1");
  const acknowledged: string[] = chest.acknowledged;
  await chest.close();
  return signAssertion(someone, { token: chest.token, tool: chest.tool }) + request.url + sent.length + badges.size + acknowledged.length;
}
export function code(error: unknown): string | null {
  if (error instanceof CapabilityNotGranted || error instanceof QuotaExceeded || error instanceof RateLimited || error instanceof TooLarge || error instanceof Unavailable) return error.code;
  return error instanceof ChestError && error === (error satisfies sdk.ChestError) ? error.code : null;
}
`);
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  for (const [resolution, module] of [["bundler", "esnext"], ["nodenext", "nodenext"]]) {
    const config = `tsconfig.${resolution}.json`;
    writeFileSync(join(consumer, config), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module,
        moduleResolution: resolution,
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [join(root, "node_modules", "@types")],
      },
      files: ["consumer.ts"],
    }, null, 2) + "\n");
    run(process.execPath, [tsc, "-p", config], consumer);
    console.log(`  moduleResolution ${resolution}: no error`);
  }

  console.log(`\n${name}@${manifest.version}: package check passed`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
