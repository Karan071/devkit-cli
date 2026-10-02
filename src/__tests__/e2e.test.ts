import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const BLOCK = Array.from({ length: 50 }, (_, i) => `    total = total + value${i} * ${i} - offset${i};`).join('\n');

describe('end-to-end: no hardcoded category scores', () => {
    it('scores complexity, duplication, and deadCode below 10 when real problems exist', () => {
        const branches = Array.from({ length: 20 }, (_, i) => `    if (x === ${i}) { y += ${i}; }`).join('\n');

        dir = makeFixture({
            'src/messy.ts': `export function branchy(x: number) {\n    let y = 0;\n${branches}\n    return y;\n}\n`,
            'src/dupA.ts': `export function computeA(total: number) {\n${BLOCK}\n    return total;\n}\n`,
            'src/dupB.ts': `export function computeB(total: number) {\n${BLOCK}\n    return total;\n}\n`,
            'src/orphan.ts': `export function neverUsed() { return 1; }\n`
        });

        const summary = scanRepository(dir);

        expect(summary.categoryScores.complexity).toBeLessThan(10);
        expect(summary.categoryScores.duplication).toBeLessThan(10);
        expect(summary.categoryScores.deadCode).toBeLessThan(10);
    });

    it('scores every category a perfect 10 for genuinely clean code', () => {
        dir = makeFixture({
            'package.json': JSON.stringify({ name: 'fixture', main: 'src/index.ts' }),
            'src/index.ts': `export function add(a: number, b: number): number {\n    return a + b;\n}\n`
        });

        const summary = scanRepository(dir);

        for (const [category, score] of Object.entries(summary.categoryScores)) {
            expect(score, `expected ${category} to be 10`).toBe(10);
        }
        expect(summary.score).toBe(10);
    });
});
