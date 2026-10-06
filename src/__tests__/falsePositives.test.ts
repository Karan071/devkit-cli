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

function installPackage(root: string, name: string, manifest: Record<string, unknown>): void {
    const target = path.join(root, 'node_modules', name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }));
}

const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: 'fixture', ...extra });

describe('SEC003 command execution', () => {
    it('ignores RegExp.exec with a dynamic argument', () => {
        dir = makeFixture({ 'src/color.ts': `export function parse(hex?: string) { return /^#?([a-f\\d]{2})$/i.exec(hex || ''); }\n` });
        expect(findingsFor(scanRepository(dir).findings, 'SEC003')).toHaveLength(0);
    });

    it('ignores a database-style exec that is not child_process', () => {
        dir = makeFixture({ 'src/db.ts': `declare const db: { exec(sql: string): void };\nexport function run(table: string) { db.exec('DROP ' + table); }\n` });
        expect(findingsFor(scanRepository(dir).findings, 'SEC003')).toHaveLength(0);
    });

    it('still flags child_process exec through a namespace import and an alias', () => {
        dir = makeFixture({
            'src/a.ts': `import * as cp from 'node:child_process';\nexport function run(p: string) { cp.exec('rm ' + p); }\n`,
            'src/b.ts': `import { exec as run } from 'child_process';\nexport function go(p: string) { run('rm ' + p); }\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'SEC003').length).toBeGreaterThanOrEqual(2);
    });
});

describe('ERR003 floating promises', () => {
    it('ignores single-callback thenables such as animation tweens', () => {
        dir = makeFixture({
            'src/tween.ts': `interface Tween { kill(): Tween; then(onFulfilled?: () => void): Promise<void>; }\ndeclare const tween: Tween;\nexport function stop() { tween.kill(); }\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'ERR003')).toHaveLength(0);
    });

    it('still flags a real floating Promise', () => {
        dir = makeFixture({ 'src/a.ts': `async function load() { return 1; }\nexport function run() { load(); }\n` });
        expect(findingsFor(scanRepository(dir).findings, 'ERR003')).toHaveLength(1);
    });
});

describe('DEP001 usage outside imports', () => {
    it('counts config-file plugins, the implied tool and peers of used packages', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { postcss: '^8', autoprefixer: '^10', tailwindcss: '^3', 'react-dom': '^19', next: '^16' } }),
            'postcss.config.js': `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`,
            'src/index.ts': `import next from 'next';\nexport default next;\n`
        });
        installPackage(dir, 'next', { peerDependencies: { 'react-dom': '^19' } });
        installPackage(dir, 'autoprefixer', { peerDependencies: { postcss: '^8' } });
        const unused = findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence);
        expect(unused).toEqual([]);
    });

    it('counts packages imported from stylesheets', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { shadcn: '^1' } }),
            'src/app/globals.css': `@import "tailwindcss";\n@import "shadcn/tailwind.css";\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').some((f) => f.evidence === 'shadcn')).toBe(false);
    });

    it('counts optional peers of a used package', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { '@next/mdx': '^16', '@mdx-js/loader': '^3' } }),
            'src/index.ts': `import mdx from '@next/mdx';\nexport default mdx;\n`
        });
        installPackage(dir, '@next/mdx', { peerDependencies: { '@mdx-js/loader': '*' }, peerDependenciesMeta: { '@mdx-js/loader': { optional: true } } });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').some((f) => f.evidence === '@mdx-js/loader')).toBe(false);
    });

    it('offers a safe fix only when the unused package is installed and verifiably unreferenced', () => {
        dir = makeFixture({ 'package.json': pkg({ dependencies: { lodash: '^4' } }), 'src/index.ts': `export const a = 1;\n` });
        installPackage(dir, 'lodash', {});
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(finding.evidence).toBe('lodash');
        expect(finding.confidence).toBe('HIGH');
        expect(finding.fixAvailable).toBe(true);
    });

    it('cannot verify a package that is not installed, so it withholds the fix', () => {
        dir = makeFixture({ 'package.json': pkg({ dependencies: { lodash: '^4' } }), 'src/index.ts': `export const a = 1;\n` });
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(finding.confidence).toBe('MEDIUM');
        expect(finding.fixAvailable).toBe(false);
    });

    it('downgrades and withholds the fix when another project file mentions the package by name', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { 'some-tool': '^1' } }),
            'config/settings.conf': `[tool]\nplugin = some-tool\n`,
            'src/index.ts': `export const a = 1;\n`
        });
        installPackage(dir, 'some-tool', {});
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(finding.confidence).toBe('LOW');
        expect(finding.fixAvailable).toBe(false);
    });
});

describe('DEP002 type-only imports', () => {
    it('accepts an import typed by the matching @types package', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { '@types/mdx': '^2', '@types/scope__lib': '^1' } }),
            'src/a.ts': `import type { MDXComponents } from 'mdx/types';\nimport type { X } from '@scope/lib';\nexport type T = [MDXComponents, X];\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP002')).toHaveLength(0);
    });
});

describe('DEAD009 framework entry points', () => {
    it('treats Next.js convention files under src/ and at the root as entry points', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { next: '^16' } }),
            'mdx-components.tsx': `export function useMDXComponents() { return {}; }\n`,
            'src/middleware.ts': `export function middleware() {}\nexport const config = {};\n`,
            'src/app/page.tsx': `export default function Page() { return null; }\nexport const revalidate = 60;\n`,
            'src/app/blog/layout.tsx': `export function generateMetadata() { return {}; }\nexport default function L() { return null; }\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEAD009')).toHaveLength(0);
    });

    it('does not exempt ordinary modules inside app/', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { next: '^16' } }),
            'src/app/helpers.ts': `export function unusedHelper() { return 1; }\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEAD009').length).toBeGreaterThan(0);
    });
});

describe('dead-code precision', () => {
    it('names only the unused import specifier', () => {
        dir = makeFixture({ 'src/a.ts': `import React, { useState } from 'react';\nexport const x = useState;\n` });
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEAD002');
        expect(finding?.evidence).toBe('React');
    });

    it('does not offer a safe fix for a state variable whose setter is still used', () => {
        dir = makeFixture({
            'src/a.ts': `declare function useState<T>(v: T): [T, (v: T) => void];\nexport function f() { const [isDark, setIsDark] = useState(false); setIsDark(true); }\n`
        });
        const finding = findingsFor(scanRepository(dir).findings, 'DEAD003').find((f) => f.evidence === 'isDark');
        expect(finding?.fixAvailable).toBe(false);
    });
});
