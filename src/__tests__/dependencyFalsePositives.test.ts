import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: 'fixture', version: '1.0.0', ...extra });
const names = (findings: Array<{ message: string }>) => findings.map((finding) => finding.message.replace(/^[^:]+: /, '')).sort();

describe('DEP001: executables of tools that are not installed (D1)', () => {
    it('treats typescript, vitest, biome, tsx, tsup, turbo, rimraf, eslint and prettier as used when scripts run their commands', () => {
        dir = makeFixture({
            'package.json': pkg({
                scripts: { build: 'rimraf dist && tsc -p . && tsup', test: 'vitest run', lint: 'biome check . && eslint . && prettier --check .', dev: 'tsx watch src/index.ts', ci: 'turbo run build' },
                devDependencies: { typescript: '^5', vitest: '^2', '@biomejs/biome': '^1', tsx: '^4', tsup: '^8', turbo: '^2', rimraf: '^5', eslint: '^9', prettier: '^3', 'left-pad': '^1' }
            }),
            'src/index.ts': 'export const a = 1;\n'
        });
        expect(names(findingsFor(scanRepository(dir).findings, 'DEP001'))).toEqual(['left-pad']);
    });
});

describe('DEP001: tslib with importHelpers (D2)', () => {
    it('does not report tslib when tsconfig enables importHelpers', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { tslib: '^2' } }),
            'tsconfig.json': JSON.stringify({ compilerOptions: { importHelpers: true, target: 'es2015', module: 'esnext' } }),
            'src/index.ts': 'export const a = 1;\n'
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001')).toHaveLength(0);
    });
});

describe('DEP002: framework virtual modules (D3)', () => {
    const docusaurusSources = {
        'src/pages/index.tsx': [
            `import Layout from '@theme/Layout';`,
            `import Original from '@theme-original/Footer';`,
            `import Link from '@docusaurus/Link';`,
            `import useDocusaurusContext from '@docusaurus/useDocusaurusContext';`,
            `import data from '@site/src/data';`,
            `export default [Layout, Original, Link, useDocusaurusContext, data];`
        ].join('\n')
    };

    it('does not report Docusaurus theme, site and core imports when Docusaurus is declared', () => {
        dir = makeFixture({ 'package.json': pkg({ dependencies: { '@docusaurus/core': '^3' } }), ...docusaurusSources });
        expect(findingsFor(scanRepository(dir).findings, 'DEP002')).toHaveLength(0);
    });

    it('still reports the same specifiers when Docusaurus is not declared', () => {
        dir = makeFixture({ 'package.json': pkg({}), ...docusaurusSources });
        expect(names(findingsFor(scanRepository(dir).findings, 'DEP002'))).toEqual(['@docusaurus/Link', '@docusaurus/useDocusaurusContext', '@site/src', '@theme-original/Footer', '@theme/Layout']);
    });

    it('does not report SvelteKit $app and $lib imports when SvelteKit is declared', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { '@sveltejs/kit': '^2' } }),
            'src/hooks.ts': `import { building } from '$app/environment';\nimport { x } from '$lib/x';\nexport default [building, x];\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP002')).toHaveLength(0);
    });
});

describe('DEP002: bundler and test-runner aliases (D4)', () => {
    it('honors Vite resolve.alias, including the array form', () => {
        dir = makeFixture({
            'package.json': pkg({}),
            'vite.config.ts': `export default { resolve: { alias: { '@app': '/src/app', '~': '/src' } } };\n`,
            'src/index.ts': `import { a } from '@app/a';\nimport { b } from '~/b';\nexport default [a, b];\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP002')).toHaveLength(0);
    });

    it('honors Jest moduleNameMapper and webpack alias arrays', () => {
        dir = makeFixture({
            'package.json': pkg({}),
            'jest.config.js': `module.exports = { moduleNameMapper: { '^@lib/(.*)$': '<rootDir>/src/lib/$1', '\\\\.css$': 'identity-obj-proxy' } };\n`,
            'rollup.config.mjs': `export default { plugins: [alias({ entries: [{ find: '@ui', replacement: './src/ui' }] })] , alias: [{ find: '@ui', replacement: './src/ui' }] };\n`,
            'src/index.ts': `import { a } from '@lib/a';\nimport { b } from '@ui/b';\nexport default [a, b];\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP002')).toHaveLength(0);
    });

    it('still reports an import that matches no alias', () => {
        dir = makeFixture({
            'package.json': pkg({}),
            'vite.config.ts': `export default { resolve: { alias: { '@app': '/src/app' } } };\n`,
            'src/index.ts': `import { a } from '@application/a';\nexport default a;\n`
        });
        expect(names(findingsFor(scanRepository(dir).findings, 'DEP002'))).toEqual(['@application/a']);
    });
});

describe('type-aware findings without installed dependencies (R5)', () => {
    const files = {
        'package.json': pkg({ dependencies: { express: '^4' } }),
        'src/index.ts': `export function handler(req, res) {\n    return res.send(req.body);\n}\n`
    };

    it('downgrades TS001 to LOW and warns when node_modules is missing', () => {
        dir = makeFixture({ ...files, 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }) });
        const summary = scanRepository(dir);
        const found = findingsFor(summary.findings, 'TS001');
        expect(found.length).toBeGreaterThan(0);
        expect(found.every((finding) => finding.confidence === 'LOW')).toBe(true);
        expect(summary.coverage?.warnings?.[0]).toContain('not installed');
    });

    it('keeps normal confidence and shows no warning when node_modules exists', () => {
        dir = makeFixture({ ...files, 'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }), 'node_modules/.keep': '' });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'TS001').some((finding) => finding.confidence !== 'LOW')).toBe(true);
        expect(summary.coverage?.warnings).toBeUndefined();
    });

    it('does not warn for a project that declares no dependencies', () => {
        dir = makeFixture({ 'src/index.ts': 'export const a = 1;\n' });
        expect(scanRepository(dir).coverage?.warnings).toBeUndefined();
    });
});
