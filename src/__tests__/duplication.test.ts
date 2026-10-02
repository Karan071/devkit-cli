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

    it('recognizes duplicate blocks after local identifiers are renamed', () => {
        const makeBlock = (prefix: string) => Array.from({ length: 50 }, (_, i) => `    ${prefix}Total = ${prefix}Total + ${prefix}Value * ${i} - ${prefix}Offset;`).join('\n');
        dir = makeFixture({
            'src/a.ts': `export function computeA(aTotal: number, aValue: number, aOffset: number) {\n${makeBlock('a')}\n    return aTotal;\n}`,
            'src/b.ts': `export function computeB(bTotal: number, bValue: number, bOffset: number) {\n${makeBlock('b')}\n    return bTotal;\n}`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DUP001').length).toBeGreaterThan(0);
    });
});

describe('duplication false positives', () => {
    it('does not report shared import headers as duplicated code', () => {
        const imports = Array.from({ length: 12 }, (_, i) => `import { helper${i}, other${i} } from './module${i}';`).join('\n');
        dir = makeFixture({
            'src/a.ts': `${imports}\nexport const a = 1;\n`,
            'src/b.ts': `${imports}\nexport const b = 2;\n`
        });
        expect(findingsFor(scanRepository(dir).findings, 'DUP001')).toHaveLength(0);
    });
});
