import fs from 'node:fs';
import path from 'node:path';

export function loadIgnorePatterns(projectRoot: string): string[] {
    const patterns = new Set<string>();
    for (const name of ['.gitignore', '.devkitignore']) {
        const file = path.join(projectRoot, name);
        if (!fs.existsSync(file)) continue;
        for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#') || line.startsWith('!')) continue;
            const normalized = line.replace(/^\//, '').replace(/\/$/, '');
            if (!normalized) continue;
            patterns.add(normalized);
            patterns.add(`**/${normalized}`);
            patterns.add(`**/${normalized}/**`);
        }
    }
    return [...patterns];
}
