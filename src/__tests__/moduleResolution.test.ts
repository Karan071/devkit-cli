import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createResolutionContext, resolveSpecifier } from '../moduleResolution';
import { cleanupFixture, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('module resolution', () => {
    it('resolves extensionless relatives, index files, aliases, require and dynamic imports within scanned files', () => {
        dir = makeFixture({
            'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
            'src/main.ts': "import './plain'; import './folder'; import '@/aliased'; const c = require('./common'); import('./lazy');",
            'src/plain.ts': 'export const plain = 1;',
            'src/folder/index.ts': 'export const index = 1;',
            'src/aliased.ts': 'export const aliased = 1;',
            'src/common.ts': 'module.exports = 1;',
            'src/lazy.ts': 'export const lazy = 1;'
        });
        const files = ['src/main.ts', 'src/plain.ts', 'src/folder/index.ts', 'src/aliased.ts', 'src/common.ts', 'src/lazy.ts'].map((file) => path.join(dir!, file));
        const fileSet = new Set(files);
        const ctx = createResolutionContext(dir);
        expect(resolveSpecifier(files[0], './plain', 'import', fileSet, ctx)).toBe(files[1]);
        expect(resolveSpecifier(files[0], './folder', 'import', fileSet, ctx)).toBe(files[2]);
        expect(resolveSpecifier(files[0], '@/aliased', 'import', fileSet, ctx)).toBe(files[3]);
        expect(resolveSpecifier(files[0], './common', 'require', fileSet, ctx)).toBe(files[4]);
        expect(resolveSpecifier(files[0], './lazy', 'dynamicImport', fileSet, ctx)).toBe(files[5]);
    });

    it('does not add node_modules targets to the scanned graph and has a fallback without tsconfig', () => {
        dir = makeFixture({
            'src/main.js': "require('fixture-package');",
            'node_modules/fixture-package/package.json': JSON.stringify({ main: 'index.js' }),
            'node_modules/fixture-package/index.js': 'module.exports = 1;'
        });
        const main = path.join(dir, 'src/main.js');
        const ctx = createResolutionContext(dir);
        expect(ctx.compilerOptions.moduleResolution).toBeDefined();
        expect(resolveSpecifier(main, 'fixture-package', 'require', new Set([main]), ctx)).toBeNull();
    });
});
