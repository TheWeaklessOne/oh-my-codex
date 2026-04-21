export function generateOmxSessionId(
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  return `omx-${now()}-${random().toString(36).slice(2, 8)}`;
}

export function resolveOmxSessionId(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  const provided = typeof env.OMX_SESSION_ID === 'string'
    ? env.OMX_SESSION_ID.trim()
    : '';

  if (/^omx-[A-Za-z0-9-]+$/.test(provided)) {
    return provided;
  }

  return generateOmxSessionId(now, random);
}
