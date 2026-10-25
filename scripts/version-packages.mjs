import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const manifestPath = new URL("../package.json", import.meta.url);
const before = JSON.parse(readFileSync(manifestPath, "utf8"));

execFileSync("pnpm", ["exec", "changeset", "version"], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit",
});

const after = JSON.parse(readFileSync(manifestPath, "utf8"));
if (before.name !== "@dalgo/core" || after.name !== before.name) {
  throw new Error("versioning must target @dalgo/core");
}
if (after.version === before.version) {
  throw new Error("changeset version did not change @dalgo/core");
}

const releaseDirectory = new URL("../.changeset/releases/", import.meta.url);
mkdirSync(releaseDirectory, { recursive: true });
writeFileSync(
  new URL(`core@v${after.version}.json`, releaseDirectory),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      package: after.name,
      previousVersion: before.version,
      version: after.version,
      tag: `core@v${after.version}`,
    },
    null,
    2,
  )}\n`,
);
