import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: 'fixture', ...extra });
const ids = (findings: Array<{ ruleId: string }>, rule: string) => findingsFor(findings, rule).length;

function install(root: string, name: string, manifest: Record<string, unknown> = {}): void {
    const target = path.join(root, 'node_modules', name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
}

describe('file kinds: noise-prone rules only judge shipped code', () => {
    const body = `export function f(req: any, res: any, spare: any) { console.log(res); return res.send(); }\nvar legacy = 1;\n`;

    it('reports in production code', () => {
        dir = makeFixture({ 'src/app.ts': body });
        const { findings } = scanRepository(dir);
        expect(ids(findings, 'HYGIENE001')).toBeGreaterThan(0);
    });

    it('hides the same findings in tests, examples, benchmarks and fixtures, and counts them', () => {
        dir = makeFixture({ 'test/app.ts': body, 'examples/app.ts': body, 'bench/app.ts': body, 'src/fixtures/app.ts': body });
        const summary = scanRepository(dir);
        expect(ids(summary.findings, 'HYGIENE001')).toBe(0);
        expect(ids(summary.findings, 'JS001')).toBe(0);
        expect(summary.coverage?.nonProductionFindingsHidden).toBeGreaterThan(0);
    });

    it('shows them again with scan.includeNonProduction', () => {
        dir = makeFixture({ '.devkitrc.json': JSON.stringify({ scan: { includeNonProduction: true } }), 'test/app.ts': body });
        expect(ids(scanRepository(dir).findings, 'HYGIENE001')).toBeGreaterThan(0);
    });

    it('still reports security issues in build scripts but not in tests', () => {
        const exec = `import { exec } from 'node:child_process';\nexport function run(p: string) { exec('rm ' + p); }\n`;
        dir = makeFixture({ 'scripts/clean.ts': exec, 'test/clean.ts': exec });
        const files = findingsFor(scanRepository(dir).findings, 'SEC003').map((f) => f.file);
        expect(files).toEqual(['scripts/clean.ts']);
    });
});

describe('project TypeScript settings', () => {
    it('does not report implicit any in plain JavaScript', () => {
        dir = makeFixture({ 'src/a.js': `module.exports = function (req, res) { return res.send(req); };\n` });
        expect(ids(scanRepository(dir).findings, 'TS001')).toBe(0);
    });

    it('does not report implicit any when the project turned noImplicitAny off', () => {
        dir = makeFixture({
            'tsconfig.json': JSON.stringify({ compilerOptions: { strict: false } }),
            'src/a.ts': `export function f(value) { return value; }\n`
        });
        expect(ids(scanRepository(dir).findings, 'TS001')).toBe(0);
    });

    it('reports implicit any when the project enabled strict mode', () => {
        dir = makeFixture({
            'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
            'src/a.ts': `export function f(value) { return value; }\n`
        });
        expect(ids(scanRepository(dir).findings, 'TS001')).toBeGreaterThan(0);
    });

    it('resolves a path alias declared in a nested package tsconfig instead of calling it an unlisted dependency', () => {
        dir = makeFixture({
            'package.json': pkg({ private: true }),
            'packages/web/package.json': pkg({ name: 'web' }),
            'packages/web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
            'packages/web/lib/util.ts': `export const util = 1;\n`,
            'packages/web/app/page.ts': `import { util } from '@/lib/util';\nimport data from '@/.source';\nexport default [util, data];\n`
        });
        expect(ids(scanRepository(dir).findings, 'DEP002')).toBe(0);
    });
});

describe('DEAD006 / DEAD003 conventions', () => {
    it('keeps positional parameters that precede a used one and ignores underscore names', () => {
        dir = makeFixture({
            'src/a.js': `export const handler = (req, res) => res.send();\nexport const tail = (a, b) => a;\nexport const ignored = (_unused, used) => used;\nconst _scratch = 1;\n`
        });
        const dead006 = findingsFor(scanRepository(dir).findings, 'DEAD006').map((f) => f.evidence);
        expect(dead006).toEqual(['b']);
        expect(ids(scanRepository(dir).findings, 'DEAD003')).toBe(0);
    });
});

describe('error-handling precision', () => {
    it('treats .then(onOk, onErr) as handled', () => {
        dir = makeFixture({ 'src/a.ts': `export function run(p: Promise<number>) { p.then((v) => v, (e) => e); }\n` });
        expect(ids(scanRepository(dir).findings, 'ERR004')).toBe(0);
    });

    it('ignores an async IIFE that handles its own errors and helpers that return their argument', () => {
        dir = makeFixture({
            'src/a.ts': `export function run(p: Promise<number>) {\n    (async () => { try { await p; } catch (e) { console.error(e); } })();\n    Object.defineProperties(p, {});\n}\n`
        });
        expect(ids(scanRepository(dir).findings, 'ERR003')).toBe(0);
    });

    it('ignores fluent thenable builders that return themselves', () => {
        dir = makeFixture({
            'src/a.ts': `class Reply { code(n: number): this { return this; } then(a: () => void, b: () => void): void {} }\ndeclare const reply: Reply;\nexport function send() { reply.code(200); }\n`
        });
        expect(ids(scanRepository(dir).findings, 'ERR003')).toBe(0);
    });

    it('does not call === false redundant on an untyped value', () => {
        dir = makeFixture({ 'src/a.js': `module.exports = function (options) { return options.flag === false; };\n` });
        expect(ids(scanRepository(dir).findings, 'REDUNDANT001')).toBe(0);
    });
});

describe('TS002 suppression directives', () => {
    it('accepts an explained expect-error and flags a bare ts-ignore', () => {
        dir = makeFixture({
            'src/a.ts': `// @ts-expect-error legacy typing is wrong upstream\nexport const a: number = 'x' as any;\n// @ts-ignore\nexport const b: number = 'y' as any;\n`
        });
        const lines = findingsFor(scanRepository(dir).findings, 'TS002').map((f) => f.line);
        expect(lines).toEqual([3]);
    });
});

describe('SEC004 HTML sinks', () => {
    it('ignores a literal assignment and downgrades serialized JSON', () => {
        dir = makeFixture({
            'src/a.tsx': `export function A({ data, html }: { data: object; html: string }) {\n    document.body.innerHTML = '';\n    return <div><script dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} /><p dangerouslySetInnerHTML={{ __html: html }} /></div>;\n}\n`
        });
        const found = findingsFor(scanRepository(dir).findings, 'SEC004');
        expect(found).toHaveLength(2);
        expect(found.find((f) => f.evidence.includes('JSON.stringify'))?.confidence).toBe('LOW');
        expect(found.find((f) => f.evidence.includes('__html: html'))?.confidence).toBe('MEDIUM');
    });
});

describe('dependency evidence', () => {
    it('counts an executable invoked by a different name than its package (lint-staged, CI)', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { '@biomejs/biome': '^1', typescript: '^5' }, 'lint-staged': { '*.ts': ['biome format --write'] }, scripts: { build: 'tsc -p .' } }),
            'src/index.ts': `export const a = 1;\n`
        });
        install(dir, '@biomejs/biome', { bin: { biome: 'bin/biome' } });
        install(dir, 'typescript', { bin: { tsc: 'bin/tsc' } });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('falls back to the package name as the command when the package is not installed', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { prettier: '^3' } }),
            '.github/workflows/ci.yml': `steps:\n  - run: prettier --check .\n`,
            'src/index.ts': `export const a = 1;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('counts a package loaded by name from a string literal', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { hbs: '^4' } }),
            'src/app.js': `exports.engine = 'hbs';\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('counts a package named in tsconfig (extends)', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { '@acme/tsconfig': '^1' } }),
            'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig/base.json' }),
            'src/index.ts': `export const a = 1;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('does not treat node:, bun:, jsr: schemes, import-map names, self and workspace names as unlisted packages', () => {
        dir = makeFixture({
            'package.json': pkg({ name: 'root', private: true }),
            'deno.json': JSON.stringify({ imports: { '@std/assert': 'jsr:@std/assert@1' } }),
            'packages/lib/package.json': pkg({ name: 'lib' }),
            'packages/app/package.json': pkg({ name: 'app' }),
            'packages/lib/src/a.ts': `import t from 'node:test';\nimport b from 'bun:test';\nimport { eq } from '@std/assert';\nimport self from 'lib';\nexport default [t, b, eq, self];\n`,
            'packages/app/src/b.ts': `import lib from 'lib';\nexport default lib;\n`
        });
        expect(ids(scanRepository(dir).findings, 'DEP002')).toBe(0);
    });

    it('ignores undeclared imports in examples', () => {
        dir = makeFixture({ 'package.json': pkg({}), 'examples/demo/app.js': `const redis = require('redis');\nmodule.exports = redis;\n` });
        expect(ids(scanRepository(dir).findings, 'DEP002')).toBe(0);
    });
});

describe('import cycles', () => {
    it('ignores cycles that exist only through type-only imports', () => {
        dir = makeFixture({
            'src/a.ts': `import type { B } from './b';\nexport interface A { b: B }\nexport const a = 1;\n`,
            'src/b.ts': `import { a } from './a';\nexport interface B { a: typeof a }\n`
        });
        expect(ids(scanRepository(dir).findings, 'DEP003')).toBe(0);
    });

    it('reports a tangled runtime component once, not once per path', () => {
        dir = makeFixture({
            'src/a.ts': `import { b } from './b';\nimport { c } from './c';\nexport const a = () => [b, c];\n`,
            'src/b.ts': `import { a } from './a';\nimport { c } from './c';\nexport const b = () => [a, c];\n`,
            'src/c.ts': `import { a } from './a';\nimport { b } from './b';\nexport const c = () => [a, b];\n`
        });
        expect(ids(scanRepository(dir).findings, 'DEP003')).toBe(1);
    });
});

describe('entry points and re-exports', () => {
    it('treats export * as ns as a use of the target module', () => {
        dir = makeFixture({
            'package.json': pkg({ main: 'src/index.ts' }),
            'src/index.ts': `export * as coerce from './coerce';\n`,
            'src/coerce.ts': `export function string() { return 1; }\n`
        });
        const { findings } = scanRepository(dir);
        expect(ids(findings, 'DEAD010')).toBe(0);
        expect(ids(findings, 'DEAD009')).toBe(0);
    });

    it('maps main/exports pointing at build output back to the sources', () => {
        dir = makeFixture({
            'package.json': pkg({ main: './dist/index.js', exports: { '.': { import: './dist/index.mjs' }, './util': './dist/util.js' } }),
            'src/index.ts': `export const api = 1;\n`,
            'src/util.ts': `export const util = 1;\n`
        });
        const { findings } = scanRepository(dir);
        expect(ids(findings, 'DEAD009')).toBe(0);
        expect(ids(findings, 'DEAD010')).toBe(0);
    });

    it('treats files named by the browser field as entry points', () => {
        dir = makeFixture({
            'package.json': pkg({ main: 'lib/node.js', browser: { './lib/node.js': './lib/browser.js' } }),
            'lib/node.js': `module.exports = 1;\n`,
            'lib/browser.js': `module.exports = 2;\n`
        });
        expect(ids(scanRepository(dir).findings, 'DEAD010')).toBe(0);
    });

    it('applies framework conventions per package in a monorepo', () => {
        dir = makeFixture({
            'package.json': pkg({ private: true }),
            'packages/docs/package.json': pkg({ name: 'docs', dependencies: { next: '^16' } }),
            'packages/docs/app/blog/page.tsx': `export const revalidate = 60;\nexport default function Page() { return null; }\n`
        });
        expect(ids(scanRepository(dir).findings, 'DEAD009')).toBe(0);
    });
});

describe('duplication, complexity and style noise', () => {
    it('reports a block repeated across many files once, with lower confidence', () => {
        const block = (name: string) => `export function ${name}(input: string, options: { strict: boolean; locale: string }) {\n    const normalized = input.trim().toLowerCase();\n    if (options.strict && normalized.length === 0) { throw new Error('empty input is not allowed here'); }\n    const parts = normalized.split(',').map((part) => part.trim()).filter((part) => part.length > 0);\n    return parts.map((part, index) => ({ index, part, locale: options.locale, strict: options.strict }));\n}\n`;
        const files: Record<string, string> = {};
        for (let i = 0; i < 12; i += 1) files[`src/locales/l${i}.ts`] = block(`parse${i}`);
        dir = makeFixture(files);
        const dups = findingsFor(scanRepository(dir).findings, 'DUP001');
        expect(dups.length).toBeLessThanOrEqual(2);
        expect(dups.every((d) => d.confidence === 'LOW')).toBe(true);
    });

    it('downgrades cyclomatic complexity that is only a flat switch', () => {
        const cases = Array.from({ length: 15 }, (_, i) => `        case ${i}: return 'v${i}';`).join('\n');
        dir = makeFixture({ 'src/a.ts': `export function label(n: number): string {\n    switch (n) {\n${cases}\n        default: return 'x';\n    }\n}\n` });
        const [finding] = findingsFor(scanRepository(dir).findings, 'COMPLEX001');
        expect(finding.severity).toBe('LOW');
    });

    it('does not flag var in a project written in var style', () => {
        const lines = Array.from({ length: 30 }, (_, i) => `var v${i} = ${i};`).join('\n');
        dir = makeFixture({ 'src/a.js': `${lines}\nmodule.exports = v0;\n` });
        expect(ids(scanRepository(dir).findings, 'JS001')).toBe(0);
    });

    it('still flags var in a modern project', () => {
        dir = makeFixture({ 'src/a.js': `const a = 1;\nlet b = 2;\nvar c = 3;\nmodule.exports = [a, b, c];\n` });
        expect(ids(scanRepository(dir).findings, 'JS001')).toBe(1);
    });
});

describe('scalability', () => {
    it('scans a workspace with hundreds of packages without quadratic slowdowns', () => {
        const files: Record<string, string> = { 'package.json': pkg({ private: true }) };
        for (let p = 0; p < 200; p += 1) {
            files[`packages/p${p}/package.json`] = pkg({ name: `p${p}`, dependencies: { [`dep${p}`]: '^1' } });
            for (let f = 0; f < 8; f += 1) files[`packages/p${p}/src/f${f}.ts`] = `export const v${p}_${f} = ${f};\n`;
        }
        dir = makeFixture(files);
        const started = Date.now();
        const summary = scanRepository(dir);
        expect(summary.coverage?.analyzedFiles).toBe(1600);
        // Generous bound: the per-package file scans used to take minutes on workspaces of this shape.
        expect(Date.now() - started).toBeLessThan(25_000);
    }, 60_000);
});
