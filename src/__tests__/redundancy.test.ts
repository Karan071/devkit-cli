import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('boolean comparison precision', () => {
    it('keeps a comparison that narrows a boolean union', () => {
        dir = makeFixture({ 'src/index.ts': `export function run(value: boolean | undefined) { return value === true; }` });
        expect(findingsFor(scanRepository(dir).findings, 'REDUNDANT001')).toHaveLength(0);
    });

    it('still flags comparisons on a plain boolean', () => {
        dir = makeFixture({ 'src/index.ts': `export function run(value: boolean) { return value === true; }` });
        expect(findingsFor(scanRepository(dir).findings, 'REDUNDANT001').length).toBeGreaterThan(0);
    });

    it('flags literal impossible conditions', () => {
        dir = makeFixture({ 'src/index.ts': `export function run() { if (false) return 1; return 0; }` });
        expect(findingsFor(scanRepository(dir).findings, 'REDUNDANT002').length).toBeGreaterThan(0);
    });
});
