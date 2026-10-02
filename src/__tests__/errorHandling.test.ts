import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('promise handling rules', () => {
    it('flags an empty catch block', () => {
        dir = makeFixture({ 'src/index.ts': `export function run() { try { risky(); } catch (error) { } }` });
        expect(findingsFor(scanRepository(dir).findings, 'ERR001').length).toBeGreaterThan(0);
    });

    it('flags catch-and-rethrow without modification', () => {
        dir = makeFixture({ 'src/index.ts': `export function run() { try { risky(); } catch (error) { throw error; } }` });
        expect(findingsFor(scanRepository(dir).findings, 'ERR002').length).toBeGreaterThan(0);
    });

    it('detects a floating promise from a local async function', () => {
        dir = makeFixture({ 'src/index.ts': `async function save() { return 1; }\nexport function run() { save(); }` });
        expect(findingsFor(scanRepository(dir).findings, 'ERR003').length).toBeGreaterThan(0);
    });

    it('detects floating promises returned by object methods', () => {
        dir = makeFixture({ 'src/index.ts': `interface Store { save(): Promise<void> }\nexport function run(store: Store) { store.save(); }` });
        expect(findingsFor(scanRepository(dir).findings, 'ERR003').length).toBeGreaterThan(0);
    });

    it('detects floating promises from imported functions', () => {
        dir = makeFixture({
            'src/index.ts': `import { save } from './save';\nexport function run() { save(); }`,
            'src/save.ts': `export function save(): Promise<void> { return Promise.resolve(); }`
        });
        expect(findingsFor(scanRepository(dir).findings, 'ERR003').length).toBeGreaterThan(0);
    });

    it('does not flag an awaited Promise call', () => {
        dir = makeFixture({ 'src/index.ts': `async function save() { return 1; }\nexport async function run() { await save(); }` });
        expect(findingsFor(scanRepository(dir).findings, 'ERR003')).toHaveLength(0);
    });

    it('reports a terminal then-chain without catch but accepts a caught chain', () => {
        dir = makeFixture({ 'src/index.ts': `load().then(render);\nload().then(render).catch(handle);` });
        const findings = findingsFor(scanRepository(dir).findings, 'ERR004');
        expect(findings).toHaveLength(1);
        expect(findings[0].line).toBe(1);
    });
});
