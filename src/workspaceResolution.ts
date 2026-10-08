import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_EXTENSIONS, readFileSafe } from './discovery';
import { loadTsConfigFor } from './moduleResolution';
import { packageNameFromSpecifier } from './dependencyUsage';

/** Output folders a library's `exports`/`main` typically point into, mapped back to the sources they were built from. */
const BUILD_OUTPUT_EXTENSIONS = /(?:\.d\.[cm]?ts|\.[cm]?jsx?)$/;
const JS_EXTENSION = /\.[cm]?jsx?$/;

export function sourceCandidatesForBuildOutput(packageRoot: string, relativePath: string, fileSet: Set<string>): string[] {
    const normalized = relativePath.replace(/^\.\//, '').replace(/\\/g, '/');
    if (!BUILD_OUTPUT_EXTENSIONS.test(normalized)) return [];
    const withoutExtension = normalized.replace(BUILD_OUTPUT_EXTENSIONS, '');

    const config = loadTsConfigFor(packageRoot);
    const outDir = config?.options.outDir ? path.relative(packageRoot, config.options.outDir).replace(/\\/g, '/') : null;
    const rootDir = config?.options.rootDir ? path.relative(packageRoot, config.options.rootDir).replace(/\\/g, '/') : null;

    const bases = new Set<string>();
    // The project's own mapping first: <outDir>/x.js was built from <rootDir>/x.ts.
    if (outDir && withoutExtension.startsWith(`${outDir}/`)) bases.add(`${rootDir && rootDir !== '.' ? `${rootDir}/` : ''}${withoutExtension.slice(outDir.length + 1)}`);
    // Otherwise assume the conventional layout: the first folder is the output, sources live in src/ or the package root.
    const [, ...rest] = withoutExtension.split('/');
    if (rest.length > 0) {
        bases.add(`src/${rest.join('/')}`);
        bases.add(rest.join('/'));
    }
    bases.add(`src/${withoutExtension}`);
    bases.add(withoutExtension);

    const found: string[] = [];
    for (const base of bases) {
        const absolute = path.resolve(packageRoot, base);
        for (const extension of SOURCE_EXTENSIONS) {
            if (fileSet.has(absolute + extension)) found.push(absolute + extension);
            if (fileSet.has(path.join(absolute, `index${extension}`))) found.push(path.join(absolute, `index${extension}`));
        }
    }
    return found;
}

/** Directories (project root and every nested package) that contain a package.json, found by walking up from each source file. */
export function findPackageRoots(projectRoot: string, files: string[]): string[] {
    const roots = new Set<string>([projectRoot]);
    const checked = new Map<string, boolean>();
    for (const file of files) {
        for (let dir = path.dirname(file); dir.startsWith(projectRoot) && dir !== projectRoot; dir = path.dirname(dir)) {
            if (checked.has(dir)) {
                if (checked.get(dir)) break;
                continue;
            }
            const has = fs.existsSync(path.join(dir, 'package.json'));
            checked.set(dir, has);
            if (has) {
                roots.add(dir);
                break;
            }
        }
    }
    return [...roots];
}

/** Flattens an `exports` target (a path, a condition map or an array) into the paths it can resolve to. */
function targetPaths(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(targetPaths);
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(targetPaths);
    return [];
}

/** The entries of an `exports` field as subpath → target, whichever of the three allowed shapes it uses. */
function exportEntries(exportsField: unknown): Array<[string, unknown]> {
    if (typeof exportsField === 'string' || Array.isArray(exportsField)) return [['.', exportsField]];
    if (!exportsField || typeof exportsField !== 'object') return [];
    const entries = Object.entries(exportsField as Record<string, unknown>);
    return entries.some(([key]) => key.startsWith('.')) ? entries : [['.', exportsField]];
}

interface WorkspacePackage {
    root: string;
    json: Record<string, unknown>;
}

function fileCandidates(absoluteBase: string, fileSet: Set<string>): string | null {
    const withoutJs = absoluteBase.replace(JS_EXTENSION, '');
    for (const base of new Set([absoluteBase, withoutJs])) {
        if (fileSet.has(base)) return base;
        for (const extension of SOURCE_EXTENSIONS) if (fileSet.has(base + extension)) return base + extension;
        for (const extension of SOURCE_EXTENSIONS) if (fileSet.has(path.join(base, `index${extension}`))) return path.join(base, `index${extension}`);
    }
    return null;
}

function resolveTarget(pkg: WorkspacePackage, target: string, fileSet: Set<string>): string | null {
    if (!target.startsWith('./')) return null;
    return fileCandidates(path.resolve(pkg.root, target), fileSet) ?? sourceCandidatesForBuildOutput(pkg.root, target, fileSet)[0] ?? null;
}

function resolveWithinPackage(pkg: WorkspacePackage, subpath: string, fileSet: Set<string>): string | null {
    const key = subpath ? `./${subpath}` : '.';
    const entries = exportEntries(pkg.json.exports);

    for (const [pattern, value] of entries) {
        let substituted: string | null = null;
        if (pattern === key) substituted = '';
        else if (pattern.includes('*')) {
            const [prefix, suffix] = pattern.split('*');
            if (key.length >= prefix.length + suffix.length && key.startsWith(prefix) && key.endsWith(suffix)) substituted = key.slice(prefix.length, key.length - suffix.length);
        }
        if (substituted === null) continue;
        for (const target of targetPaths(value)) {
            const resolved = resolveTarget(pkg, pattern.includes('*') ? target.replace(/\*/g, substituted) : target, fileSet);
            if (resolved) return resolved;
        }
    }

    if (!subpath) {
        for (const field of ['main', 'module', 'types', 'typings']) {
            const value = pkg.json[field];
            if (typeof value === 'string') {
                const resolved = resolveTarget(pkg, value.startsWith('./') ? value : `./${value}`, fileSet);
                if (resolved) return resolved;
            }
        }
        return fileCandidates(path.join(pkg.root, 'src', 'index'), fileSet) ?? fileCandidates(path.join(pkg.root, 'index'), fileSet);
    }

    // No exports entry (or none matched): a deep import names a file inside the package, in src/ or at its root.
    return fileCandidates(path.join(pkg.root, subpath), fileSet) ?? fileCandidates(path.join(pkg.root, 'src', subpath), fileSet);
}

/**
 * Resolves `@scope/pkg` and `@scope/pkg/sub.js` to a source file when the package is a workspace member, by
 * name, `exports` map and package layout. Without installed links in `node_modules` the compiler cannot do this.
 */
export function createWorkspaceResolver(projectRoot: string, files: string[], fileSet: Set<string>): (specifier: string) => string | null {
    const byName = new Map<string, WorkspacePackage>();
    for (const root of findPackageRoots(projectRoot, files)) {
        try {
            const json = JSON.parse(readFileSafe(path.join(root, 'package.json'))) as Record<string, unknown>;
            if (typeof json.name === 'string' && !byName.has(json.name)) byName.set(json.name, { root, json });
        } catch {
            // An unreadable manifest names no workspace package.
        }
    }
    if (byName.size === 0) return () => null;

    return (specifier) => {
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
        const name = packageNameFromSpecifier(specifier);
        const pkg = byName.get(name);
        return pkg ? resolveWithinPackage(pkg, specifier.slice(name.length).replace(/^\//, ''), fileSet) : null;
    };
}
