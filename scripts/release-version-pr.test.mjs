import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const start = workflow.indexOf("          pr_number=$(gh pr list");
const endCommand = "          gh workflow run ci.yml --ref changeset-release/main";
const end = workflow.indexOf(endCommand, start);
if (start < 0 || end < 0) throw new Error("version PR workflow shell not found");
const script = "set -euo pipefail\n" + workflow.slice(start, end + endCommand.length)
  .split("\n").map((line) => line.slice(10)).join("\n");

function run(mode) {
  const directory = mkdtempSync(join(tmpdir(), "dalgo-version-pr-"));
  const output = join(directory, "output");
  const summary = join(directory, "summary");
  const calls = join(directory, "calls");
  for (const file of [output, summary, calls]) writeFileSync(file, "");
  writeFileSync(join(directory, "gh"), `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1 $2" == 'pr list' ]]; then
  if [[ "$MODE" == existing ]] || [[ -f "$CREATED" && "$MODE" != policy && "$MODE" != missing ]]; then echo 16; fi
elif [[ "$1 $2" == 'pr create' ]]; then
  touch "$CREATED"
  if [[ "$MODE" == policy || "$MODE" == race ]]; then
    echo 'pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)' >&2
    exit 1
  elif [[ "$MODE" == denied ]]; then
    echo 'GraphQL: Resource not accessible by integration' >&2
    exit 1
  fi
elif [[ "$1 $2" == 'workflow run' ]]; then
  [[ "$MODE" != ci-failure ]] || exit 3
else
  exit 90
fi
`, { mode: 0o700 });
  writeFileSync(join(directory, "git"), `#!/bin/bash
[[ "$*" == 'rev-parse HEAD' ]] || exit 90
echo dbc2b8741b0fb03d35dcf8c5277684e9990a3cba
`, { mode: 0o700 });
  try {
    const result = spawnSync("/bin/bash", ["-c", script], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: `${directory}:/usr/bin:/bin`,
        GH_TOKEN: "",
        MODE: mode,
        CALLS: calls,
        CREATED: join(directory, "created"),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_REPOSITORY: "dal-go/dalgo-js",
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(output, "utf8"),
      summary: readFileSync(summary, "utf8"),
      calls: readFileSync(calls, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("version PR policy handoff", () => {
  it("preserves a policy-blocked branch for manual review and dispatches its CI", () => {
    const result = run("policy");
    expect(result.status).toBe(0);
    expect(result.output).toBe("manual-pr-required=true\n");
    expect(result.stdout).toContain("::warning::Actions PR creation is disabled");
    expect(result.summary).toContain("dbc2b8741b0fb03d35dcf8c5277684e9990a3cba");
    expect(result.summary).toContain("https://github.com/dal-go/dalgo-js/compare/main...changeset-release/main");
    expect(result.summary).toContain("does not authorize npm publication");
    expect(result.calls).toContain("workflow run ci.yml --ref changeset-release/main");
  });

  it.each(["existing", "created", "race"])("adopts the open version PR in the %s path", (mode) => {
    const result = run(mode);
    expect(result.status).toBe(0);
    expect(result.output).toBe("pr-number=16\nmanual-pr-required=false\n");
    expect(result.summary).toBe("");
    expect(result.calls).toContain("workflow run ci.yml --ref changeset-release/main");
    if (mode === "existing") expect(result.calls).not.toContain("pr create");
  });

  it("fails on an unrelated permission error", () => {
    const result = run("denied");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Resource not accessible by integration");
    expect(result.output).toBe("");
    expect(result.calls).not.toContain("workflow run");
  });

  it("fails when a successful creation produces no open PR", () => {
    const result = run("missing");
    expect(result.status).toBe(1);
    expect(result.output).toBe("");
    expect(result.calls).not.toContain("workflow run");
  });

  it("propagates a CI dispatch failure", () => {
    const result = run("ci-failure");
    expect(result.status).toBe(3);
  });
});
