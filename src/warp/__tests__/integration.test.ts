import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildOmxWarpTabTitle,
  emitOmxWarpTabTitle,
  resolveDefaultWarpTTYPath,
} from '../integration.js';

describe('warp title integration', () => {
  it('builds OmX-branded tab titles from the cwd basename', () => {
    assert.equal(buildOmxWarpTabTitle('/tmp/demo-repo'), 'OmX · demo-repo');
  });

  it('uses CONOUT$ as the default Warp tty path on Windows', () => {
    assert.equal(resolveDefaultWarpTTYPath('win32'), 'CONOUT$');
    assert.equal(resolveDefaultWarpTTYPath('darwin'), '/dev/tty');
  });

  it('emits tab titles only inside Warp', () => {
    const writes: string[] = [];
    const writeTTY = (_path: string, data: string) => { writes.push(data); };

    assert.equal(
      emitOmxWarpTabTitle('/tmp/demo', {
        env: { TERM_PROGRAM: 'WarpTerminal' },
        writeTTY,
      }),
      true,
    );

    assert.equal(writes.length, 1);
    assert.match(writes[0], /\u001b\]0;OmX · demo\u0007/);
  });

  it('does nothing outside Warp terminals', () => {
    let writes = 0;
    const writeTTY = () => { writes += 1; };

    assert.equal(
      emitOmxWarpTabTitle('/tmp/demo', {
        env: { TERM_PROGRAM: 'iTerm.app' },
        writeTTY,
      }),
      false,
    );

    assert.equal(writes, 0);
  });

  it('emits to the Windows console device when Warp runs on win32', () => {
    const writes: Array<{ path: string; data: string }> = [];
    const writeTTY = (ttyPath: string, data: string) => {
      writes.push({ path: ttyPath, data });
    };

    assert.equal(
      emitOmxWarpTabTitle('/tmp/demo', {
        env: { TERM_PROGRAM: 'WarpTerminal' },
        platform: 'win32',
        writeTTY,
      }),
      true,
    );

    assert.deepEqual(writes.map((entry) => entry.path), ['CONOUT$']);
    assert.match(writes[0].data, /OmX · demo/);
  });

  it('fails closed when the tty write throws', () => {
    assert.equal(
      emitOmxWarpTabTitle('/tmp/demo', {
        env: { TERM_PROGRAM: 'WarpTerminal' },
        writeTTY: () => {
          throw new Error('tty unavailable');
        },
      }),
      false,
    );
  });
});
