import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { changedLinesSince, filterToChanged, parseChangedLines } from '../since';
import { planFixes, writeFixes } from '../fixes';
import { formatDoctor } from '../reporters';
import { proposeIgnores, runInteractiveInit } from '../initInteractive';
import type { Finding } from '../types';
import { cleanupFixture, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });

describe('scan --since (A1)', () => {
    it('parses added and changed line ranges and ignores pure deletions', () => {
        const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -3,0 +4,2 @@', '+x', '+y', '@@ -10,2 +12 @@', '-a', '-b', '+c', '@@ -20,3 +21,0 @@', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@'].join('\n');
        const changed = parseChangedLines(diff);
        expect(changed.get('a.ts')).toEqual([[4, 5], [12, 12]]);
        expect(changed.has('gone.ts')).toBe(false);
    });

    it('keeps findings on changed lines and in new files only', () => {
        const finding = (file: string, line: number) => ({ file, line }) as Finding;
        const changed = new Map<string, Array<[number, number]> | 'all'>([['a.ts', [[4, 5]]], ['new.ts', 'all']]);
        expect(filterToChanged([finding('a.ts', 3), finding('a.ts', 5), finding('b.ts', 5), finding('new.ts', 1)], changed).map((f) => `${f.file}:${f.line}`)).toEqual(['a.ts:5', 'new.ts:1']);
    });

    it('reports only the findings introduced since a git ref', () => {
        dir = makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), 'src/index.ts': 'export function old() {\n    var a = 1;\n    return a;\n}\n' });
        git(dir, 'init', '-q');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'base');
        fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export function old() {\n    var a = 1;\n    return a;\n}\nexport function added() {\n    var b = 2;\n    return b;\n}\n');
        fs.writeFileSync(path.join(dir, 'src/fresh.ts'), 'export function fresh() {\n    debugger;\n}\n');

        const changed = changedLinesSince(dir, 'HEAD');
        const findings = scanRepository(dir).findings;
        const introduced = filterToChanged(findings, changed).map((finding) => `${finding.file}:${finding.line}`);
        expect(introduced).toContain('src/index.ts:6');
        expect(introduced).not.toContain('src/index.ts:2');
        expect(introduced.some((entry) => entry.startsWith('src/fresh.ts'))).toBe(true);
    });

    it('fails with git\'s message for an unknown ref', () => {
        dir = makeFixture({ 'src/index.ts': 'export const a = 1;\n' });
        git(dir, 'init', '-q');
        expect(() => changedLinesSince(dir!, 'no-such-ref')).toThrow();
    });
});

