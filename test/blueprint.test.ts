import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveBlueprint } from '../scripts/check-blueprint.mjs';

const source = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
test('Blueprint guard resolves the actual root paths and documented defaults', () => {
  const root = resolve('.');
  assert.deepEqual(resolveBlueprint(root), { context: root, dockerfile: join(root, 'Dockerfile') });
  assert.deepEqual(resolveBlueprint(root, source.replace(/^    docker(?:Context|filePath):.*\n/gm, '')), resolveBlueprint(root));
});
test('Blueprint guard rejects missing paths, wrong types and unsupported/ambiguous configuration', () => {
  for (const text of [
    source.replace('dockerContext: .', 'dockerContext: ./missing'),
    source.replace('dockerfilePath: ./Dockerfile', 'dockerfilePath: ./missing'),
    source.replace('dockerContext: .', 'dockerContext: ./Dockerfile'),
    source.replace('dockerfilePath: ./Dockerfile', 'dockerfilePath: .'),
    source.replace('dockerContext: .', 'dockerContext: *external'),
    source.replace('dockerContext: .', 'dockerContext: .\n    dockerContext: .'),
    `${source}\n  - type: web\n    runtime: docker\n`,
  ]) assert.throws(() => resolveBlueprint(resolve('.'), text));
});
test('Blueprint guard rejects parent, absolute, drive and linked path escapes', () => {
  const outer = mkdtempSync(join(tmpdir(), 'studypilot-blueprint-')), root = join(outer, 'repo');
  mkdirSync(root); writeFileSync(join(root, 'Dockerfile'), 'FROM scratch\n');
  const outside = join(outer, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'Dockerfile'), 'FROM scratch\n');
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['..', '../outside', outside.replaceAll('\\', '/'), 'C:/outside', './linked']) {
    assert.throws(() => resolveBlueprint(root, source.replace('dockerContext: .', `dockerContext: ${path}`)));
  }
});
