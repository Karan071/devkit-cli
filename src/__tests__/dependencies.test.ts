import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

describe('dependency hygiene', () => {
    it('flags a declared dependency that is never imported', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', dependencies: { lodash: '^4.0.0' } }),
            'src/index.ts': `export function run() { return 1; }\n`
        });

        const summary = scanRepository(dir);
        const unused = findingsFor(summary.findings, 'DEP001');
        expect(unused.some((f) => f.evidence === 'lodash')).toBe(true);
    });

    it('does not flag a dependency that is imported', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
            'src/index.ts': `import pad from 'left-pad';\nexport function run() { return pad('1', 2); }\n`
        });

        const summary = scanRepository(dir);
        const unused = findingsFor(summary.findings, 'DEP001');
        expect(unused.some((f) => f.evidence === 'left-pad')).toBe(false);
    });

    it('counts CommonJS require calls as dependency usage', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', dependencies: { 'left-pad': '^1.0.0' } }),
            'src/index.js': `const pad = require('left-pad');\nmodule.exports = pad;\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEP001').some((finding) => finding.evidence === 'left-pad')).toBe(false);
    });

    it('does not flag @types/* packages as unused', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', devDependencies: { '@types/node': '^22.0.0' } }),
            'src/index.ts': `export function run() { return 1; }\n`
        });

        const summary = scanRepository(dir);
        const unused = findingsFor(summary.findings, 'DEP001');
        expect(unused.some((f) => f.evidence === '@types/node')).toBe(false);
    });

    it('flags an import that is not declared in package.json', () => {
        dir = makeFixture({
            'src/index.ts': `import pad from 'left-pad';\nexport function run() { return pad('1', 2); }\n`
        });

        const summary = scanRepository(dir);
        const unlisted = findingsFor(summary.findings, 'DEP002');
        expect(unlisted.some((f) => f.evidence === 'left-pad')).toBe(true);
    });

    it('does not flag node builtins as unlisted', () => {
        dir = makeFixture({
            'src/index.ts': `import fs from 'node:fs';\nexport function run() { return fs.existsSync('.'); }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEP002').length).toBe(0);
    });

    it('flags a circular import between two files', () => {
        dir = makeFixture({
            'src/a.ts': `import { b } from './b';\nexport function a() { return b(); }\n`,
            'src/b.ts': `import { a } from './a';\nexport function b() { return 1; }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEP003').length).toBeGreaterThan(0);
    });

    it('does not flag acyclic imports', () => {
        dir = makeFixture({
            'src/a.ts': `import { b } from './b';\nexport function a() { return b(); }\n`,
            'src/b.ts': `export function b() { return 1; }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEP003').length).toBe(0);
    });
});

describe('workspace / monorepo dependency scoping', () => {
    it("does not flag a workspace member's own declared dependency as unlisted", () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
            'packages/api/package.json': JSON.stringify({ name: '@m/api', dependencies: { express: '^4.0.0' } }),
            'packages/api/src/index.ts': "import express from 'express';\nexport const app = express();\n"
        });
        const findings = scanRepository(dir).findings;
        expect(findingsFor(findings, 'DEP002')).toHaveLength(0);
        expect(findingsFor(findings, 'DEP001')).toHaveLength(0);
    });

    it('still flags a genuinely unlisted dependency inside a workspace member', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
            'packages/api/package.json': JSON.stringify({ name: '@m/api', dependencies: {} }),
            'packages/api/src/index.ts': "import express from 'express';\nexport const app = express();\n"
        });
        const unlisted = findingsFor(scanRepository(dir).findings, 'DEP002');
        expect(unlisted).toHaveLength(1);
        expect(unlisted[0].file).toBe('packages/api/package.json');
    });

    it('lets a workspace member use a dependency hoisted to the root', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'], dependencies: { lodash: '^4.0.0' } }),
            'packages/api/package.json': JSON.stringify({ name: '@m/api', dependencies: {} }),
            'packages/api/src/index.ts': "import lodash from 'lodash';\nexport const x = lodash;\n"
        });
        expect(findingsFor(scanRepository(dir).findings, 'DEP002')).toHaveLength(0);
    });

    it('flags an unused dependency declared inside a specific workspace member', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
            'packages/api/package.json': JSON.stringify({ name: '@m/api', dependencies: { lodash: '^4.0.0' } }),
            'packages/api/src/index.ts': 'export const x = 1;\n'
        });
        const unused = findingsFor(scanRepository(dir).findings, 'DEP001');
        expect(unused.some((f) => f.evidence === 'lodash' && f.file === 'packages/api/package.json')).toBe(true);
    });
});
