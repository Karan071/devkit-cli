import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAnyGlob } from '../glob';

describe('glob matching', () => {
    it('supports **, *, ?, and escaped regex punctuation', () => {
        expect(matchesAnyGlob('src/a/b.ts', ['src/**/*.ts'])).toBe(true);
        expect(matchesAnyGlob('src/file.ts', ['src/*.ts'])).toBe(true);
        expect(matchesAnyGlob('src/a.ts', ['src/?.ts'])).toBe(true);
        expect(globToRegExp('src/a+b.ts').test('src/a+b.ts')).toBe(true);
        expect(globToRegExp('src/a+b.ts').test('src/ab.ts')).toBe(false);
    });
});
