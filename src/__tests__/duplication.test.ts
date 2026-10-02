import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const BLOCK = Array.from({ length: 50 }, (_, i) => `    total = total + value${i} * ${i} - offset${i};`).join('\n');

describe('duplication detection', () => {
    it('flags an identical block copy-pasted into two files', () => {
        dir = makeFixture({
            'src/a.ts': `export function computeA(total: number) {\n${BLOCK}\n    return total;\n}\n`,
            'src/b.ts': `export function computeB(total: number) {\n${BLOCK}\n    return total;\n}\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DUP001').length).toBeGreaterThan(0);
    });

    it('does not flag unrelated small files', () => {
        dir = makeFixture({
            'src/a.ts': `export function computeA(total: number) {\n    return total + 1;\n}\n`,
            'src/b.ts': `export function computeB(total: number) {\n    return total - 1;\n}\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'DUP001').length).toBe(0);
    });
});
