import fs from 'node:fs';
import path from 'node:path';
import type { Environment } from './types';
import { readFileSafe } from './discovery';
import { findPackageRoots } from './workspaceResolution';

/** Dependencies that identify a framework or runtime, and the name to show for them. */
const FRAMEWORKS: Array<[string, string]> = [
    ['next', 'Next.js'], ['@docusaurus/core', 'Docusaurus'], ['@nestjs/core', 'NestJS'], ['@sveltejs/kit', 'SvelteKit'], ['astro', 'Astro'],
    ['nuxt', 'Nuxt'], ['@remix-run/react', 'Remix'], ['@angular/core', 'Angular'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['react', 'React'],
    ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['koa', 'Koa'], ['vite', 'Vite'], ['vitest', 'Vitest'], ['jest', 'Jest'],
    ['webpack', 'webpack'], ['storybook', 'Storybook'], ['@trpc/server', 'tRPC'], ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle']
];

const LOCKFILES: Array<[string, string]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']];

/** Workspace globs declared by package.json `workspaces` or pnpm-workspace.yaml. */
function workspaceGlobs(projectRoot: string, packageJson: Record<string, unknown> | null): string[] {
    const declared = packageJson?.workspaces;
    const fromPackage = Array.isArray(declared) ? declared : Array.isArray((declared as { packages?: unknown } | undefined)?.packages) ? (declared as { packages: unknown[] }).packages : [];
    const globs = fromPackage.filter((entry): entry is string => typeof entry === 'string');
    const pnpm = readFileSafe(path.join(projectRoot, 'pnpm-workspace.yaml'));
    if (pnpm) {
        const section = pnpm.match(/^packages:\s*\n((?:[ \t]*-[^\n]*\n?)+)/m)?.[1] ?? '';
        for (const line of section.split('\n')) {
            const value = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/)?.[1];
            if (value) globs.push(value);
        }
    }
    return [...new Set(globs)];
}

export function describeEnvironment(
    projectRoot: string,
    packageJson: Record<string, unknown> | null,
    files: string[],
    entryPoints: number,
    unresolved: string[]
): Environment {
    const packageRoots = findPackageRoots(projectRoot, files);
    const dependencies = new Set<string>();
    for (const root of packageRoots) {
        let json: Record<string, unknown> | null = null;
        try {
            json = root === projectRoot ? packageJson : (JSON.parse(readFileSafe(path.join(root, 'package.json'))) as Record<string, unknown>);
        } catch {
            json = null;
        }
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
            for (const name of Object.keys((json?.[field] as Record<string, string> | undefined) ?? {})) dependencies.add(name);
        }
    }

    const tsconfigs = files.length > 0 ? [...new Set(files.map((file) => path.dirname(file)))].filter((dir) => fs.existsSync(path.join(dir, 'tsconfig.json'))) : [];
    const rootTsconfig = fs.existsSync(path.join(projectRoot, 'tsconfig.json')) ? 'tsconfig.json' : null;
    const nested = tsconfigs.filter((dir) => dir !== projectRoot).length;

    return {
        dependenciesInstalled: fs.existsSync(path.join(projectRoot, 'node_modules')),
        packageManager: LOCKFILES.find(([file]) => fs.existsSync(path.join(projectRoot, file)))?.[1] ?? null,
        tsconfig: rootTsconfig,
        nestedTsconfigs: nested,
        packages: packageRoots.length,
        workspaceGlobs: workspaceGlobs(projectRoot, packageJson),
        frameworks: FRAMEWORKS.filter(([dependency]) => dependencies.has(dependency)).map(([, name]) => name),
        entryPoints,
        unresolvedImports: unresolved.length,
        unresolvedSample: unresolved.slice(0, 8)
    };
}
