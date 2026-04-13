import {
	appendMissionReadModelsRecoveredEvent,
} from "./events.js";
import { loadMission } from "./kernel.js";
import { reconcileMissionCloseout } from "./orchestration.js";
import { reconcileMissionTelemetry } from "./telemetry.js";
import { reconcileMissionWorkflow } from "./workflow.js";

export interface MissionRecoveryResult {
	workflow: Awaited<ReturnType<typeof reconcileMissionWorkflow>>;
	telemetry: Awaited<ReturnType<typeof reconcileMissionTelemetry>>;
	closeout: Awaited<ReturnType<typeof reconcileMissionCloseout>>;
	driftDetected: boolean;
}

export async function recoverMissionReadModels(
	repoRoot: string,
	slug: string,
): Promise<MissionRecoveryResult> {
	const mission = await loadMission(repoRoot, slug);
	const workflow = await reconcileMissionWorkflow(mission);
	const telemetry = await reconcileMissionTelemetry(mission);
	const closeout = await reconcileMissionCloseout(mission);
	const driftDetected =
		workflow.driftDetected ||
		telemetry.driftDetected ||
		closeout.driftDetected;
	if (driftDetected) {
		await appendMissionReadModelsRecoveredEvent(mission, {
			workflow: workflow.driftDetected,
			telemetry: telemetry.driftDetected,
			closeout: closeout.driftDetected,
		});
	}
	return {
		workflow,
		telemetry,
		closeout,
		driftDetected,
	};
}
