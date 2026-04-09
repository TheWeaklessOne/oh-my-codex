import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  approveOmxDaemonItem,
  getOmxDaemonStatus,
  resolveGitHubToken,
  runOmxDaemonOnce,
  scaffoldOmxDaemonFiles,
} from "../index.js";

const originalFetch = globalThis.fetch;
const originalGhToken = process.env.GH_TOKEN;
const originalGithubToken = process.env.GITHUB_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (typeof originalGhToken === "string") process.env.GH_TOKEN = originalGhToken; else delete process.env.GH_TOKEN;
  if (typeof originalGithubToken === "string") process.env.GITHUB_TOKEN = originalGithubToken; else delete process.env.GITHUB_TOKEN;
});

describe("omx daemon runtime", () => {
  it("scaffolds tracked governance inputs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-daemon-scaffold-"));
    try {
      const changed = await scaffoldOmxDaemonFiles(cwd);
      assert.ok(changed.includes(".omx/daemon/ISSUE_GATE.md"));
      assert.ok(changed.includes(".omx/daemon/daemon.config.json"));
      assert.equal(existsSync(join(cwd, ".omx", "daemon", "RULES.md")), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves GitHub credentials in the documented order", () => {
    const result = resolveGitHubToken(
      { githubCredentialSource: "config-token-ref", githubTokenEnvVar: "CUSTOM_DAEMON_TOKEN" },
      { CUSTOM_DAEMON_TOKEN: "config-token", GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" },
      (() => ({ status: 1, stdout: "", stderr: "" })) as never,
    );
    assert.equal(result.token, "config-token");
    assert.equal(result.source, "config-token-ref");
  });

  it("queues proposals from GitHub issues and publishes approved wiki docs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-daemon-runonce-"));
    try {
      await scaffoldOmxDaemonFiles(cwd);
      await writeFile(
        join(cwd, ".omx", "daemon", "daemon.config.json"),
        JSON.stringify({
          repository: "octo/example",
          githubCredentialSource: "env",
          githubTokenEnvVar: "GH_TOKEN",
          pollIntervalMs: 10000,
          maxIssuesPerRun: 5,
          knowledgeSink: "docs/project-wiki",
        }, null, 2),
      );
      process.env.GH_TOKEN = "token-from-env";
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/issues?")) {
          return new Response(JSON.stringify([
            {
              number: 42,
              title: "Security regression in daemon flow",
              html_url: "https://github.com/octo/example/issues/42",
              body: "Regression needs urgent follow-up.",
              updated_at: "2026-04-09T12:00:00Z",
              labels: [{ name: "bug" }],
              comments: 6,
            },
          ]), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("/issues/42") && init?.method === "PATCH") {
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      const runResult = await runOmxDaemonOnce(cwd);
      assert.equal(runResult.success, true);
      assert.equal(runResult.queue?.length, 1);
      const item = runResult.queue?.[0];
      assert.ok(item);
      assert.equal(existsSync(join(cwd, ".omx", "state", "daemon", "outbox", `issue-${item?.id}.md`)), true);

      const approveResult = await approveOmxDaemonItem(cwd, item!.id);
      assert.equal(approveResult.success, true);
      assert.equal(existsSync(join(cwd, "docs", "project-wiki", "issue-42.md")), true);
      const published = await readFile(join(cwd, "docs", "project-wiki", "issue-42.md"), "utf-8");
      assert.match(published, /Approved at:/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports actionable status before setup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-daemon-status-"));
    try {
      const status = getOmxDaemonStatus(cwd);
      assert.equal(status.success, true);
      assert.match(status.message, /not initialized/i);
      assert.equal(status.state?.statusReason, "not-initialized");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
