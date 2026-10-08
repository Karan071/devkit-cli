/**
 * Scores the scanner against the benchmark: catch rate on the seeded repo and per-rule accuracy from
 * the seeded decoys plus the hand-labeled corpus findings.
 *
 *   npm run bench                         print the Markdown report
 *   npm run bench -- --json out.json      also write structured JSON
 *   npm run bench -- --markdown out.md    also write the Markdown report
 *   npm run bench:check                   exit 1 on a missed planted issue or a >2 point accuracy drop
 *   npm run bench -- --update-baseline    record current accuracy as the new baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { listRules } from '../src/rules';
import { scanRepository } from '../src/scanner';
import { LABELS_DIR, readResults } from './lib/corpus';
import { SEEDED_DIR, materializeSeeded } from './lib/seeded';
import { checkGate, evaluate, formatMarkdown, readExpectations, readLabels, toBaseline, type Baseline, type BenchFinding } from './lib/scoring';

const BASELINE_PATH = path.resolve(__dirname, 'baseline.json');

function option(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

function scanSeeded(): BenchFinding[] {
    const dir = materializeSeeded();
    try {
        return scanRepository(dir).findings.map(({ ruleId, file, line, confidence }) => ({ ruleId, file, line, confidence }));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function main(): void {
    const { expectations, lines } = readExpectations(SEEDED_DIR);
    const results = readResults();
    const report = evaluate({
        ruleIds: listRules().map((rule) => rule.id),
        seededFindings: scanSeeded(),
        expectations,
        markerLines: lines,
        corpusFindings: Object.fromEntries(Object.values(results).map((result) => [result.repo, result.findings])),
        labels: readLabels(LABELS_DIR)
    });

    const baseline: Baseline | null = fs.existsSync(BASELINE_PATH) ? (JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Baseline) : null;
    const gate = checkGate(report, baseline);
    const markdown = formatMarkdown(report, baseline);

    const jsonPath = option('--json');
    const markdownPath = option('--markdown');
    if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify({ report, gate }, null, 2)}\n`);
    if (markdownPath) fs.writeFileSync(markdownPath, markdown);

    console.log(markdown);
    if (process.argv.includes('--update-baseline')) {
        fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(toBaseline(report), null, 2)}\n`);
        console.log(`Baseline written to ${path.relative(process.cwd(), BASELINE_PATH)}`);
        return;
    }

    for (const warning of gate.warnings) console.warn(`warning: ${warning}`);
    if (process.argv.includes('--check')) {
        for (const failure of gate.failures) console.error(`FAIL: ${failure}`);
        if (!gate.ok) process.exitCode = 1;
        else console.log('Benchmark gate passed.');
    }
}

main();
