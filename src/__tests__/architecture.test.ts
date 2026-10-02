import { afterEach, describe, expect, it } from 'vitest';
import { scanRepository } from '../scanner';
import { cleanupFixture, findingsFor, makeFixture } from './testUtils';

let dir: string | undefined;

afterEach(() => {
    if (dir) cleanupFixture(dir);
    dir = undefined;
});

const CONFIG = JSON.stringify({
    project: { name: 'fixture' },
    scan: { include: ['src/**'], exclude: [] },
    architecture: {
        layers: {
            controllers: { match: ['src/controllers/**'], cannotImport: ['database'] },
            database: { match: ['src/database/**'], cannotImport: [] }
        }
    },
    rules: {}
});

describe('architecture rules', () => {
    it('flags an import that crosses a forbidden layer boundary', () => {
        dir = makeFixture({
            '.devkitrc.json': CONFIG,
            'src/controllers/userController.ts': `import { query } from '../database/db';\nexport function getUser() { return query(); }\n`,
            'src/database/db.ts': `export function query() { return []; }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ARCH001').length).toBeGreaterThan(0);
    });

    it('does not flag imports within the same layer', () => {
        dir = makeFixture({
            '.devkitrc.json': CONFIG,
            'src/controllers/userController.ts': `import { helper } from './helper';\nexport function getUser() { return helper(); }\n`,
            'src/controllers/helper.ts': `export function helper() { return 1; }\n`,
            'src/database/db.ts': `export function query() { return []; }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ARCH001').length).toBe(0);
    });

    it('produces no architecture findings when no layers are configured', () => {
        dir = makeFixture({
            'src/controllers/userController.ts': `import { query } from '../database/db';\nexport function getUser() { return query(); }\n`,
            'src/database/db.ts': `export function query() { return []; }\n`
        });

        const summary = scanRepository(dir);
        expect(findingsFor(summary.findings, 'ARCH001').length).toBe(0);
    });
});
