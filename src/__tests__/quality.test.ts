import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

describe('typescript quality rules', () => {
    it('flags explicit any', () => {
        dir = makeFixture({ 'src/index.ts': `export function run(value: any) {\n    return value;\n}\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'TS001').length).toBeGreaterThan(0);
    });

    it('does not flag a concretely typed function', () => {
        dir = makeFixture({ 'src/index.ts': `export function run(value: number) {\n    return value;\n}\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'TS001').length).toBe(0);
    });

    it('flags @ts-ignore', () => {
        dir = makeFixture({
            'src/index.ts': `// @ts-ignore\nexport const value: number = "oops" as unknown as number;\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'TS002').length).toBeGreaterThan(0);
    });

    it('flags a non-null assertion', () => {
        dir = makeFixture({
            'src/index.ts': `export function run(value: string | null) {\n    return value!.length;\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'TS003').length).toBeGreaterThan(0);
    });
});

describe('javascript quality rules', () => {
    it('flags var declarations', () => {
        dir = makeFixture({ 'src/index.js': `var count = 0;\nmodule.exports = { count };\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'JS001').length).toBeGreaterThan(0);
    });

    it('flags loose equality', () => {
        dir = makeFixture({
            'src/index.ts': `export function run(value: number) {\n    return value == 0;\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'JS002').length).toBeGreaterThan(0);
    });

    it('does not flag == null', () => {
        dir = makeFixture({
            'src/index.ts': `export function run(value: unknown) {\n    return value == null;\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'JS002').length).toBe(0);
    });
});
