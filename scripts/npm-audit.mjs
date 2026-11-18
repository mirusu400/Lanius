#!/usr/bin/env node
// npm audit --audit-level=high, minus advisories that have no patched release
// and only reach build tooling. Run from the package directory.
import { execFileSync } from 'node:child_process';

// Remove an entry as soon as a fixed version is published.
const ALLOWED = {
  // picomatch <=4.0.7, no patched release yet. Only vite, vitest and
  // tinyglobby use it, on glob patterns from this repository; it is not
  // bundled into the app.
  'GHSA-fc5q-39xc-vjpf': 'picomatch ReDoS in dev tooling, no fix released',
};

const LEVELS = new Set(['high', 'critical']);

let output;
try {
  output = execFileSync('npm', ['audit', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
} catch (error) {
  // npm audit exits non-zero when it finds anything; the report is still on stdout.
  output = error.stdout;
}

const report = JSON.parse(output);
if (report.error) {
  console.error(report.error.summary ?? report.error);
  process.exit(1);
}

const findings = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via) {
    if (typeof via === 'object' && LEVELS.has(via.severity)) {
      const id = via.url.split('/').pop();
      findings.set(id, `${via.name} ${via.range}: ${via.title} (${via.url})`);
    }
  }
}

let failed = false;
for (const [id, description] of findings) {
  if (ALLOWED[id]) {
    console.log(`allowed ${id}: ${ALLOWED[id]}`);
  } else {
    console.error(`vulnerable: ${description}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('No unallowed high or critical advisories.');
