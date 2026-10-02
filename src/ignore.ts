import fs from 'node:fs';
import path from 'node:path';

/**
 * Converts .gitignore-style lines into globs. A pattern with a leading or inner slash is
 * anchored to the project root (`/lib` ignores `lib/`, not `src/lib/`); a bare name matches
 * at any depth. Negations (`!pattern`) are not supported here — when the project is a git
 * repository, git itself applies .gitignore and this is only used for .devkitignore.
 */
export function loadIgnorePatterns(projectRoot: string, options: { includeGitignore?: boolean } = {}): string[] {
    const includeGitignore = options.includeGitignore ?? true;
    const patterns = new Set<string>();
    const sources = includeGitignore ? ['.gitignore', '.devkitignore'] : ['.devkitignore'];

    for (const name of sources) {
        const file = path.join(projectRoot, name);
        if (!fs.existsSync(file)) continue;
        for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#') || line.startsWith('!')) continue;
            const anchored = line.startsWith('/') || line.replace(/\/$/, '').includes('/');
            const normalized = line.replace(/^\//, '').replace(/\/$/, '');
            if (!normalized) continue;
            const prefix = anchored || normalized.startsWith('**/') ? '' : '**/';
            patterns.add(`${prefix}${normalized}`);
            patterns.add(`${prefix}${normalized}/**`);
        }
    }
    return [...patterns];
}
