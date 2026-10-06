import path from 'node:path';

/**
 * Files that a framework loads by location or file name, so nothing in the repo imports them.
 * Keeping these in one table (instead of inline globs) makes each framework's contract explicit and
 * lets `src/` and root layouts share the same rules.
 */
interface FrameworkConvention {
    /** Dependency whose presence turns the convention on. */
    dependency: string;
    /** Directories (relative to a source root) whose route files are loaded by the router. */
    routerDirs: string[];
    /** Base names (without extension) the router loads from anywhere inside routerDirs. */
    routerFileStems: string[];
    /** Directories where every file is a route (pages router, API routes). */
    allFilesAreEntries: string[];
    /** Base names loaded from the source root (project root or src/) by the framework itself. */
    rootFileStems: string[];
}

const CONVENTIONS: FrameworkConvention[] = [
    {
        dependency: 'next',
        routerDirs: ['app'],
        routerFileStems: [
            'page', 'layout', 'template', 'default', 'route', 'loading', 'error', 'global-error', 'not-found',
            'forbidden', 'unauthorized', 'opengraph-image', 'twitter-image', 'icon', 'apple-icon', 'sitemap', 'robots', 'manifest'
        ],
        allFilesAreEntries: ['pages'],
        rootFileStems: ['middleware', 'proxy', 'instrumentation', 'instrumentation-client', 'mdx-components']
    }
];

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|mdx)$/;

/** Source roots a framework may use: the project root and a conventional `src/` folder. */
const SOURCE_ROOTS = ['', 'src/'];

export function isFrameworkEntryFile(relativePath: string, dependencies: Set<string>): boolean {
    if (!SOURCE_EXTENSION.test(relativePath)) return false;
    const stem = path.posix.basename(relativePath).replace(SOURCE_EXTENSION, '');

    for (const convention of CONVENTIONS) {
        if (!dependencies.has(convention.dependency)) continue;

        for (const root of SOURCE_ROOTS) {
            if (!relativePath.startsWith(root)) continue;
            const inRoot = relativePath.slice(root.length);

            if (!inRoot.includes('/') && convention.rootFileStems.includes(stem)) return true;
            if (convention.allFilesAreEntries.some((dir) => inRoot.startsWith(`${dir}/`))) return true;
            if (convention.routerDirs.some((dir) => inRoot.startsWith(`${dir}/`)) && convention.routerFileStems.includes(stem)) return true;
        }
    }
    return false;
}
