#!/usr/bin/env node
// `chest`, the command of @argentic/chest-check (npx chest …, once it is a
// devDependency of the tool):
//
//   chest check [directory] [--json]   will the Chest take this repository?
//   chest --version
//
// check judges the tool's repository with the Chest's own code: the
// validator the Chest runs on every source it builds, compiled to
// WebAssembly (check.wasm.gz, written by the Chest's repository)
// and run here by Node's WASI, with no access to anything but the archive it
// is given. The archive is what the Chest would receive: the tree as `git
// archive` makes it — the files Git tracks or would add, ignored ones left
// out — of the working tree as it is now, committed or not (a temporary
// index; the repository's own index, branches and history are not touched,
// but its object store keeps the blobs). The verdict is the Chest's: the
// reason it refuses in one word (manifest, migrations, no_lock, newer_chest…)
// and the rule broken, or what the tool asks. Exit status 0 when the Chest
// would take it, 1 when it would refuse it, 2 when it could not be checked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// What chest-check says of a source (cmd/chest-check of the Chest).
export type Verdict = { checker: string; ok: boolean; reason?: string; detail?: string; contract?: string; name?: string; roles?: string[]; permissions?: string[]; migrations?: number };

// The package's root: the directory above this module that holds
// check.wasm.gz — above dist/ once packed, above build/src/ in its tests.
function packageRoot(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, "check.wasm.gz"))) return dir;
  }
  throw new Error("check.wasm.gz not found: reinstall @argentic/chest-check");
}
// The bound of a source archive (the Chest's MaxArchiveBytes).
const maxArchive = 32 << 20;

function git(dir: string, args: string[], env: Record<string, string> = {}): Buffer {
  return execFileSync("git", ["-C", dir, ...args], { env: { ...process.env, ...env }, maxBuffer: maxArchive + 1, stdio: ["ignore", "pipe", "pipe"] });
}

// archive is the gzip tarball of the repository at dir as the Chest would
// receive it, working tree included.
export function archive(dir: string): Buffer {
  const root = git(dir, ["rev-parse", "--show-toplevel"]).toString().trim();
  const work = mkdtempSync(join(tmpdir(), "chest-check-"));
  try {
    const index = { GIT_INDEX_FILE: join(work, "index") };
    git(root, ["add", "--all", "--", "."], index);
    const tree = git(root, ["write-tree"], index).toString().trim();
    return git(root, ["archive", "--format=tar.gz", tree]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// checker is chest-check, checked against the digest the Chest wrote.
function checker(): Promise<WebAssembly.Module> {
  const root = packageRoot();
  const wasm = gunzipSync(readFileSync(join(root, "check.wasm.gz")));
  if (createHash("sha256").update(wasm).digest("hex") !== readFileSync(join(root, "check.wasm.sha256"), "utf8").trim()) throw new Error("check.wasm.gz does not match its digest: reinstall @argentic/chest-check");
  return WebAssembly.compile(wasm);
}

// run gives chest-check the arguments and the input, and says its exit
// status and what it wrote. Its only files are those two.
export async function run(args: string[], input: Buffer): Promise<{ status: number; output: string }> {
  const module = await checker();
  const work = mkdtempSync(join(tmpdir(), "chest-check-"));
  const [inputFile, outputFile] = [join(work, "in"), join(work, "out")];
  writeFileSync(inputFile, input, { mode: 0o600 });
  const stdin = openSync(inputFile, "r"), stdout = openSync(outputFile, "w", 0o600);
  // WASI is still marked experimental by Node: its warning says nothing to a
  // tool's author.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (!String(warning).includes("WASI")) (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { WASI } = await import("node:wasi");
    const wasi = new WASI({ version: "preview1", args: ["chest-check", ...args], env: {}, stdin, stdout, stderr: stdout, returnOnExit: true });
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject() as WebAssembly.Imports);
    const status = wasi.start(instance);
    return { status, output: readFileSync(outputFile, "utf8") };
  } finally {
    process.emitWarning = emit;
    closeSync(stdin);
    closeSync(stdout);
    rmSync(work, { recursive: true, force: true });
  }
}

// check is the verdict of the Chest on the repository at dir.
export async function check(dir: string): Promise<Verdict> {
  const { output } = await run([], archive(dir));
  return JSON.parse(output) as Verdict;
}

function words(v: Verdict): string {
  if (!v.ok) return `Refused: ${v.reason}\n  ${v.detail ?? ""}\n`;
  const lines = [`OK: the Chest (tool contract ${v.checker}) would take ${v.name}, written for contract ${v.contract}.`];
  if (v.roles?.length) lines.push(`  Roles: ${v.roles.join(", ")}`);
  lines.push(`  It asks: ${v.permissions?.length ? v.permissions.join(", ") : "nothing beyond its own address"}`);
  if (v.migrations) lines.push(`  Migrations: ${v.migrations}`);
  return lines.join("\n") + "\n";
}

// main runs a command line and says its exit status.
export async function main(argv: string[], out: (text: string) => void): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version") {
    out((JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string }).version + "\n");
    return 0;
  }
  const json = rest.includes("--json"), dirs = rest.filter(a => a !== "--json");
  if (command !== "check" || dirs.length > 1 || dirs.some(d => d.startsWith("-"))) {
    out("usage: chest check [directory] [--json]\n       chest --version\n");
    return 2;
  }
  let verdict: Verdict;
  try {
    verdict = await check(resolve(dirs[0] ?? "."));
  } catch (error) {
    const reason = error instanceof Error && /not a git repository/iu.test(String((error as { stderr?: unknown }).stderr ?? error.message)) ? "chest check reads a Git repository: run it in one (git init)" : error instanceof Error ? error.message : "the check did not run";
    out((json ? JSON.stringify({ ok: false, error: reason }) : `Not checked: ${reason}`) + "\n");
    return 2;
  }
  out(json ? JSON.stringify(verdict, null, 2) + "\n" : words(verdict));
  return verdict.ok ? 0 : 1;
}

// Run as the command (node_modules/.bin/chest links here), not imported.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2), text => process.stdout.write(text));
}
