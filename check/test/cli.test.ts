import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { archive, check, main, run } from "../src/cli.js";

// Repositories as a tool's author has them: a Git repository, files
// committed or not.
const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const manifest = { chest: "0.4", name: "tasks", roles: ["manager", "member"], capabilities: ["database"], build: { runtime: "node", install: "npm ci", start: "npm start", port: 3000 } };
function repository(files: Record<string, string>, commit = true): string {
  const dir = mkdtempSync(join(tmpdir(), "chest-tool-"));
  made.push(dir);
  const all: Record<string, string> = { "chest.json": JSON.stringify(manifest), "package.json": `{"name":"tasks","scripts":{"start":"node server.mjs"}}`, "package-lock.json": `{"lockfileVersion":3}`, "server.mjs": "", ...files };
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { stdio: "ignore" });
  git("init", "-q");
  if (commit) {
    git("add", "-A");
    git("commit", "-qm", "tool");
  }
  return dir;
}

test("the Chest's verdict on a repository it would take: what the tool is and asks", async () => {
  const verdict = await check(repository({ "migrations/0001_tasks.sql": "create table tasks (id serial primary key);" }));
  assert.deepEqual(verdict, { checker: "0.5", ok: true, contract: "0.4", name: "tasks", roles: ["manager", "member"], permissions: ["database"], migrations: 1 });
});

test("the working tree is checked as it is, committed or not, as Git would archive it", async () => {
  const dir = repository({}, false);
  assert.equal((await check(dir)).ok, true);
  // An edit not committed is what is checked.
  writeFileSync(join(dir, "chest.json"), JSON.stringify({ ...manifest, title: "" }));
  const refused = await check(dir);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "manifest");
  assert.match(refused.detail ?? "", /invalid field "title"$/u);
  // node_modules is refused… unless Git ignores it, as it should.
  writeFileSync(join(dir, "chest.json"), JSON.stringify(manifest));
  mkdirSync(join(dir, "node_modules/left-pad"), { recursive: true });
  writeFileSync(join(dir, "node_modules/left-pad/index.js"), "module.exports = 1;");
  assert.equal((await check(dir)).reason, "node_modules");
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  assert.equal((await check(dir)).ok, true);
  // The repository's own index is not touched.
  assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).split("\n").filter(Boolean).every(line => line.startsWith("??")), true);
});

test("each refusal says why in the Chest's word", async () => {
  for (const [files, reason] of [
    [{ "chest.json": JSON.stringify({ ...manifest, chest: "9.0", schedules: [] }) }, "newer_chest"],
    [{ "chest.json": JSON.stringify({ ...manifest, capabilities: undefined }), "migrations/0001_tasks.sql": "select 1;" }, "migrations"],
    [{ "migrations/1_tasks.sql": "select 1;" }, "migrations"],
    [{ "chest.json": JSON.stringify({ ...manifest, version: 2 }) }, "manifest"],
  ] as [Record<string, string>, string][]) {
    const verdict = await check(repository(files));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, reason, JSON.stringify(files));
  }
});

test("the contract it runs is the one this package publishes", async () => {
  const { status, output } = await run(["-contract"], Buffer.alloc(0));
  assert.equal(status, 0);
  assert.equal(output, readFileSync(new URL("../../../contract/contract.json", import.meta.url), "utf8"));
  const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  assert.equal(version.split(".").slice(0, 2).join("."), JSON.parse(output).contract);
});

test("the command: its exit status, its words, and outside a repository", async () => {
  const dir = repository({});
  let printed = "";
  assert.equal(await main(["check", dir], text => { printed += text; }), 0);
  assert.match(printed, /^OK: the Chest \(tool contract 0\.5\) would take tasks/u);
  printed = "";
  assert.equal(await main(["check", dir, "--json"], text => { printed += text; }), 0);
  assert.equal(JSON.parse(printed).ok, true);
  writeFileSync(join(dir, "chest.json"), "{}");
  assert.equal(await main(["check", dir], () => {}), 1);
  const bare = mkdtempSync(join(tmpdir(), "chest-bare-"));
  made.push(bare);
  printed = "";
  assert.equal(await main(["check", bare], text => { printed += text; }), 2);
  assert.match(printed, /Git repository/u);
  assert.equal(await main(["deploy"], () => {}), 2);
  printed = "";
  assert.equal(await main(["--version"], text => { printed += text; }), 0);
  assert.match(printed, /^0\.5\.\d+\n$/u);
  assert.ok(archive(dir).length > 0);
});
