export const OMX_TMUX_OWNED_OPTION = '@omx-owned';
export const OMX_TMUX_SESSION_ID_OPTION = '@omx-session-id';
export const OMX_TMUX_PROJECT_PATH_OPTION = '@omx-project-path';
export const OMX_TMUX_KIND_OPTION = '@omx-session-kind';
export const OMX_TMUX_TEAM_NAME_OPTION = '@omx-team-name';

export interface OmxTmuxSessionMarkerOptions {
  sessionId?: string | null;
  projectPath?: string | null;
  kind?: string | null;
  teamName?: string | null;
}

function pushSetOption(args: string[][], sessionTarget: string, optionName: string, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (!normalized) return;
  args.push(['set-option', '-t', sessionTarget, optionName, normalized]);
}

export function buildSetOmxTmuxSessionMarkerArgs(
  sessionTarget: string,
  options: OmxTmuxSessionMarkerOptions = {},
): string[][] {
  const args: string[][] = [
    ['set-option', '-t', sessionTarget, OMX_TMUX_OWNED_OPTION, '1'],
  ];
  pushSetOption(args, sessionTarget, OMX_TMUX_SESSION_ID_OPTION, options.sessionId);
  pushSetOption(args, sessionTarget, OMX_TMUX_PROJECT_PATH_OPTION, options.projectPath);
  pushSetOption(args, sessionTarget, OMX_TMUX_KIND_OPTION, options.kind);
  pushSetOption(args, sessionTarget, OMX_TMUX_TEAM_NAME_OPTION, options.teamName);
  return args;
}

export function isOmxTmuxOwnedMarker(value: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(value?.trim() ?? '');
}
