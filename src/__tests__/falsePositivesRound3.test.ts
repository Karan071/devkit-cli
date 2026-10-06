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
const count = (findings: Array<{ ruleId: string }>, rule: string) => findingsFor(findings, rule).length;
const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: object) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJlLXZhbHVl`;

describe('secret scan: values that are not secrets', () => {
    it('treats a demo/anon JWT as public, in example env files and in source', () => {
        const demo = jwt({ iss: 'supabase-demo', role: 'anon' });
        dir = makeFixture({
            '.env.local.example': `NEXT_PUBLIC_ANON_KEY="${demo}"\n`,
            'src/config.ts': `export const anon = '${demo}';\n`
        });
        const found = findingsFor(scanRepository(dir).findings, 'SEC001');
        expect(found.length).toBeGreaterThan(0);
        expect(found.every((f) => f.confidence === 'LOW')).toBe(true);
    });

    it('still reports a JWT whose payload does not mark it public', () => {
        dir = makeFixture({ 'src/config.ts': `export const token = '${jwt({ sub: 'user-42', role: 'admin' })}';\n` });
        const [finding] = findingsFor(scanRepository(dir).findings, 'SEC001');
        expect(finding.confidence).toBe('HIGH');
    });

    it('ignores env references, credential-less URLs and file paths assigned to credential-like names', () => {
        dir = makeFixture({
            'supabase/config.toml': `[auth]\nauth_token = "env(SUPABASE_AUTH_SMS_TWILIO_AUTH_TOKEN)"\nsecret = "env(SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET)"\n`,
            '.env': `AUTH_REDIRECT_URI="http://127.0.0.1:54321/auth/v1/callback"\n`,
            'jsr.json': `{\n  "exports": {\n    "./bearer-auth": "./src/middleware/bearer-auth/index.ts"\n  }\n}\n`
        });
        expect(count(scanRepository(dir).findings, 'SEC001')).toBe(0);
    });

    it('still reports a real secret and a URL with embedded credentials', () => {
        dir = makeFixture({
            '.env': `API_SECRET=aB3dE5gH7jK9mN1pQ3sT5vW7yZ2bD4f\nDATABASE_AUTH=postgres://admin:hunter2hunter2xyz@db.internal:5432/app\n`
        });
        expect(count(scanRepository(dir).findings, 'SEC001')).toBeGreaterThanOrEqual(1);
    });
});

describe('entry points named by configuration', () => {
    it('treats a source file named by an Nx project.json main as an entry point', () => {
        dir = makeFixture({
            'package.json': pkg({}),
            'project.json': JSON.stringify({ targets: { build: { options: { main: 'src/main.ts' } } } }),
            'src/main.ts': `console.log('start');\n`
        });
        expect(count(scanRepository(dir).findings, 'DEAD010')).toBe(0);
    });

    it('treats a file named in a non-script package.json field (prisma.seed) as an entry point', () => {
        dir = makeFixture({
            'package.json': pkg({ prisma: { seed: 'ts-node --transpile-only src/prisma/seed.ts' } }),
            'src/prisma/seed.ts': `console.log('seed');\n`
        });
        expect(count(scanRepository(dir).findings, 'DEAD010')).toBe(0);
    });

    it('treats files referenced from tool configs, CI and Dockerfiles as entry points', () => {
        dir = makeFixture({
            'package.json': pkg({}),
            'jest.config.ts': `export default { preset: './jest.preset.js' };\n`,
            'jest.preset.js': `module.exports = {};\n`,
            '.github/workflows/ci.yml': `steps:\n  - run: node scripts/release.js\n`,
            'scripts/release.js': `console.log('release');\n`,
            'Dockerfile': `FROM node:22\nCMD ["node", "server/start.js"]\n`,
            'server/start.js': `console.log('up');\n`
        });
        expect(count(scanRepository(dir).findings, 'DEAD010')).toBe(0);
    });

    it('still reports a file that nothing references', () => {
        dir = makeFixture({ 'package.json': pkg({ main: 'src/index.ts' }), 'src/index.ts': `export const a = 1;\n`, 'src/orphan.ts': `export const b = 2;\n` });
        expect(findingsFor(scanRepository(dir).findings, 'DEAD010').map((f) => f.file)).toEqual(['src/orphan.ts']);
    });

    it('does not report scaffolds and type-test folders as dead code', () => {
        dir = makeFixture({
            'package.json': pkg({ main: 'src/index.ts' }),
            'src/index.ts': `export const a = 1;\n`,
            'packages/create-app/template-react/src/main.tsx': `export const App = () => null;\n`,
            'src/__tests_dts__/api.ts': `export const check = 1;\n`
        });
        expect(count(scanRepository(dir).findings, 'DEAD010')).toBe(0);
    });
});

