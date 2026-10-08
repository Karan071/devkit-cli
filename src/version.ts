import fs from 'node:fs';
import path from 'node:path';

/** The installed package's version, read from its package.json (one directory above src/ and dist/). */
export function readVersion(): string {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: unknown };
        return typeof parsed.version === 'string' ? parsed.version : 'unknown';
    } catch {
        return 'unknown';
    }
}
