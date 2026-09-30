// Render the parts of contract/README.md that contract/contract.json says —
// the keys of chest.json, the source, the migrations, the policies — between
// their markers (<!-- contract:<part> --> … <!-- /contract:<part> -->); the
// words around them are written by hand. contract.json, check.wasm.gz and
// check.wasm.sha256 are written by the Chest's repository
// (scripts/build-contract.mjs), from the code that decides: never edit them
// here.
//
//   node scripts/contract.mjs           (npm run contract) render
//   node scripts/contract.mjs --check   fail when the page or the version differ
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const contract = JSON.parse(readFileSync(new URL("contract/contract.json", root), "utf8"));
const page = new URL("contract/README.md", root);
const version = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).version;
const checkVersion = JSON.parse(readFileSync(new URL("check/package.json", root), "utf8")).version;

const size = bytes => bytes % (1 << 30) === 0 ? `${bytes / (1 << 30)} GiB` : bytes % (1 << 20) === 0 ? `${bytes / (1 << 20)} MiB` : bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
const cell = text => text.replaceAll("|", "\\|");
const code = text => "`" + text + "`";

const parts = {
  version: () => `Version **${contract.contract}** — \`"chest": "${contract.contract}"\`, the SDK ${contract.contract}.x.`,
  keys: () => [
    `\`${contract.manifest.file}\`, at the root of the repository, ${size(contract.manifest.maxBytes)} at most. Unknown and duplicate keys are refused.`,
    "",
    "| Key | | Rule | Example |",
    "|---|---|---|---|",
    ...contract.manifest.keys.map(k => `| ${code(k.key)} | ${k.required ? "required" : ""} | ${cell(k.rule)}${k.pattern ? ` Grammar: ${code(cell(k.pattern))}.` : ""} | ${code(cell(JSON.stringify(k.example)))} |`),
  ].join("\n"),
  source: () => [
    `- At the root: ${contract.source.required.map(code).join(", ")}.`,
    `- At most ${size(contract.source.maxArchiveBytes)} compressed, ${size(contract.source.maxExpandedBytes)} and ${contract.source.maxEntries.toLocaleString("en")} files and directories unpacked.`,
    ...contract.source.refused.map(r => `- Refused: ${r}.`),
  ].join("\n"),
  migrations: () => [
    `- Files of ${code(contract.migrations.dir + "/")} named ${code(contract.migrations.pattern)}: ${contract.migrations.max} at most, ${size(contract.migrations.maxBytes)} each, ${size(contract.migrations.maxTotalBytes)} in all.`,
    `- ${contract.migrations.rule}`,
    `- Extensions a migration may create (\`create extension if not exists …\`): ${contract.migrations.trustedExtensions.map(code).join(", ")}.`,
  ].join("\n"),
  policies: () => [
    "| Where | The Chest adds |",
    "|---|---|",
    `| Public host, every answer | ${code(contract.policies.public)} |`,
    `| Public host of a tool with \`"csp": "tool"\`, beside its own policy | ${code(contract.policies.publicOwn)} |`,
    `| Team host (\`/chest\`), to an answer without a policy | ${code(contract.policies.team)} |`,
  ].join("\n"),
};

const before = readFileSync(page, "utf8");
let after = before;
for (const [name, render] of Object.entries(parts)) {
  const pattern = new RegExp(`(<!-- contract:${name} -->\\n)[\\s\\S]*?(<!-- /contract:${name} -->)`, "u");
  if (!pattern.test(after)) throw new Error(`contract/README.md has no ${name} part`);
  after = after.replace(pattern, (_, open, close) => open + render() + "\n" + close);
}
const problems = [];
if (version.split(".").slice(0, 2).join(".") !== contract.contract) problems.push(`package.json ${version} is not of the contract ${contract.contract}: the SDK MAJOR.MINOR is the contract's`);
if (checkVersion !== version) problems.push(`check/package.json ${checkVersion} is not the SDK's ${version}: both are released together`);
if (process.argv.includes("--check")) {
  if (after !== before) problems.push("contract/README.md is not what contract.json says: npm run contract");
} else {
  writeFileSync(page, after);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}