describe('dependency evidence from data configs, short names and lockfiles', () => {
    it('counts packages listed in nx.json and other data configs', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { '@nx/esbuild': '^20', '@nx/js': '^20' } }),
            'nx.json': JSON.stringify({ plugins: [{ plugin: '@nx/esbuild/plugin' }, '@nx/js'] }),
            'src/index.ts': `export const a = 1;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('resolves tool shorthand names in eslint config to eslint-config-*/eslint-plugin-* packages', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { eslint: '^9', 'eslint-config-next': '^15', 'eslint-config-prettier': '^9', 'eslint-plugin-react': '^7', 'eslint-plugin-unused': '^1' } }),
            '.eslintrc.json': JSON.stringify({ extends: ['next/core-web-vitals', 'plugin:react/recommended', 'prettier'] }),
            'src/index.ts': `export const a = 1;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual(['eslint-plugin-unused']);
    });

    it('counts tslib when the compiler imports helpers', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { tslib: '^2' } }),
            'tsconfig.json': JSON.stringify({ compilerOptions: { importHelpers: true } }),
            'src/index.ts': `export const a = 1;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('reads peer dependencies from package-lock.json when node_modules is absent', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { next: '^15', 'react-dom': '^19' } }),
            'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/next': { version: '15.0.0', peerDependencies: { 'react-dom': '^19' } }, 'node_modules/react-dom': { version: '19.0.0' } } }),
            'src/index.ts': `import next from 'next';\nexport default next;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('reads peer dependencies and executables from pnpm-lock.yaml', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { next: '^15', 'react-dom': '^19' }, devDependencies: { typescript: '^5' }, scripts: { build: 'tsc -p .' } }),
            'pnpm-lock.yaml': `lockfileVersion: '9.0'\n\npackages:\n\n  next@15.0.0(react-dom@19.0.0):\n    resolution: {integrity: sha512-x}\n    peerDependencies:\n      react-dom: ^19\n      sass: ^1\n    peerDependenciesMeta:\n      sass:\n        optional: true\n\n  typescript@5.6.0:\n    resolution: {integrity: sha512-y}\n    hasBin: true\n\nsnapshots:\n  next@15.0.0: {}\n`,
            'src/index.ts': `import next from 'next';\nexport default next;\n`
        });
        // react-dom is explained by next's peers. typescript stays reported: pnpm records only `hasBin: true`, not that the
        // executable is called `tsc`, so the tool cannot prove it unused and must not offer to remove it.
        const found = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(found.map((f) => f.evidence)).toEqual(['typescript']);
        expect(found[0].fixAvailable).toBe(false);
    });

    it('treats an unused package that the lockfile describes as verified (HIGH, fixable)', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { lodash: '^4' } }),
            'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.21' } } }),
            'src/index.ts': `export const a = 1;\n`
        });
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(finding.confidence).toBe('HIGH');
        expect(finding.fixAvailable).toBe(true);
    });

    it('does not check dependencies of playground, example and fixture packages', () => {
        dir = makeFixture({
            'package.json': pkg({}),
            'playground/resolve/package.json': pkg({ name: 'resolve-fixture', dependencies: { 'test-dep': '^1', normalize: '^1' } }),
            'playground/resolve/index.ts': `export const a = 1;\n`
        });
        expect(count(scanRepository(dir).findings, 'DEP001')).toBe(0);
    });
});

