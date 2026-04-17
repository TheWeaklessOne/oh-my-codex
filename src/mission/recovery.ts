import { appendMissionReadModelsRecoveredEvent } from "./events.js";
import { loadMission, reconcileMissionLatestSnapshot } from "./kernel.js";
import { reconcileMissionCloseout } from "./orchestration.js";
import { reconcileMissionTelemetry } from "./telemetry.js";
import type { MissionV3RecoveryResult } from "./v3.js";
import { rebuildMissionV3DerivedStateFromDisk } from "./v3.js";
import { reconcileMissionWorkflow } from "./workflow.js";

export interface MissionRecoveryResult {
	workflow: Awaited<ReturnType<typeof reconcileMissionWorkflow>>;
	telemetry: Awaited<ReturnType<typeof reconcileMissionTelemetry>>;
	closeout: Awaited<ReturnType<typeof reconcileMissionCloseout>>;
	latest: Awaited<ReturnType<typeof reconcileMissionLatestSnapshot>>;
	v3: MissionV3RecoveryResult | null;
	driftDetected: boolean;
}

export async function recoverMissionReadModels(
	repoRoot: string,
	slug: string,
): Promise<MissionRecoveryResult> {
	const mission = await loadMission(repoRoot, slug);
	let workflow = await reconcileMissionWorkflow(mission);
	const telemetry = await reconcileMissionTelemetry(mission);
	const closeout = await reconcileMissionCloseout(mission);
	const latest = await reconcileMissionLatestSnapshot(repoRoot, slug);
	const v3 =
		mission.mission_version >= 3
			? await rebuildMissionV3DerivedStateFromDisk(repoRoot, slug)
			: null;
	const driftDetected =
		workflow.driftDetected ||
		telemetry.driftDetected ||
		closeout.driftDetected ||
		latest.driftDetected ||
		(v3?.driftDetected ?? false);
	if (driftDetected) {
		await appendMissionReadModelsRecoveredEvent(mission, {
			workflow: workflow.driftDetected,
			telemetry: telemetry.driftDetected,
			closeout: closeout.driftDetected,
			latest: latest.driftDetected,
		});
		workflow = await reconcileMissionWorkflow(mission);
	}
	return {
		workflow,
		telemetry,
		closeout,
		latest,
		v3,
		driftDetected,
	};
}
