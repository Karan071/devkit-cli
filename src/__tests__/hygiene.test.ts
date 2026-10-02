import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

describe('hygiene rules', () => {
    it('flags a console.log statement', () => {
        dir = makeFixture({ 'src/index.ts': `export function run() {\n    console.log('debug');\n    return 1;\n}\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'HYGIENE001').length).toBeGreaterThan(0);
    });

    it('flags a TODO marker', () => {
        dir = makeFixture({ 'src/index.ts': `// TODO: finish this\nexport function run() {\n    return 1;\n}\n` });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'HYGIENE002').length).toBeGreaterThan(0);
    });

    it('does not match console calls or TODO markers inside string literals', () => {
        dir = makeFixture({ 'src/index.ts': `const example = "console.log('debug')";\nconst marker = 'TODO';\nconst debuggerText = 'debugger;';` });
        const findings = scanRepository(dir).findings;
        expect(findingsFor(findings, 'HYGIENE001')).toHaveLength(0);
        expect(findingsFor(findings, 'HYGIENE002')).toHaveLength(0);
    });

    it('flags a committed backup file', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() { return 1; }\n`,
            'src/index.ts.bak': `export function run() { return 1; }\n`
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'HYGIENE003').length).toBeGreaterThan(0);
    });

    it('flags a committed .env file', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() { return 1; }\n`,
            '.env': 'SECRET=abc123'
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'HYGIENE004').length).toBeGreaterThan(0);
    });

    it('does not flag .env.example', () => {
        dir = makeFixture({
            'src/index.ts': `export function run() { return 1; }\n`,
            '.env.example': 'SECRET='
        });
        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'HYGIENE004').length).toBe(0);
    });
});
