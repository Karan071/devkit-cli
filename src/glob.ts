export function globToRegExp(pattern: string): RegExp {
    let regex = '';

    for (let i = 0; i < pattern.length; i += 1) {
        const char = pattern[i];

        if (char === '*' && pattern[i + 1] === '*') {
            regex += '.*';
            i += 1;
            if (pattern[i + 1] === '/') {
                i += 1;
            }
            continue;
        }

        if (char === '*') {
            regex += '[^/]*';
            continue;
        }

        if (char === '?') {
            regex += '[^/]';
            continue;
        }

        if ('.+^${}()|[]\\'.includes(char)) {
            regex += `\\${char}`;
            continue;
        }

        regex += char;
    }

    return new RegExp(`^${regex}$`);
}

export function matchesAnyGlob(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => globToRegExp(pattern).test(value));
}
