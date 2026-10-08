import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { formatSarif } from '../reporters';
import { parseAdapterList } from '../adapters';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupFixture(dir);
});

const fixture = (files: Record<string, string>) => {
    const dir = makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), ...files });
    dirs.push(dir);
    return dir;
};

/** A directory holding executable stand-ins for external tools, named like the real ones. */
function fakeTools(scripts: Record<string, string>): string {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'devkit-fake-bin-'));
    dirs.push(bin);
    for (const [name, body] of Object.entries(scripts)) {
        const file = path.join(bin, name);
        fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
        fs.chmodSync(file, 0o755);
    }
    return bin;
}

// Shaped like gitleaks' JSON report (an array of leaks) and knip's JSON reporter (v5: files + issues).
const GITLEAKS = `
const args = process.argv.slice(2);
const report = args[args.indexOf('--report-path') + 1];
require('fs').writeFileSync(report, JSON.stringify([
  { RuleID: 'generic-api-key', Description: 'Generic API Key', File: process.cwd() + '/src/config.ts', StartLine: 2, StartColumn: 10, Secret: 'SHOULD-NEVER-APPEAR', Match: 'SHOULD-NEVER-APPEAR' },
  { RuleID: 'private-key', Description: 'Private Key', File: 'deploy/key.pem', StartLine: 1, StartColumn: 1, Secret: 'SHOULD-NEVER-APPEAR' }
]));`;
const KNIP = `
console.log(JSON.stringify({
  files: ['src/dead.ts'],
  issues: [
    { file: 'src/index.ts', exports: [{ name: 'unusedThing', line: 3, col: 14 }], types: [{ name: 'Unused', line: 5, col: 13 }] },
    { file: 'package.json', dependencies: [{ name: 'left-pad' }], unlisted: [{ name: 'chalk' }] }
  ]
}));
process.exit(1);`;

describe('--with adapters (A5)', () => {
    it('accepts known tool names and rejects unknown ones', () => {
        expect(parseAdapterList('gitleaks, knip,gitleaks')).toEqual(['gitleaks', 'knip']);
        expect(() => parseAdapterList('semgrep')).toThrow('Unknown tool "semgrep"');
    });

    it('merges gitleaks findings into the report without copying the secret', () => {
        const dir = fixture({ 'src/index.ts': 'export const a = 1;\n', 'src/config.ts': 'export const apiKey = process.env.KEY;\n', 'deploy/key.pem': 'x\n' });
        const tools = fakeTools({ gitleaks: GITLEAKS });
        const summary = scanRepository(dir, () => undefined, { adapters: ['gitleaks'], adapterOptions: { pathDirs: [tools] } });
        const leaks = summary.findings.filter((finding) => finding.ruleId.startsWith('GITLEAKS:'));
        expect(leaks.map((finding) => `${finding.ruleId}@${finding.file}:${finding.line}`).sort()).toEqual(['GITLEAKS:generic-api-key@src/config.ts:2', 'GITLEAKS:private-key@deploy/key.pem:1']);
        expect(JSON.stringify(summary)).not.toContain('SHOULD-NEVER-APPEAR');
        // They are real findings, so they cost points.
        expect(summary.categoryScores.security).toBeLessThan(10);
    });

    it('treats a gitleaks hit on a line the built-in scan already flagged as a confirmation, not a duplicate', () => {
        const key = ['AKIA', 'Z7Q3M9X2', 'K5L8P4T6'].join('');
        const dir = fixture({ 'src/index.ts': 'export const a = 1;\n', 'src/config.ts': `// ${key}\nexport const awsKey = '${key}';\n` });
        const baseline = findingsFor(scanRepository(dir).findings, 'SEC001');
        const tools = fakeTools({ gitleaks: GITLEAKS });
        const merged = scanRepository(dir, () => undefined, { adapters: ['gitleaks'], adapterOptions: { pathDirs: [tools] } });
        // generic-api-key at src/config.ts:2 coincides with the built-in AWS finding on line 2.
        expect(merged.findings.filter((finding) => finding.ruleId === 'GITLEAKS:generic-api-key')).toHaveLength(0);
        expect(findingsFor(merged.findings, 'SEC001')).toHaveLength(baseline.length);
    });

    it('maps knip output to unused file, export, type and dependency findings', () => {
        const dir = fixture({ 'src/index.ts': 'export const a = 1;\n' });
        const tools = fakeTools({ knip: KNIP });
        const summary = scanRepository(dir, () => undefined, { adapters: ['knip'], adapterOptions: { pathDirs: [tools] } });
        const external = summary.findings.filter((finding) => finding.ruleId.startsWith('KNIP:'));
        expect(external.map((finding) => finding.ruleId).sort()).toEqual(['KNIP:dependencies', 'KNIP:exports', 'KNIP:files', 'KNIP:types', 'KNIP:unlisted']);
        expect(external.find((finding) => finding.ruleId === 'KNIP:exports')).toMatchObject({ file: 'src/index.ts', line: 3, category: 'deadCode' });
        expect(external.find((finding) => finding.ruleId === 'KNIP:unlisted')).toMatchObject({ file: 'package.json', category: 'dependencies' });
    });

    it('includes the external rules and stable fingerprints in SARIF', () => {
        const dir = fixture({ 'src/index.ts': 'export const a = 1;\n' });
        const tools = fakeTools({ knip: KNIP });
        const sarif = JSON.parse(formatSarif(scanRepository(dir, () => undefined, { adapters: ['knip'], adapterOptions: { pathDirs: [tools] } })));
        const run = sarif.runs[0];
        expect(run.tool.driver.rules.map((rule: { id: string }) => rule.id)).toContain('KNIP:exports');
        expect(run.results.every((result: { partialFingerprints?: Record<string, string> }) => !!result.partialFingerprints?.['devkit/v1'])).toBe(true);
        const ids = run.results.map((result: { partialFingerprints: Record<string, string> }) => result.partialFingerprints['devkit/v1']);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('reports a missing tool as a warning and still completes the scan', () => {
        const dir = fixture({ 'src/index.ts': 'export const a = 1;\n' });
        const empty = fakeTools({});
        const summary = scanRepository(dir, () => undefined, { adapters: ['gitleaks', 'knip'], adapterOptions: { pathDirs: [empty] } });
        expect(summary.coverage?.warnings?.filter((warning) => warning.includes('not installed'))).toHaveLength(2);
    });

    it('reports output it cannot read instead of failing', () => {
        const dir = fixture({ 'src/index.ts': 'export const a = 1;\n' });
        const tools = fakeTools({ knip: `console.log('not json');` });
        const summary = scanRepository(dir, () => undefined, { adapters: ['knip'], adapterOptions: { pathDirs: [tools] } });
        expect(summary.coverage?.warnings?.[0]).toContain('knip did not print JSON');
    });
});
