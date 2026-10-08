/**
 * Clones every corpus repo at its pinned commit, scans it and stores the findings in bench/results/.
 *
 *   npm run bench:corpus              all repos
 *   npm run bench:corpus -- zod hono  only the named repos
 */
import fs from 'node:fs';
import path from 'node:path';
import { scanRepository } from '../src/scanner';
import { RESULTS_DIR, checkoutRepo, readCorpus, type CorpusResult } from './lib/corpus';

function main(): void {
    const requested = process.argv.slice(2);
    const corpus = readCorpus().filter((repo) => requested.length === 0 || requested.includes(repo.name));
    if (corpus.length === 0) throw new Error(`No corpus repo matches: ${requested.join(', ')}`);
    fs.mkdirSync(RESULTS_DIR, { recursive: true });

    for (const repo of corpus) {
        console.log(`[${repo.name}] checking out ${repo.commit.slice(0, 10)}`);
        const dir = checkoutRepo(repo);
        const started = Date.now();
        const summary = scanRepository(dir);
        const result: CorpusResult = {
            repo: repo.name,
            commit: repo.commit,
            score: summary.score,
            durationMs: Date.now() - started,
            findings: summary.findings.map(({ ruleId, severity, file, line, confidence }) => ({ ruleId, severity, file, line, confidence }))
        };
        fs.writeFileSync(path.join(RESULTS_DIR, `${repo.name}.json`), `${JSON.stringify(result)}\n`);
        console.log(`[${repo.name}] ${result.findings.length} findings, score ${summary.score.toFixed(1)}, ${(result.durationMs / 1000).toFixed(1)}s`);
    }
}

main();
