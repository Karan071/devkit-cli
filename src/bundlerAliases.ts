import path from 'node:path';
import ts from 'typescript';
import { readFileSafe } from './discovery';

/**
 * Import aliases declared outside tsconfig: bundler `resolve.alias` (Vite, webpack, Rollup, Rspack, Next,
 * Nuxt, Astro), Jest's `moduleNameMapper` and Babel's `module-resolver` `alias`. An import that matches one
 * names project code, not an npm package, so it must not be reported as an unlisted dependency.
 */

const ALIAS_CONFIG_FILE = /(?:^|\/)(?:(?:vite|vitest|webpack|rollup|rspack|rsbuild|next|nuxt|astro|jest|babel|metro|craco|snowpack|svelte|vue|quasar|farm|tsup|esbuild)(?:\.[\w-]+)*\.(?:config|conf)\.[cm]?[jt]s|\.babelrc(?:\.[cm]?js|\.json)?|babel\.config\.[cm]?js|\.storybook\/main\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s)$/i;
const ALIAS_PROPERTIES = new Set(['alias', 'moduleNameMapper']);
const MAX_CONFIG_BYTES = 300_000;

/** `^@app/(.*)$` → `@app/`, `~` → `~`, `@/` → `@/`: the literal prefix an alias key stands for. */
export function aliasPrefix(key: string): string {
    const stripped = key.replace(/^\^/, '');
    const literal = stripped.match(/^[^()[\]*+?{}|\\$]*/)?.[0] ?? '';
    return literal;
}

function keyText(name: ts.PropertyName): string | undefined {
    return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

function collectAliasKeys(text: string, fileName: string, into: Set<string>): void {
    const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, fileName.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS);

    const addFrom = (value: ts.Node): void => {
        if (ts.isObjectLiteralExpression(value)) {
            for (const property of value.properties) {
                const key = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) ? keyText(property.name) : undefined;
                if (key) into.add(key);
            }
        } else if (ts.isArrayLiteralExpression(value)) {
            // Rollup/Vite array form: [{ find: '@', replacement: '/src' }]
            for (const element of value.elements) {
                if (!ts.isObjectLiteralExpression(element)) continue;
                for (const property of element.properties) {
                    if (ts.isPropertyAssignment(property) && keyText(property.name) === 'find' && ts.isStringLiteralLike(property.initializer)) into.add(property.initializer.text);
                }
            }
        }
    };

    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node)) {
            const name = keyText(node.name);
            if (name && ALIAS_PROPERTIES.has(name)) addFrom(node.initializer);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
}

export type AliasMatcher = (specifier: string) => boolean;

/** Reads the alias maps from bundler / test-runner configs and returns a predicate for import specifiers. */
export function loadBundlerAliases(projectRoot: string, files: string[]): AliasMatcher {
    const keys = new Set<string>();
    for (const file of files) {
        const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
        if (!ALIAS_CONFIG_FILE.test(relative)) continue;
        const text = readFileSafe(file);
        if (text && text.length <= MAX_CONFIG_BYTES) collectAliasKeys(text, file, keys);
    }

    const prefixes = [...keys].map(aliasPrefix).filter((prefix) => prefix.length > 0);
    if (prefixes.length === 0) return () => false;
    return (specifier) => prefixes.some((prefix) => {
        if (prefix.endsWith('/')) return specifier.startsWith(prefix);
        // `'@'` stands for `@/…`, `'~'` for `~/…` and a bare name for that name and everything under it.
        return specifier === prefix || specifier.startsWith(`${prefix}/`);
    });
}
