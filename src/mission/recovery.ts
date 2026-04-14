import { appendMissionReadModelsRecoveredEvent } from "./events.js";
import { loadMission, reconcileMissionLatestSnapshot } from "./kernel.js";
import { reconcileMissionCloseout } from "./orchestration.js";
import { reconcileMissionTelemetry } from "./telemetry.js";
import { reconcileMissionWorkflow } from "./workflow.js";

export interface MissionRecoveryResult {
	workflow: Awaited<ReturnType<typeof reconcileMissionWorkflow>>;
	telemetry: Awaited<ReturnType<typeof reconcileMissionTelemetry>>;
	closeout: Awaited<ReturnType<typeof reconcileMissionCloseout>>;
	latest: Awaited<ReturnType<typeof reconcileMissionLatestSnapshot>>;
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
	const driftDetected =
		workflow.driftDetected ||
		telemetry.driftDetected ||
		closeout.driftDetected ||
		latest.driftDetected;
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
		driftDetected,
	};
}