describe('doctor and the environment header (A3)', () => {
    it('describes dependencies, tsconfig, packages, frameworks and unresolved imports', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts', workspaces: ['packages/*'], dependencies: { next: '^14', react: '^18' } }),
            'tsconfig.json': '{"compilerOptions":{"strict":true}}',
            'pnpm-lock.yaml': 'lockfileVersion: 9\n',
            'packages/a/package.json': JSON.stringify({ name: 'a' }),
            'packages/a/src/index.ts': 'export const a = 1;\n',
            'src/index.ts': `import { missing } from 'not-a-real-package';\nexport default missing;\n`
        });
        const summary = scanRepository(dir);
        expect(summary.environment).toMatchObject({
            dependenciesInstalled: false, packageManager: 'pnpm', tsconfig: 'tsconfig.json', packages: 2, workspaceGlobs: ['packages/*'], unresolvedImports: 1, unresolvedSample: ['not-a-real-package']
        });
        expect(summary.environment?.frameworks).toEqual(['Next.js', 'React']);

        const report = formatDoctor(summary);
        expect(report).toContain('not installed');
        expect(report).toContain('pnpm install');
        expect(report).toContain('not-a-real-package');
    });
});

describe('init --interactive (A4)', () => {
    const docusaurus = () => makeFixture({
        'package.json': JSON.stringify({ name: 'docs-site', main: 'src/index.ts', dependencies: { '@docusaurus/core': '^3' } }),
        'build/index.js': 'x\n',
        '.docusaurus/cache.json': '{}',
        'src/index.ts': 'export const a = 1;\n'
    });

    it('proposes framework build output that exists and is not already excluded', () => {
        dir = docusaurus();
        const proposals = proposeIgnores(scanRepository(dir), dir);
        expect(proposals.filter((p) => p.kind === 'framework').map((p) => p.glob).sort()).toEqual(['.docusaurus/**', 'build/**']);
    });

    it('proposes a directory that dominates the findings, and asks before excluding it', async () => {
        const messy = Array.from({ length: 30 }, (_, i) => `export function f${i}() {\n    var v = ${i};\n    return v;\n}\n`);
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }),
            'src/index.ts': 'export const a = 1;\n',
            ...Object.fromEntries(messy.map((source, i) => [`legacy/m${i}.ts`, `import { a } from '../src/index';\n${source}export const used${i} = a;\n`]))
        });
        const summary = scanRepository(dir, () => undefined, { includeNonProduction: true });
        const questions: string[] = [];
        const result = await runInteractiveInit(dir, summary, async (question) => { questions.push(question); return true; });
        expect(result.proposals.some((p) => p.kind === 'noisy' && p.glob === 'legacy/**')).toBe(true);
        expect(questions.some((question) => question.includes('legacy/**') && question.includes('hides these files'))).toBe(true);
        const config = JSON.parse(fs.readFileSync(path.join(dir, '.devkitrc.json'), 'utf8'));
        expect(config.scan.exclude).toContain('legacy/**');
        expect(config.scan.exclude).toContain('node_modules/**');
    });

    it('with assumeYes accepts framework output, declines the rest and never asks, keeping existing config', async () => {
        dir = docusaurus();
        fs.writeFileSync(path.join(dir, '.devkitrc.json'), JSON.stringify({ project: { name: 'keep-me' }, rules: { TS001: { enabled: false } } }));
        const result = await runInteractiveInit(dir, scanRepository(dir), async () => { throw new Error('should not ask'); }, { assumeYes: true });
        expect(result.accepted.sort()).toEqual(['.docusaurus/**', 'build/**']);
        const config = JSON.parse(fs.readFileSync(path.join(dir, '.devkitrc.json'), 'utf8'));
        expect(config.project.name).toBe('keep-me');
        expect(config.rules.TS001.enabled).toBe(false);
    });
});

describe('fix --write (A2)', () => {
    const fixtureFor = (source: string) => makeFixture({ 'package.json': JSON.stringify({ name: 'x', main: 'src/index.ts' }), 'src/index.ts': source });
    const plan = (source: string) => {
        dir = fixtureFor(source);
        return planFixes(dir, scanRepository(dir).findings);
    };

    it('removes unused imports, debug statements and converts var, leaving code that still compiles', () => {
        const result = plan([
            `import { readFileSync, existsSync } from 'node:fs';`,
            `import path from 'node:path';`,
            ``,
            `export function run(name: string) {`,
            `    var total = 0;`,
            `    var label = path.basename(name);`,
            `    console.log('debug', label);`,
            `    total += label.length;`,
            `    console.error('kept');`,
            `    return existsSync(name) ? total : -1;`,
            `}`,
            ``
        ].join('\n'));
        expect(result.files).toHaveLength(1);
        const { updated, fixes } = result.files[0];
        expect(updated).toContain(`import { existsSync } from 'node:fs';`);
        expect(updated).not.toContain('readFileSync');
        expect(updated).toContain('let total = 0;');
        expect(updated).toContain('const label = path.basename(name);');
        expect(updated).not.toContain("console.log('debug'");
        expect(updated).toContain("console.error('kept')");
        expect(fixes.map((fix) => fix.ruleId).sort()).toEqual(['DEAD002', 'HYGIENE001', 'JS001', 'JS001']);
    });

    it('removes only the unused binding and keeps the import\'s own layout', () => {
        const result = plan([
            `import {`,
            `  existsSync,`,
            `  readFileSync,`,
            `  statSync,`,
            `} from 'node:fs';`,
            `import { basename, join } from 'node:path';`,
            `import os, { EOL } from 'node:os';`,
            `export const exists = existsSync;`,
            `export const stat = statSync;`,
            `export const joined = join('a', 'b');`,
            `export const eol = EOL;`,
            ``
        ].join('\n'));
        const updated = result.files[0].updated;
        expect(updated).toContain(['import {', '  existsSync,', '  statSync,', "} from 'node:fs';"].join('\n'));
        expect(updated).toContain("import { join } from 'node:path';");
        expect(updated).toContain("import { EOL } from 'node:os';");
    });

    it('does not empty a block by removing its only statement', () => {
        const result = plan(`export function f(flag: boolean) {\n    if (flag) {\n        console.log('on');\n    } else {\n        console.log('off');\n    }\n    return flag;\n}\n`);
        expect(result.files).toHaveLength(0);
    });

    it('writes the planned changes only when asked', () => {
        const source = `import { readFileSync } from 'node:fs';\nexport const a = 1;\n`;
        const result = plan(source);
        expect(fs.readFileSync(path.join(dir!, 'src/index.ts'), 'utf8')).toBe(source);
        writeFixes(result);
        expect(fs.readFileSync(path.join(dir!, 'src/index.ts'), 'utf8')).not.toContain('readFileSync');
    });

    it.each([
        ['a use before the declaration', 'export function f() {\n    const before = x;\n    var x = 1;\n    return [before, x];\n}\n'],
        ['a redeclared var', 'export function f() {\n    var x = 1;\n    var x = 2;\n    return x;\n}\n'],
        ['a use inside a hoisted function declaration', 'export function f() {\n    var x = 1;\n    function g() { return x; }\n    return g();\n}\n'],
        ['a script-level var (it creates a global)', 'var shared = 1;\n']
    ])('leaves a var alone when it cannot be proven safe: %s', (_label, source) => {
        const result = plan(source);
        expect(result.files.flatMap((file) => file.fixes.filter((fix) => fix.ruleId === 'JS001'))).toHaveLength(0);
    });

    it('does not remove a console call that is the body of an if without braces', () => {
        const result = plan(`export function f(flag: boolean) {\n    if (flag) console.log('on');\n    return flag;\n}\n`);
        expect(result.files).toHaveLength(0);
    });

    it('is idempotent: after writing, the fixed findings are gone and a second plan is empty', () => {
        dir = fixtureFor(`import { readFileSync } from 'node:fs';\nexport function f() {\n    var a = 1;\n    console.log(a);\n    return a;\n}\n`);
        writeFixes(planFixes(dir, scanRepository(dir).findings));
        const after = scanRepository(dir).findings;
        expect(after.filter((finding) => ['DEAD002', 'JS001', 'HYGIENE001'].includes(finding.ruleId))).toHaveLength(0);
        expect(planFixes(dir, after).files).toHaveLength(0);
    });
});
