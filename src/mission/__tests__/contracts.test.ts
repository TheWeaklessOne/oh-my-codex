import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MISSION_LIFECYCLE_TABLE,
  canTransitionMissionStatus,
  closureMatrixDecision,
  normalizeResidualIdentity,
  normalizeVerifierArtifact,
} from '../contracts.js';

describe('mission contracts', () => {
  it('keeps residual identity stable across wording drift when matcher inputs stay equivalent', () => {
    const previous = normalizeResidualIdentity({
      title: 'Unused variable in src/team/runtime.ts',
      summary: 'Remove the unused variable in src/team/runtime.ts',
      severity: 'medium',
      target_path: 'src/team/runtime.ts',
      symbol: 'runMission',
    });
    const next = normalizeResidualIdentity({
      title: 'src/team/runtime.ts has an unused variable',
      summary: 'There is still an unused variable in src/team/runtime.ts',
      severity: 'medium',
      target_path: 'src/team/runtime.ts',
      symbol: 'runMission',
    });

    assert.equal(previous.stable_id, next.stable_id);
    assert.equal(previous.matcher_key, next.matcher_key);
  });

  it('prefers explicit stable ids over derived residual identity', () => {
    const residual = normalizeResidualIdentity({
      stable_id: 'Residual:Lane-Collision',
      title: 'Lane collision',
      summary: 'Same-target lane collision still happens.',
      severity: 'high',
    });

    assert.equal(residual.stable_id, 'residual:lane-collision');
    assert.equal(residual.identity_source, 'stable_id');
    assert.equal(residual.identity_confidence, 'high');
  });

  it('normalizes malformed verifier artifacts into a non-closing summary', () => {
    const summary = normalizeVerifierArtifact(
      {
        verdict: 'needs-human-decision',
        confidence: 'uncertain',
        residuals: [{ summary: 'Oracle output could not be parsed.', severity: 'high' }],
      },
      {
        lane_id: 'lane-audit-1',
        session_id: 'session-audit-1',
        lane_type: 'audit',
        runner_type: 'team',
        adapter_version: 'mission-adapter/v1',
        started_at: '2026-04-11T17:00:00.000Z',
        finished_at: '2026-04-11T17:05:00.000Z',
        parent_iteration: 1,
        trigger_reason: 'initial audit',
        read_only: true,
      },
    );

    assert.equal(summary.verdict, 'AMBIGUOUS');
    assert.equal(summary.confidence, 'low');
    assert.deepEqual(summary.normalization_errors, ['unsupported_verdict', 'unsupported_confidence']);
  });

  it('uses the closure matrix so only fresh PASS plus green baseline closes', () => {
    assert.equal(closureMatrixDecision('PASS', 'high', 'green').outcome, 'complete');
    assert.equal(closureMatrixDecision('PASS', 'low', 'green').outcome, 'iterate');
    assert.equal(closureMatrixDecision('PASS', 'high', 'red').outcome, 'iterate');
  });

  it('exposes a legal lifecycle table without a needs-human-decision state', () => {
    assert.equal(MISSION_LIFECYCLE_TABLE.some((row) => row.to === 'complete'), true);
    assert.equal(canTransitionMissionStatus('BOOTSTRAP', 'running'), true);
    assert.equal(canTransitionMissionStatus('running', 'complete'), true);
    assert.equal(canTransitionMissionStatus('complete', 'running'), false);
  });
});
