import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const provenance = JSON.parse(readFileSync(join(root, ".github/tugql-fixtures.json"), "utf8"));
const localOnly = process.argv.includes("--local-only");
const expectedFormats = new Map(provenance.fixtures.map(({ name, format }) => [name, format]));
const requiredNames = ["suite.json", "resolve.json", "format.json", "execute.json", "budget.json"];

if (provenance.schema !== "dalgo.tugql-fixture-provenance.v1" ||
    provenance.providerDirectory !== "dtql/testdata/tugql/v1" ||
    provenance.consumerDirectory !== "test/testdata/tugql/v1" ||
    requiredNames.some((name) => !expectedFormats.has(name)) || expectedFormats.size !== requiredNames.length) {
  throw new Error("invalid TugQL fixture provenance schema or fixture list");
}

const consumerDir = join(root, provenance.consumerDirectory);
const manifest = readFileSync(join(consumerDir, "manifest.sha256"));
const manifestRows = manifest.toString("utf8").trim().split(/\n/u).map((line) => {
  const match = /^([0-9a-f]{64})  dtql\/testdata\/tugql\/v1\/([a-z]+)\.json$/u.exec(line);
  if (match === null) throw new Error(`invalid manifest row: ${line}`);
  return [ `${match[2]}.json`, match[1] ];
});
if (manifestRows.length !== requiredNames.length || new Set(manifestRows.map(([name]) => name)).size !== requiredNames.length) {
  throw new Error("TugQL manifest must contain each required fixture exactly once");
}
const digests = new Map(manifestRows);
for (const name of requiredNames) {
  const bytes = readFileSync(join(consumerDir, name));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== digests.get(name)) throw new Error(`${name} does not match the vendored manifest digest`);
  const suite = JSON.parse(bytes.toString("utf8"));
  if (suite.format !== expectedFormats.get(name) || suite.version !== 1 || !Array.isArray(suite.cases)) {
    throw new Error(`${name} has an unexpected format, version, or cases field`);
  }
}

if (!localOnly) {
  const commit = provenance.providerCommit;
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("TugQL Go provider commit is not pinned to an immutable 40-character SHA");
  const repository = provenance.providerRepository;
  if (repository !== "https://github.com/dal-go/dalgo.git") throw new Error("unexpected TugQL fixture provider repository");
  const fetch = spawnSync("git", ["fetch", "--no-tags", "--depth=1", repository, commit], { cwd: root, encoding: "utf8" });
  if (fetch.status !== 0) throw new Error(`could not fetch pinned Go fixture provider ${commit}: ${fetch.stderr.trim()}`);
  const fetched = spawnSync("git", ["rev-parse", "FETCH_HEAD"], { cwd: root, encoding: "utf8" });
  if (fetched.status !== 0 || fetched.stdout.trim() !== commit) throw new Error("fetched Go provider revision did not match the pinned commit");
  const providerPrefix = provenance.providerDirectory;
  const providerFiles = [...requiredNames, "manifest.sha256"];
  for (const name of providerFiles) {
    const path = `${providerPrefix}/${name}`;
    const show = spawnSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: null, maxBuffer: 16 * 1024 * 1024 });
    if (show.status !== 0) throw new Error(`pinned Go commit does not contain ${path}`);
    const vendored = readFileSync(join(consumerDir, name));
    if (!show.stdout.equals(vendored)) throw new Error(`${name} differs from pinned Go provider ${commit}`);
  }
}

console.log(localOnly ? "TugQL fixture manifest and schema verified" : `TugQL fixtures match Go provider ${provenance.providerCommit}`);
