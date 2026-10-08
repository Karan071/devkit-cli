import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: 'fixture', version: '1.0.0', ...extra });
const unusedFiles = (files: Record<string, string>) => {
    dir = makeFixture(files);
    return findingsFor(scanRepository(dir).findings, 'DEAD010');
};
const paths = (findings: Array<{ file: string }>) => findings.map((finding) => finding.file).sort();

describe('DEAD010: workspace package imports (F1)', () => {
    const workspace = {
        'package.json': pkg({ private: true, workspaces: ['packages/*'] }),
        'packages/core/package.json': pkg({ name: '@acme/core', main: 'dist/index.js', exports: { '.': './dist/index.js', './sub': './dist/sub.js' } }),
        'packages/core/src/index.ts': 'export const core = 1;\n',
        'packages/core/src/sub.ts': 'export const sub = 1;\n',
        'packages/core/src/other.ts': 'export const other = 1;\n',
        'packages/core/src/orphan.ts': 'export const orphan = 1;\n'
    };

    it('follows static, dynamic and require.resolve imports of a workspace package, with or without .js', () => {
        const found = unusedFiles({
            ...workspace,
            'packages/app/package.json': pkg({ name: '@acme/app', private: true, main: 'src/main.ts' }),
            'packages/app/src/main.ts': [
                `import { core } from '@acme/core';`,
                `export async function load() {`,
                `    const sub = await import('@acme/core/sub.js');`,
                `    const path = require.resolve('@acme/core/other.js');`,
                `    return [core, sub, path];`,
                `}`
            ].join('\n')
        });
        expect(paths(found)).toEqual(['packages/core/src/orphan.ts']);
    });
});

describe('DEAD010: imports from Markdown and MDX (F2)', () => {
    it('counts import lines in .mdx and .md, but not an import shown inside a code fence', () => {
        const found = unusedFiles({
            'package.json': pkg({ private: true }),
            'src/components/InstallSnippet.tsx': 'export default function InstallSnippet() { return null; }\n',
            'src/components/Banner.tsx': 'export default function Banner() { return null; }\n',
            'src/components/Shown.tsx': 'export default function Shown() { return null; }\n',
            'docs/intro.mdx': `import InstallSnippet from '../src/components/InstallSnippet';\n\n# Intro\n\n<InstallSnippet />\n`,
            'docs/guide.md': "import Banner from '@site/src/components/Banner';\n\n```ts\nimport Shown from '../src/components/Shown';\n```\n"
        });
        expect(paths(found)).toEqual(['src/components/Shown.tsx']);
    });
});

describe('DEAD010: framework entry conventions (F3)', () => {
    it('treats Docusaurus theme, pages and sidebars as entry points', () => {
        const found = unusedFiles({
            'package.json': pkg({ private: true, dependencies: { '@docusaurus/core': '^3' } }),
            'src/theme/Footer/index.tsx': 'export default function Footer() { return null; }\n',
            'src/pages/index.tsx': 'export default function Home() { return null; }\n',
            'sidebars.ts': 'export default { docs: [] };\n',
            'src/helpers/unused.ts': 'export const helper = 1;\n'
        });
        expect(paths(found)).toEqual(['src/helpers/unused.ts']);
    });

    it('does not apply Docusaurus conventions without Docusaurus', () => {
        const found = unusedFiles({ 'package.json': pkg({ private: true }), 'src/theme/Footer/index.tsx': 'export default function Footer() { return null; }\n' });
        expect(paths(found)).toEqual(['src/theme/Footer/index.tsx']);
    });

    it('treats a NestJS main.ts and a service worker as entry points', () => {
        const found = unusedFiles({
            'package.json': pkg({ private: true, dependencies: { '@nestjs/core': '^10' } }),
            'src/main.ts': 'export const bootstrap = 1;\n',
            'public/sw.js': 'self.addEventListener("fetch", () => undefined);\n'
        });
        expect(found).toHaveLength(0);
    });
});

describe('DEAD010: barrel files (F4)', () => {
    it('does not flag a file that only re-exports', () => {
        const found = unusedFiles({
            'package.json': pkg({ private: true, main: 'src/app.ts' }),
            'src/app.ts': `import { a } from './interfaces/a';\nexport default a;\n`,
            'src/interfaces/a.ts': 'export const a = 1;\n',
            'src/interfaces/index.ts': `export * from './a';\nexport { a as alias } from './a';\n`
        });
        expect(found).toHaveLength(0);
    });

    it('still flags an unreferenced file that defines something', () => {
        const found = unusedFiles({
            'package.json': pkg({ private: true, main: 'src/app.ts' }),
            'src/app.ts': 'export default 1;\n',
            'src/helpers/index.ts': `export * from './a';\nexport const extra = 1;\n`,
            'src/helpers/a.ts': 'export const a = 1;\n'
        });
        expect(paths(found)).toEqual(['src/helpers/index.ts']);
    });
});

describe('DEAD010 and DEAD009: published packages (F5, F6)', () => {
    const library = (manifest: Record<string, unknown>) => ({
        'package.json': pkg(manifest),
        'src/index.ts': 'export const entry = 1;\n',
        'src/orphan.ts': 'export const orphan = 1;\n'
    });

    it('lowers confidence for a published package and says why', () => {
        dir = makeFixture(library({ main: 'dist/index.js', exports: { '.': './dist/index.js' }, files: ['dist'] }));
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEAD010');
        expect(finding.file).toBe('src/orphan.ts');
        expect(finding.confidence).toBe('LOW');
        expect(finding.description).toContain('published package');
    });

    it('keeps normal confidence for a private package', () => {
        dir = makeFixture(library({ private: true, main: 'dist/index.js', exports: { '.': './dist/index.js' } }));
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEAD010');
        expect(finding.confidence).toBe('MEDIUM');
    });

    it('treats every file matched by a wildcard exports pattern as public API', () => {
        dir = makeFixture({
            'package.json': pkg({ exports: { '.': './dist/index.js', './*': './dist/*.js' } }),
            'src/index.ts': 'export const entry = 1;\n',
            'src/utils/format.ts': 'export const format = 1;\n'
        });
        const findings = scanRepository(dir).findings;
        expect(findingsFor(findings, 'DEAD010')).toHaveLength(0);
        expect(findingsFor(findings, 'DEAD009')).toHaveLength(0);
    });
});

describe('DEAD010: default entry points (F7)', () => {
    it('treats src/index.ts and main.ts as entry points when no main or exports is declared', () => {
        const found = unusedFiles({
            'package.json': pkg({ private: true }),
            'src/index.ts': 'export const a = 1;\n',
            'main.ts': 'export const b = 1;\n',
            'src/other.ts': 'export const c = 1;\n'
        });
        expect(paths(found)).toEqual(['src/other.ts']);
    });

    it('does not guess an entry point when the package names one', () => {
        const found = unusedFiles({
            'package.json': pkg({ private: true, main: 'src/app.ts' }),
            'src/app.ts': 'export default 1;\n',
            'src/index.ts': 'export const a = 1;\n'
        });
        expect(paths(found)).toEqual(['src/index.ts']);
    });
});

describe('DEAD010: explanation (F8)', () => {
    it('states which checks the file failed', () => {
        const [finding] = unusedFiles({ 'package.json': pkg({ private: true, main: 'src/app.ts' }), 'src/app.ts': 'export default 1;\n', 'src/orphan.ts': 'export const o = 1;\n' });
        expect(finding.description).toContain('No other file imports it');
        expect(finding.description).toContain('"main", "exports", "bin"');
        expect(finding.description).toContain('framework entry convention');
    });
});
