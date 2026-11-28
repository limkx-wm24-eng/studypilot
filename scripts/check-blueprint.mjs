import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Intentionally validate this project's single-service Blueprint, not arbitrary
// YAML. Fail closed if its structure/scalar syntax changes; no transitive parser.
export function resolveBlueprint(repository, source = readFileSync(resolve(repository, 'render.yaml'), 'utf8')) {
  if ((source.match(/^services:\s*(?:#.*)?$/gm) ?? []).length !== 1 || (source.match(/^  - type:/gm) ?? []).length !== 1
    || !/^  - type: web\s*$/m.test(source)) throw new Error('Blueprint guard requires one top-level web service');
  const fields = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^    (name|runtime|rootDir|dockerContext|dockerfilePath):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (key in fields) throw new Error(`Duplicate Blueprint field: ${key}`);
    let value = raw.replace(/\s+#.*$/, '');
    if (/^"[^"\\]*"$/.test(value) || /^'[^']*'$/.test(value)) value = value.slice(1, -1);
    else if (!/^[A-Za-z0-9_./-]+$/.test(value)) throw new Error(`Unsupported Blueprint scalar: ${key}`);
    fields[key] = value;
  }
  if (fields.name !== 'studypilot' || fields.runtime !== 'docker') throw new Error('Expected the StudyPilot Docker service');
  const root = realpathSync(repository);
  const inside = (base, value, directory) => {
    if (!value || isAbsolute(value) || win32.isAbsolute(value) || value.includes('\\') || value.includes('\0')) throw new Error('Blueprint paths must be relative');
    const candidate = realpathSync(resolve(base, value));
    const suffix = relative(root, candidate);
    if (suffix === '..' || suffix.startsWith('../') || suffix.startsWith('..\\') || isAbsolute(suffix)) throw new Error('Blueprint path escapes the repository');
    if (directory ? !statSync(candidate).isDirectory() : !statSync(candidate).isFile()) throw new Error('Blueprint path has the wrong file type');
    return candidate;
  };
  const rootDir = inside(root, fields.rootDir ?? '.', true);
  return { context: inside(rootDir, fields.dockerContext ?? '.', true), dockerfile: inside(rootDir, fields.dockerfilePath ?? './Dockerfile', false) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const paths = resolveBlueprint(fileURLToPath(new URL('../', import.meta.url)));
    if (process.argv.includes('--build')) {
      const result = spawnSync('docker', ['build', '--file', paths.dockerfile, paths.context], { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('Blueprint-resolved Docker build failed');
    }
    console.log('Blueprint Docker paths are valid and stay inside the repository.');
  } catch (error) { console.error((error instanceof Error ? error.message : 'Blueprint validation failed')); process.exitCode = 1; }
}
