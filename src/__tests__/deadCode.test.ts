import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

describe('dead code detection', () => {
    it('flags an unused import', () => {
        dir = makeFixture({
            'src/index.ts': `import { readFileSync } from 'node:fs';\nexport function run() { return 1; }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEAD002').length).toBeGreaterThan(0);
    });

    it('does not flag a used import', () => {
        dir = makeFixture({
            'src/index.ts': `import { readFileSync } from 'node:fs';\nexport function run() { return readFileSync('x', 'utf8'); }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEAD002').length).toBe(0);
    });

    it('flags an unused local variable', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() {\n    const unused = 42;\n    return 1;\n}\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEAD003').length).toBeGreaterThan(0);
    });

    it('flags an export that no other file imports', () => {
        dir = makeFixture({
            'src/index.ts': `export function entry() { return 1; }\n`,
            'src/unused.ts': `export function neverImported() { return 2; }\n`
        });

        const summary = scanRepository(dir);
        const unusedExports = findingsFor(summary.findings, 'DEAD009');
        expect(unusedExports.some((f) => f.evidence === 'neverImported')).toBe(true);
    });

    it('does not flag an export that is imported elsewhere', () => {
        dir = makeFixture({
            'src/index.ts': `import { helper } from './helper';\nexport function entry() { return helper(); }\n`,
            'src/helper.ts': `export function helper() { return 1; }\n`
        });

        const summary = scanRepository(dir);
        const unusedExports = findingsFor(summary.findings, 'DEAD009');
        expect(unusedExports.some((f) => f.evidence === 'helper')).toBe(false);
    });

    it('flags a file nothing imports as unused', () => {
        dir = makeFixture({
            'src/index.ts': `export function entry() { return 1; }\n`,
            'src/orphan.ts': `export function orphanFn() { return 2; }\n`
        });

        const summary = scanRepository(dir);
        const unusedFiles = findingsFor(summary.findings, 'DEAD010');
        expect(unusedFiles.some((f) => f.file === 'src/orphan.ts')).toBe(true);
    });

    it('flags unreachable statements after a return', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() {\n    return 1;\n    console.log('never');\n}\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEAD011').length).toBeGreaterThan(0);
    });

    it('does not flag reachable code', () => {
        dir = makeFixture({
            'src/index.ts': `export function run(flag: boolean) {\n    if (flag) {\n        return 1;\n    }\n    return 2;\n}\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DEAD011').length).toBe(0);
    });
});
