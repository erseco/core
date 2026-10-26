/** Smoke-test the actual tarball as an isolated JavaScript and TypeScript consumer. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'schemd-consumer-'));
const windows = process.platform === 'win32';
const npmCommand = windows ? process.execPath : 'npm';
const npmPrefix = windows ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];

function npm(args, cwd) {
  return execFileSync(npmCommand, [...npmPrefix, ...args], { cwd, encoding: 'utf8' });
}

try {
  assert.ok(existsSync(join(root, 'dist/index.js')), 'Build the package before checking its tarball.');
  const [packed] = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], root));
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    join(scratch, packed.filename)], scratch);

  const specifiers = Object.keys(manifest.exports).map((subpath) =>
    subpath === '.' ? manifest.name : manifest.name + subpath.slice(1));
  const imports = specifiers.map((specifier, index) =>
    `import * as entry${index} from ${JSON.stringify(specifier)};\nvoid entry${index};`).join('\n');
  writeFileSync(join(scratch, 'consumer.mts'), imports);

  let smoke = `import assert from 'node:assert/strict';\n${imports}\n`;
  if (manifest.name === '@schemd/core') {
    smoke += `const result = entry0.compileSchematic('resistor:R1 "1 k\\\\Omega" at (160, 100) #blue',
      { bounds: { width: 320, height: 200 }, title: 'Package consumer', mode: 'full' });
      assert.ok(result.svg.includes('<svg'));
      assert.ok(result.svg.includes('R1'));\n`;
  } else {
    smoke += `assert.equal(typeof entry0.connectivityOf, 'function');\n`;
  }
  writeFileSync(join(scratch, 'consumer.mjs'), smoke);
  execFileSync(process.execPath, [join(scratch, 'consumer.mjs')], { cwd: scratch, stdio: 'inherit' });
  execFileSync('bun', [join(scratch, 'consumer.mjs')], { cwd: scratch, stdio: 'inherit' });
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict',
    '--noEmit', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    join(scratch, 'consumer.mts')], { cwd: scratch, stdio: 'inherit' });
  console.log(`Verified ${specifiers.length} public entries from ${packed.filename} in Node, Bun, and TypeScript.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
