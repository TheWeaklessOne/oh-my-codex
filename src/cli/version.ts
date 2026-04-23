import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const VERSION_SOURCE_LABEL = 'Source: forked local dev build';

export function version(): void {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(__filename), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    console.log(`oh-my-codex v${pkg.version}`);
    console.log(VERSION_SOURCE_LABEL);
    console.log(`Node.js ${process.version}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
  } catch {
    console.log('oh-my-codex (version unknown)');
  }
}
