import {
  approveOmxDaemonItem,
  getOmxDaemonStatus,
  rejectOmxDaemonItem,
  runOmxDaemonOnce,
  scaffoldOmxDaemonFiles,
  startOmxDaemon,
  stopOmxDaemon,
} from "../daemon/index.js";

const DAEMON_HELP = `Usage:
  omx daemon start
  omx daemon stop
  omx daemon status
  omx daemon run-once
  omx daemon approve <item-id>
  omx daemon reject <item-id>

Notes:
  - $setup-omx-daemon is the guided onboarding surface.
  - The CLI owns runtime lifecycle; start/stop/status/run-once manage the current worktree.
  - If the daemon is not initialized yet, use the setup skill or:
      omx daemon scaffold
    to create tracked .omx/daemon inputs.`;

export interface DaemonCommandDependencies {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

function emitResult(
  result: { success: boolean; message: string; error?: string; state?: unknown; queue?: unknown },
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): void {
  if (result.success) {
    stdout(result.message);
  } else {
    stderr(result.error ? `${result.message}\n${result.error}` : result.message);
    process.exitCode = 1;
  }
}

export async function daemonCommand(
  args: string[],
  deps: DaemonCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const subcommand = args[0] ?? "status";

  switch (subcommand) {
    case "help":
    case "--help":
    case "-h":
      stdout(DAEMON_HELP);
      return;
    case "scaffold": {
      const changed = await scaffoldOmxDaemonFiles(process.cwd());
      stdout(
        changed.length > 0
          ? `Scaffolded daemon governance files:\n${changed.map((file) => `- ${file}`).join("\n")}`
          : "Daemon governance files already exist.",
      );
      return;
    }
    case "start":
      emitResult(startOmxDaemon(process.cwd()), stdout, stderr);
      return;
    case "stop":
      emitResult(stopOmxDaemon(process.cwd()), stdout, stderr);
      return;
    case "status":
      emitResult(getOmxDaemonStatus(process.cwd()), stdout, stderr);
      return;
    case "run-once":
      emitResult(await runOmxDaemonOnce(process.cwd()), stdout, stderr);
      return;
    case "approve": {
      const itemId = args[1];
      if (!itemId) {
        throw new Error(`Missing queue item id for approve.\n${DAEMON_HELP}`);
      }
      emitResult(await approveOmxDaemonItem(process.cwd(), itemId), stdout, stderr);
      return;
    }
    case "reject": {
      const itemId = args[1];
      if (!itemId) {
        throw new Error(`Missing queue item id for reject.\n${DAEMON_HELP}`);
      }
      emitResult(rejectOmxDaemonItem(process.cwd(), itemId), stdout, stderr);
      return;
    }
    default:
      throw new Error(`Unknown daemon subcommand: ${subcommand}\n${DAEMON_HELP}`);
  }
}
