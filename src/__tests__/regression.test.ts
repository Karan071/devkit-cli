import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('module graph regressions', () => {
    // Caught flaw #1 in the original audit — do not weaken.
    it('does not mark a CommonJS require tree as unused files', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', main: 'lib/index.js' }),
            '.devkitrc.json': JSON.stringify({ scan: { include: ['lib/**'], exclude: [] } }),
            'lib/index.js': "const command = require('./command'); module.exports = command;",
            'lib/command.js': "const option = require('./option'); const help = require('./help'); module.exports = { option, help };",
            'lib/option.js': "const help = require('./help'); module.exports = function option() { return help; };",
            'lib/help.js': "const option = require('./option'); module.exports = function help() { return option; };"
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEAD010')).toHaveLength(0);
    });

    // The default scan.include must not require a top-level src/ or packages/ dir —
    // most real npm packages (e.g. commander) ship source at the project root.
    it('scans a top-level CommonJS layout with no custom .devkitrc.json', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', main: 'index.js' }),
            'index.js': "const command = require('./command'); module.exports = command;",
            'command.js': "const option = require('./option'); module.exports = { option };",
            'option.js': 'module.exports = function option() { return true; };'
        });
        const summary = scanRepository(dir);
        expect(summary.metrics.totalFiles).toBe(3);
        expect(findingsFor(summary.findings, 'DEAD010')).toHaveLength(0);
    });

    it('resolves TypeScript path aliases when checking exported and file usage', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', main: 'src/a.ts' }),
            'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
            'src/a.ts': "import { helper } from '@/b'; export const result = helper();",
            'src/b.ts': 'export function helper() { return 1; }'
        });
        const findings = scanRepository(dir).findings;
        expect(findingsFor(findings, 'DEAD009').some((finding) => finding.file === 'src/b.ts')).toBe(false);
        expect(findingsFor(findings, 'DEAD010').some((finding) => finding.file === 'src/b.ts')).toBe(false);
    });

    it('lowers dead-code confidence near an unresolved dynamic loader', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', main: 'src/index.ts' }),
            'src/index.ts': "const target = './plugin-' + name; import(target); export const start = true;",
            'src/plugin-a.ts': 'export const plugin = true;'
        });
        const findings = scanRepository(dir).findings;
        const fileFinding = findingsFor(findings, 'DEAD010').find((finding) => finding.file === 'src/plugin-a.ts');
        expect(fileFinding?.confidence).toBe('LOW');
        expect(fileFinding?.description).toContain('dynamic require/import');
    });

    it('excludes configured source paths from scanned metrics and findings', () => {
        dir = makeFixture({
            '.devkitrc.json': JSON.stringify({ scan: { include: ['src/**'], exclude: ['src/ignored/**'] } }),
            'src/index.ts': 'export const ok = 1;',
            'src/ignored/bad.ts': 'console.log("debug");'
        });
        const summary = scanRepository(dir);
        expect(summary.metrics.totalFiles).toBe(1);
        expect(summary.findings.some((finding) => finding.file === 'src/ignored/bad.ts')).toBe(false);
    });

    it('treats tool config files as entry points rather than unused files', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', main: 'src/index.ts' }),
            'src/index.ts': 'export const ok = 1;',
            'vitest.config.mts': 'export default { test: {} };',
            'eslint.config.js': 'module.exports = [];'
        });
        const unusedFiles = findingsFor(scanRepository(dir).findings, 'DEAD010').map((finding) => finding.file);
        expect(unusedFiles).toEqual([]);
    });
});
