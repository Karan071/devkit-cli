import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { BenchFinding } from './scoring';

export const BENCH_DIR = path.resolve(__dirname, '..');
export const CACHE_DIR = path.join(BENCH_DIR, '.cache');
export const RESULTS_DIR = path.join(BENCH_DIR, 'results');
export const LABELS_DIR = path.join(BENCH_DIR, 'labels');

export interface CorpusRepo {
    name: string;
    url: string;
    /** Full commit SHA: results must not drift as upstream moves. */
    commit: string;
    kind: string;
}

export interface CorpusResult {
    repo: string;
    commit: string;
    score: number;
    durationMs: number;
    findings: BenchFinding[];
}

export function readCorpus(): CorpusRepo[] {
    const { repos } = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'corpus.json'), 'utf8')) as { repos: CorpusRepo[] };
    for (const repo of repos) {
        if (!/^[0-9a-f]{40}$/.test(repo.commit)) throw new Error(`corpus.json: "${repo.name}" must be pinned to a full 40-character commit SHA`);
    }
    return repos;
}

const git = (cwd: string, args: string[], quiet = false): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'inherit'] });

/** Fetches exactly the pinned commit (no history) into bench/.cache/<name>; a no-op when it is already checked out. */
export function checkoutRepo(repo: CorpusRepo): string {
    const dir = path.join(CACHE_DIR, repo.name);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) {
        git(dir, ['init', '--quiet']);
        git(dir, ['remote', 'add', 'origin', repo.url]);
    }
    let head = '';
    try {
        head = git(dir, ['rev-parse', 'HEAD'], true).trim();
    } catch {
        head = '';
    }
    if (head !== repo.commit) {
        git(dir, ['fetch', '--quiet', '--depth', '1', 'origin', repo.commit]);
        git(dir, ['checkout', '--quiet', '--force', repo.commit]);
    }
    return dir;
}

export function readResults(): Record<string, CorpusResult> {
    const results: Record<string, CorpusResult> = {};
    if (!fs.existsSync(RESULTS_DIR)) return results;
    for (const name of fs.readdirSync(RESULTS_DIR).filter((file) => file.endsWith('.json')).sort()) {
        const result = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, name), 'utf8')) as CorpusResult;
        results[result.repo] = result;
    }
    return results;
}