describe('tool extensions are matched by namespace and never auto-fixable', () => {
    it('matches scoped plugin namespaces, tool-implied families and environment shorthands', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { '@stylistic/eslint-plugin': '^5', '@nx/node': '^17', 'jest-environment-node': '^29' } }),
            'eslint.config.js': `export default [{ rules: { '@stylistic/indent-binary-ops': ['error', 2] } }];\n`,
            'nx.json': JSON.stringify({ targetDefaults: {} }),
            'jest.config.ts': `export default { testEnvironment: 'node' };\n`,
            'src/index.ts': `export const a = 1;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP001').map((f) => f.evidence)).toEqual([]);
    });

    it('keeps an unreferenced plugin reported but never offers to remove it', () => {
        dir = makeFixture({
            'package.json': pkg({ devDependencies: { 'eslint-plugin-react': '^7', '@typescript-eslint/parser': '^8' } }),
            'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/eslint-plugin-react': {}, 'node_modules/@typescript-eslint/parser': {} } }),
            'src/index.ts': `export const a = 1;\n`
        });
        const found = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(found.map((f) => f.evidence).sort()).toEqual(['@typescript-eslint/parser', 'eslint-plugin-react']);
        expect(found.every((f) => f.confidence === 'MEDIUM' && !f.fixAvailable)).toBe(true);
    });
});

describe('duplicate detection ignores type-level syntax', () => {
    const generics = (name: string) => {
        const params = Array.from({ length: 12 }, (_, i) => `    E${i + 2} extends Env = IntersectNonAnyTypes<[E, E2, E3, E4, E5, E${i + 2}]>,`).join('\n');
        const overloads = Array.from({ length: 4 }, (_, i) => `    <P extends string = any, ${'R'.repeat(i + 1)} extends HandlerResponse<any> = any>(path: P, handler: H<${'R'.repeat(i + 1)}>): Hono<E, S, B>;`).join('\n');
        return `export interface ${name}<E extends Env = Env> {\n${overloads}\n}\nexport type Factory${name}<\n    E extends Env = Env,\n${params}\n> = (handler: Handler) => Handler;\nexport const ${name.toLowerCase()} = 1;\n`;
    };

    it('reports nothing for repeated overload signatures and generic parameter lists', () => {
        dir = makeFixture({ 'src/a.ts': generics('Alpha'), 'src/b.ts': generics('Beta'), 'src/c.ts': generics('Gamma') });
        expect(count(scanRepository(dir).findings, 'DUP001')).toBe(0);
    });

    it('still reports copy-pasted logic', () => {
        const body = (n: string) => `export function ${n}(items: number[]) {\n    const result: number[] = [];\n    for (let index = 0; index < items.length; index += 1) {\n        const value = items[index] * 2 + 1;\n        if (value % 3 === 0) { result.push(value); } else { result.push(value - 1); }\n    }\n    return result.filter((entry) => entry > 10).map((entry) => entry * entry);\n}\n`;
        dir = makeFixture({ 'src/a.ts': body('first'), 'src/b.ts': body('second') });
        expect(count(scanRepository(dir).findings, 'DUP001')).toBeGreaterThan(0);
    });
});

describe('lockfile helpers do not break when files are malformed', () => {
    it('survives a corrupt package-lock.json and an empty pnpm-lock.yaml', () => {
        dir = makeFixture({
            'package.json': pkg({ dependencies: { lodash: '^4' } }),
            'package-lock.json': '{ not json',
            'pnpm-lock.yaml': '',
            'src/index.ts': `export const a = 1;\n`
        });
        const [finding] = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(finding.confidence).toBe('MEDIUM');
        expect(fs.existsSync(path.join(dir, 'package-lock.json'))).toBe(true);
    });
});
