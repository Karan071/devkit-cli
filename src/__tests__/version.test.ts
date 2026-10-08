import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readVersion } from '../version';

describe('readVersion', () => {
    it('reports the version in package.json, so --version cannot drift from a release', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string };
        expect(readVersion()).toBe(manifest.version);
        expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });
});
