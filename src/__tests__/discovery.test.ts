import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { filterScannedFiles, isGeneratedByContent, isGeneratedFile, walkDirectory } from '../discovery';
import { loadIgnorePatterns } from '../ignore';
import { cleanupFixture, makeFixture } from './testUtils';

let dir: string | undefined;
afterEach(() => { if (dir) cleanupFixture(dir); dir = undefined; });

describe('file discovery', () => {
    it('honors config include/exclude and gitignore/devkitignore patterns', () => {
        dir = makeFixture({
            '.devkitrc.json': JSON.stringify({ scan: { include: ['src/**'], exclude: ['src/excluded/**'] } }),
            '.gitignore': 'src/ignored.ts\n',
            '.devkitignore': 'src/private/**\n',
            'src/keep.ts': 'export const keep = 1;',
            'src/ignored.ts': 'export const ignored = 1;',
            'src/excluded/out.ts': 'export const excluded = 1;',
            'src/private/secret.ts': 'export const privateValue = 1;',
            'outside/not-included.ts': 'export const outside = 1;'
        });
        const config = loadConfig(dir);
        const result = filterScannedFiles(walkDirectory(dir), dir, config, loadIgnorePatterns(dir));
        expect(result.files.map((file) => path.relative(dir!, file).replace(/\\/g, '/'))).toEqual(['src/keep.ts']);
    });

    it('recognizes generated file content', () => {
        expect(isGeneratedByContent('// @generated\nconst x = 1;')).toBe(true);
        expect(isGeneratedByContent('const x = 1;')).toBe(false);
        expect(isGeneratedFile('src/output.ts')).toBe(false);
        expect(isGeneratedFile('src/.next/cache.js')).toBe(true);
    });
});
