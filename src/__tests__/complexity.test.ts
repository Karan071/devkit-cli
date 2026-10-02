import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

function branchyFunction(branches: number): string {
    const lines = Array.from({ length: branches }, (_, i) => `    if (x === ${i}) { y += ${i}; }`);
    return `export function branchy(x: number) {\n    let y = 0;\n${lines.join('\n')}\n    return y;\n}\n`;
}

describe('complexity detection', () => {
    it('flags a function exceeding the cyclomatic complexity threshold', () => {
        dir = makeFixture({ 'src/index.ts': branchyFunction(15) });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'COMPLEX001').length).toBeGreaterThan(0);
    });

    it('does not flag a simple function', () => {
        dir = makeFixture({ 'src/index.ts': `export function add(a: number, b: number) {\n    return a + b;\n}\n` });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'COMPLEX001').length).toBe(0);
        expect(findingsFor(summary.findings, 'COMPLEX002').length).toBe(0);
    });

    it('flags excessive nesting depth', () => {
        dir = makeFixture({
            'src/index.ts': `export function nested(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {\n` +
                `    if (a) {\n        if (b) {\n            if (c) {\n                if (d) {\n                    if (e) {\n                        return 1;\n                    }\n                }\n            }\n        }\n    }\n    return 0;\n}\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'COMPLEX005').length).toBeGreaterThan(0);
    });

    it('flags too many parameters', () => {
        dir = makeFixture({
            'src/index.ts': `export function many(a: number, b: number, c: number, d: number, e: number, f: number) {\n    return a + b + c + d + e + f;\n}\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'COMPLEX004').length).toBeGreaterThan(0);
    });

    it('flags a function longer than the configured max lines', () => {
        const body = Array.from({ length: 110 }, (_, i) => `    const v${i} = ${i};`).join('\n');
        dir = makeFixture({ 'src/index.ts': `export function long() {\n${body}\n    return 1;\n}\n` });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'COMPLEX003').length).toBeGreaterThan(0);
    });
});
