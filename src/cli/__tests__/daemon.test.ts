import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { daemonCommand } from "../daemon.js";

describe("omx daemon CLI", () => {
  it("prints command-local help", async () => {
    const lines: string[] = [];
    await daemonCommand(["--help"], {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    assert.match(lines.join("\n"), /omx daemon start/);
    assert.match(lines.join("\n"), /omx daemon approve <item-id>/);
  });

  it("scaffolds daemon governance files from the CLI", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-daemon-cli-"));
    const previous = process.cwd();
    const lines: string[] = [];
    process.chdir(cwd);
    try {
      await daemonCommand(["scaffold"], {
        stdout: (line) => lines.push(line),
        stderr: (line) => lines.push(line),
      });
      assert.match(lines.join("\n"), /Scaffolded daemon governance files/);
    } finally {
      process.chdir(previous);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
