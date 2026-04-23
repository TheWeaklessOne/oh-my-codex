import { appendFileSync } from 'fs';
import { basename } from 'path';

export const WARP_TERM_PROGRAM = 'WarpTerminal';
const DEFAULT_TTY_PATH = '/dev/tty';

export interface EmitWarpOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  ttyPath?: string;
  writeTTY?: (ttyPath: string, data: string) => void;
}

function isWarpTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.TERM_PROGRAM || '').trim() === WARP_TERM_PROGRAM;
}

export function resolveDefaultWarpTTYPath(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? 'CONOUT$' : DEFAULT_TTY_PATH;
}

export function buildOmxWarpTabTitle(cwd: string): string {
  const project = basename(cwd) || 'project';
  return `OmX · ${project}`;
}

function sanitizeOscTitle(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[;]+/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

function writeTTYWithDefault(ttyPath: string, data: string): void {
  appendFileSync(ttyPath, data);
}

function emitWarpTabTitle(
  title: string,
  options: EmitWarpOptions = {},
): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (!isWarpTerminal(env)) return false;
  const writeTTY = options.writeTTY ?? writeTTYWithDefault;
  try {
    writeTTY(
      options.ttyPath ?? resolveDefaultWarpTTYPath(platform),
      `\u001b]0;${sanitizeOscTitle(title)}\u0007`,
    );
    return true;
  } catch {
    return false;
  }
}

export function emitOmxWarpTabTitle(
  cwd: string,
  options: EmitWarpOptions = {},
): boolean {
  return emitWarpTabTitle(buildOmxWarpTabTitle(cwd), options);
}
