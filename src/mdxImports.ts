const MDX_IMPORT = /^\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"\n]+)['"]/;

/** Module specifiers of the top-level `import` lines of an MDX document, ignoring code fences that merely show an import. */
export function mdxImportSpecifiers(text: string): string[] {
    const specifiers: string[] = [];
    let fence: string | null = null;
    for (const line of text.split(/\r\n|\r|\n/)) {
        const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
        if (marker) {
            if (fence === null) fence = marker[0];
            else if (marker[0] === fence) fence = null;
            continue;
        }
        if (fence !== null) continue;
        const specifier = line.match(MDX_IMPORT)?.[1];
        if (specifier) specifiers.push(specifier);
    }
    return specifiers;
}
