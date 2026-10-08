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

/**
 * Import specifiers a framework's build tool resolves itself, so they are not npm packages and need no
 * declaration. Each applies only when the framework is a declared dependency: `@site/src/x` means nothing
 * in a project that does not use Docusaurus, and an undeclared package of that name is a real problem.
 */
const VIRTUAL_MODULES: Array<{ dependency: RegExp; specifier: RegExp }> = [
    // Docusaurus: theme components and site files are aliased; `@docusaurus/Link` and friends are served by core.
    { dependency: /^@docusaurus\//, specifier: /^(?:@theme|@theme-original|@theme-init|@site|@generated|@docusaurus)(?:\/|$)/ },
    // SvelteKit: `$app/stores`, `$env/static/private`, `$lib/x`, `$service-worker`.
    { dependency: /^@sveltejs\/kit$/, specifier: /^\$(?:app|env|lib|service-worker)(?:\/|$)/ },
    // VitePress: `@theme/...` and `virtual:` modules.
    { dependency: /^vitepress$/, specifier: /^@theme(?:\/|$)/ },
    // Astro and Vite virtual modules (`astro:content`, `virtual:pwa-register`) are also caught by the scheme check.
    { dependency: /^(?:astro|vite|vitepress)$/, specifier: /^(?:astro|virtual):/ }
];

export function isFrameworkVirtualModule(specifier: string, declaredDependencies: Set<string>): boolean {
    return VIRTUAL_MODULES.some(({ dependency, specifier: pattern }) =>
        pattern.test(specifier) && [...declaredDependencies].some((declared) => dependency.test(declared)));
}
