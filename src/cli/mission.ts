import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MISSION_HELP = `omx mission - Launch Codex with mission supervisor mode active

Usage:
  omx mission [mission goal text...]
  omx mission --help

Behavior:
  - starts the Mission workflow as a first-class OMX surface
  - activates the shipped mission skill / kernel workflow in-session
  - keeps mission artifacts under .omx/missions/<slug>/
  - uses team as the default coordinated executor
  - uses Ralph only as a bounded fallback for later stubborn follow-up slices

Examples:
  omx mission "Audit the auth flow until a fresh re-audit reports PASS"
  omx mission "Close onboarding reliability gaps without adding new CLI surface area"
`;

const MISSION_APPEND_ENV = 'OMX_MISSION_APPEND_INSTRUCTIONS_FILE';
const VALUE_TAKING_FLAGS = new Set(['--model', '--provider', '--config', '-c', '-i', '--images-dir']);

export interface MissionCliParseResult {
  task: string;
  launchArgs: string[];
}

export function parseMissionCliArgs(args: readonly string[]): MissionCliParseResult {
  const words: string[] = [];
  const launchArgs: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === '--') {
      for (let j = i + 1; j < args.length; j += 1) words.push(args[j]!);
      break;
    }
    if (token.startsWith('--') && token.includes('=')) {
      launchArgs.push(token);
      i += 1;
      continue;
    }
    if (token.startsWith('-') && VALUE_TAKING_FLAGS.has(token)) {
      launchArgs.push(token);
      if (i + 1 < args.length) {
        launchArgs.push(args[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (token.startsWith('-')) {
      launchArgs.push(token);
      i += 1;
      continue;
    }
    words.push(token);
    i += 1;
  }
  return {
    task: words.join(' ').trim() || 'mission-cli-launch',
    launchArgs,
  };
}

function buildMissionAppendInstructions(task: string): string {
  return [
    '<mission_cli_mode>',
    'You are in OMX Mission mode.',
    `Primary mission: ${task}`,
    'Use the shipped `mission` skill as the operator-facing mission entrypoint.',
    'Treat the mission kernel/runtime (`src/mission/kernel.ts`, `src/mission/runtime.ts`) as the authoritative state machine.',
    'Persist authoritative mission artifacts under `.omx/missions/<slug>/`.',
    'Execution policy: team is the default coordinated executor; Ralph is a bounded fallback only when a later stubborn narrow follow-up remains.',
    'If the user did not provide a concrete mission goal yet, clarify it before doing mission work.',
    '</mission_cli_mode>',
  ].join('\n');
}

async function writeMissionAppendixFile(cwd: string, task: string): Promise<string> {
  const dir = join(cwd, '.omx', 'mission');
  await mkdir(dir, { recursive: true });
  const appendixPath = join(dir, 'session-instructions.md');
  await writeFile(appendixPath, `${buildMissionAppendInstructions(task)}\n`, 'utf-8');
  return appendixPath;
}

interface MissionCommandDependencies {
  launchWithHud?: (args: string[]) => Promise<void>;
  writeAppendixFile?: (cwd: string, task: string) => Promise<string>;
}

export async function missionCommand(
  args: string[],
  dependencies: MissionCommandDependencies = {},
): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    console.log(MISSION_HELP);
    return;
  }

  const cwd = process.cwd();
  const parsed = parseMissionCliArgs(args);
  const task = parsed.task;

  const previousAppendix = process.env[MISSION_APPEND_ENV];
  const appendixPath = await (dependencies.writeAppendixFile ?? writeMissionAppendixFile)(cwd, task);
  process.env[MISSION_APPEND_ENV] = appendixPath;

  try {
    const launchWithHud = dependencies.launchWithHud
      ?? (await import('./index.js')).launchWithHud;
    const missionPrompt = task === 'mission-cli-launch' ? '$mission' : `$mission ${task}`;
    await launchWithHud([...parsed.launchArgs, missionPrompt]);
  } finally {
    if (typeof previousAppendix === 'string') process.env[MISSION_APPEND_ENV] = previousAppendix;
    else delete process.env[MISSION_APPEND_ENV];
  }
}
