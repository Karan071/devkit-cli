import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('finding suppressions', () => {
    it('suppresses only the next line and selected rules', () => {
        dir = makeFixture({
            'src/index.ts': `// devkit-disable-next-line HYGIENE001\nconsole.log('hidden');\nconsole.warn('visible');\n// TODO: keep this visible\n`
        });
        const findings = scanRepository(dir).findings;
        const debug = findingsFor(findings, 'HYGIENE001');
        expect(debug).toHaveLength(1);
        expect(debug[0].line).toBe(3);
        expect(findingsFor(findings, 'HYGIENE002')).toHaveLength(1);
    });

    it('supports suppressing every rule on the following line', () => {
        dir = makeFixture({ 'src/index.ts': `// devkit-disable-next-line\nconsole.log('hidden');\n` });
        expect(findingsFor(scanRepository(dir).findings, 'HYGIENE001')).toHaveLength(0);
    });
});

describe('file-level suppression', () => {
    it('suppresses a specific rule across the whole file', () => {
        dir = makeFixture({
            'src/vendored.ts': `// devkit-disable-file HYGIENE001\nexport function run() {\n    console.log('a');\n    console.log('b');\n    return 1;\n}\n`
        });
        const findings = scanRepository(dir).findings;
        expect(findingsFor(findings, 'HYGIENE001')).toHaveLength(0);
    });

    it('suppresses every rule in the file when no rule IDs are given', () => {
        dir = makeFixture({
            'src/vendored.ts': `// devkit-disable-file\nexport function run() {\n    console.log('a');\n    // TODO: fix\n    return 1;\n}\n`
        });
        const findings = scanRepository(dir).findings;
        expect(findingsFor(findings, 'HYGIENE001')).toHaveLength(0);
        expect(findingsFor(findings, 'HYGIENE002')).toHaveLength(0);
    });

    it('does not suppress other files in the same scan', () => {
        dir = makeFixture({
            'src/vendored.ts': `// devkit-disable-file\nconsole.log('a');\n`,
            'src/index.ts': `console.log('b');\n`
        });
        const findings = scanRepository(dir).findings;
        expect(findingsFor(findings, 'HYGIENE001').some((finding) => finding.file === 'src/index.ts')).toBe(true);
    });
});
