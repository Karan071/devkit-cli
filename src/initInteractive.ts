import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, type DevkitConfig } from './config';
import { matchesAnyGlob } from './glob';
import type { ScanSummary } from './types';

export interface IgnoreProposal {
    glob: string;
    reason: string;
    /** `framework`: build output the framework generates, safe by construction. `noisy`: a directory that dominates the findings, which is a judgement call. */
    kind: 'framework' | 'noisy';
}

/** Build output and caches that each framework generates, so scanning them only produces noise. */
const FRAMEWORK_OUTPUT: Array<{ framework: string; directories: string[] }> = [
    { framework: 'Docusaurus', directories: ['build', '.docusaurus'] },
    { framework: 'Storybook', directories: ['storybook-static'] },
    { framework: 'Nuxt', directories: ['.output', '.nuxt'] },
    { framework: 'SvelteKit', directories: ['.svelte-kit'] },
    { framework: 'Angular', directories: ['.angular'] },
    { framework: 'Astro', directories: ['.astro'] },
    { framework: 'Next.js', directories: ['.next', 'out'] },
    { framework: 'Vitest', directories: ['coverage'] },
    { framework: 'Jest', directories: ['coverage'] }
];

const NOISY_DIRECTORY_MIN_FINDINGS = 25;
const NOISY_DIRECTORY_MIN_SHARE = 0.1;
const MAX_NOISY_PROPOSALS = 5;

function alreadyExcluded(directory: string, excluded: string[]): boolean {
    return matchesAnyGlob(`${directory}/x`, excluded) || matchesAnyGlob(`${directory}/a/x`, excluded);
}

/** Directory prefix of a file: two segments deep for nested code, one for top-level folders (`packages/server`, `docs`). */
function directoryOf(file: string): string | null {
    const segments = file.split('/');
    if (segments.length < 2) return null;
    return segments[0] === 'packages' || segments[0] === 'apps' ? segments.slice(0, 2).join('/') : segments[0];
}

export function proposeIgnores(summary: ScanSummary, projectRoot: string, current: DevkitConfig = defaultConfig): IgnoreProposal[] {
    const proposals: IgnoreProposal[] = [];
    const taken = new Set<string>();
    const frameworks = new Set(summary.environment?.frameworks ?? []);

    for (const { framework, directories } of FRAMEWORK_OUTPUT) {
        if (!frameworks.has(framework)) continue;
        for (const directory of directories) {
            const glob = `${directory}/**`;
            if (taken.has(glob) || alreadyExcluded(directory, current.scan.exclude)) continue;
            if (!fs.existsSync(path.join(projectRoot, directory))) continue;
            taken.add(glob);
            proposals.push({ glob, kind: 'framework', reason: `${framework} build output` });
        }
    }

    const counts = new Map<string, number>();
    for (const finding of summary.findings) {
        const directory = directoryOf(finding.file);
        if (directory) counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
    const total = Math.max(summary.findings.length, 1);
    const noisy = [...counts.entries()]
        .filter(([directory, count]) => count >= NOISY_DIRECTORY_MIN_FINDINGS && count / total >= NOISY_DIRECTORY_MIN_SHARE && !alreadyExcluded(directory, current.scan.exclude) && !taken.has(`${directory}/**`))
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_NOISY_PROPOSALS);
    for (const [directory, count] of noisy) {
        proposals.push({ glob: `${directory}/**`, kind: 'noisy', reason: `${count} findings (${Math.round((count / total) * 100)}% of all)` });
    }
    return proposals;
}

/** Adds the accepted globs to `scan.exclude` in .devkitrc.json, keeping everything else already configured. */
export function writeInitConfig(projectRoot: string, accepted: string[], projectName: string): string {
    const configPath = path.join(projectRoot, '.devkitrc.json');
    let existing: Partial<DevkitConfig> = {};
    if (fs.existsSync(configPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<DevkitConfig>;
        } catch {
            throw new Error(`${configPath} is not valid JSON; fix or remove it before running init again`);
        }
    }
    const exclude = [...new Set([...(existing.scan?.exclude ?? defaultConfig.scan.exclude), ...accepted])];
    const config = {
        ...existing,
        project: { name: existing.project?.name ?? projectName },
        scan: { include: existing.scan?.include ?? defaultConfig.scan.include, ...existing.scan, exclude },
        rules: existing.rules ?? {}
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return configPath;
}

export type Ask = (question: string, defaultYes: boolean) => Promise<boolean>;

/** Walks through the proposals, asking about each one, and writes the config. `assumeYes` accepts framework output and declines the rest, without asking. */
export async function runInteractiveInit(
    projectRoot: string,
    summary: ScanSummary,
    ask: Ask,
    options: { assumeYes?: boolean; log?: (line: string) => void } = {}
): Promise<{ configPath: string; accepted: string[]; proposals: IgnoreProposal[] }> {
    const log = options.log ?? (() => undefined);
    const existing = fs.existsSync(path.join(projectRoot, '.devkitrc.json'))
        ? (JSON.parse(fs.readFileSync(path.join(projectRoot, '.devkitrc.json'), 'utf8')) as Partial<DevkitConfig>)
        : {};
    const current: DevkitConfig = { ...defaultConfig, ...existing, scan: { ...defaultConfig.scan, ...(existing.scan ?? {}) } } as DevkitConfig;
    const proposals = proposeIgnores(summary, projectRoot, current);

    const environment = summary.environment;
    if (environment) log(`Detected: ${environment.frameworks.length > 0 ? environment.frameworks.join(', ') : 'no known framework'}; ${environment.packages} package(s).`);
    if (proposals.length === 0) log('No ignores to propose.');

    const accepted: string[] = [];
    for (const proposal of proposals) {
        const framework = proposal.kind === 'framework';
        const yes = options.assumeYes ? framework : await ask(`Exclude ${proposal.glob}? (${proposal.reason}${framework ? '' : '; hides these files from every rule'})`, framework);
        if (yes) accepted.push(proposal.glob);
    }

    let projectName = 'my-project';
    try {
        const name = (JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { name?: unknown }).name;
        if (typeof name === 'string' && name) projectName = name;
    } catch {
        // No readable package.json: keep the placeholder name.
    }
    return { configPath: writeInitConfig(projectRoot, accepted, projectName), accepted, proposals };
}
