import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './process.mjs';
import { findHarnessEntry } from './harness-entry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = await findHarnessEntry();
const background = process.argv.includes('--background');
const args = process.argv.slice(2).filter(arg => arg !== '--background');
const javascript = /\.[cm]?js$/i.test(executable);
await launch(javascript ? process.execPath : executable,
  [...(javascript ? [executable] : []), 'web', '--no-open', ...args],
  { cwd: dirname(root), background, runtimeDir: join(root, '.runtime'), name: 'harness' });
