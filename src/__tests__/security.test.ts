import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

describe('security rules', () => {
    it('flags a hardcoded secret', () => {
        dir = makeFixture({ 'src/index.ts': `export const API_KEY = "sk_live_abcdefg12345";\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC001').length).toBeGreaterThan(0);
    });

    it('flags eval usage', () => {
        dir = makeFixture({ 'src/index.ts': `export function run(code: string) {\n    return eval(code);\n}\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC002').length).toBeGreaterThan(0);
    });

    it('flags exec with a dynamically built command', () => {
        dir = makeFixture({
            'src/index.ts': `import { exec } from 'node:child_process';\nexport function run(userPath: string) {\n    exec('rm -rf ' + userPath);\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC003').length).toBeGreaterThan(0);
    });

    it('does not flag exec with a literal command', () => {
        dir = makeFixture({
            'src/index.ts': `import { exec } from 'node:child_process';\nexport function run() {\n    exec('ls -la');\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC003').length).toBe(0);
    });

    it('flags unsafe innerHTML assignment', () => {
        dir = makeFixture({
            'src/index.ts': `export function run(el: { innerHTML: string }, content: string) {\n    el.innerHTML = content;\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC004').length).toBeGreaterThan(0);
    });

    it('flags weak hash algorithms', () => {
        dir = makeFixture({
            'src/index.ts': `import { createHash } from 'node:crypto';\nexport function run(data: string) {\n    return createHash('md5').update(data).digest('hex');\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC005').length).toBeGreaterThan(0);
    });

    it('does not flag strong hash algorithms', () => {
        dir = makeFixture({
            'src/index.ts': `import { createHash } from 'node:crypto';\nexport function run(data: string) {\n    return createHash('sha256').update(data).digest('hex');\n}\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'SEC005').length).toBe(0);
    });
});
