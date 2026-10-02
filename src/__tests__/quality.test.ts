import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

describe('error handling rules', () => {
    it('flags an empty catch block', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() {\n    try {\n        JSON.parse('{}');\n    } catch (e) {\n    }\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ERR001').length).toBeGreaterThan(0);
    });

    it('does not flag a catch block that handles the error', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() {\n    try {\n        JSON.parse('{}');\n    } catch (e) {\n        console.error(e);\n    }\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ERR001').length).toBe(0);
    });

    it('flags a catch block that only rethrows', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() {\n    try {\n        JSON.parse('{}');\n    } catch (e) {\n        throw e;\n    }\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ERR002').length).toBeGreaterThan(0);
    });

    it('flags a floating promise for a locally declared async function', () => {
        dir = makeFixture({
            'src/index.ts': `async function save() {\n    return 1;\n}\nexport function run() {\n    save();\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ERR003').length).toBeGreaterThan(0);
    });

    it('does not flag an awaited call', () => {
        dir = makeFixture({
            'src/index.ts': `async function save() {\n    return 1;\n}\nexport async function run() {\n    await save();\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ERR003').length).toBe(0);
    });
});

describe('redundancy rules', () => {
    it('flags a redundant boolean comparison', () => {
        dir = makeFixture({
            'src/index.ts': `export function run(isValid: boolean) {\n    if (isValid === true) {\n        return 1;\n    }\n    return 0;\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'REDUNDANT001').length).toBeGreaterThan(0);
    });

    it('flags an impossible condition', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() {\n    if (false) {\n        return 1;\n    }\n    return 0;\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'REDUNDANT002').length).toBeGreaterThan(0);
    });
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
