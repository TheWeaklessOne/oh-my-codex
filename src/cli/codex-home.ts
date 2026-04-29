import { join } from "path";
import { codexConfigPath, preferLogicalPath } from "../utils/paths.js";
import {
	readPersistedSetupPreferencesSync,
	readPersistedSetupScopeSync,
} from "./setup-preferences.js";

export const readPersistedSetupPreferences = readPersistedSetupPreferencesSync;
export const readPersistedSetupScope = readPersistedSetupScopeSync;

export function resolveProjectLocalCodexHomeForLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return undefined;
	const logicalCwd = preferLogicalPath(cwd);
	const persistedScope = readPersistedSetupScope(logicalCwd);
	if (persistedScope === "project") {
		return join(logicalCwd, ".codex");
	}
	return undefined;
}

export function resolveCodexHomeForLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.CODEX_HOME && env.CODEX_HOME.trim() !== "") return env.CODEX_HOME;
	return resolveProjectLocalCodexHomeForLaunch(cwd, env);
}

export function resolveCodexConfigPathForLaunch(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	const codexHomeOverride = resolveCodexHomeForLaunch(cwd, env);
	return codexHomeOverride
		? join(codexHomeOverride, "config.toml")
		: codexConfigPath();
}
