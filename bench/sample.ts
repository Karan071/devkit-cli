/**
 * Draws a reproducible sample of findings to label by hand (B2). For each rule it writes up to N
 * findings per repo to bench/labels/<repo>.todo.jsonl with `verdict: null`. Move the lines you have
 * judged into bench/labels/<repo>.jsonl with `verdict` set to true (real issue) or false (false
 * positive) and a short `reason`.
 *
 *   npm run bench:sample -- 30
 */
import fs from 'node:fs';
import path from 'node:path';
import { LABELS_DIR, readResults } from './lib/corpus';
import { readLabels } from './lib/scoring';
import { sampleFindings } from './lib/sample';

function main(): void {
    const perRule = Number(process.argv[2] ?? 30);
    if (!Number.isInteger(perRule) || perRule < 1) throw new Error('Usage: bench:sample [findingsPerRule]');
    const results = Object.values(readResults());
    if (results.length === 0) throw new Error('No results found. Run "npm run bench:corpus" first.');

    fs.mkdirSync(LABELS_DIR, { recursive: true });
    const labels = readLabels(LABELS_DIR);
    for (const result of results) {
        const done = new Set(labels.filter((label) => label.repo === result.repo).map((label) => `${label.rule}|${label.file}|${label.line}`));
        const picked = sampleFindings(result.findings.filter((finding) => !done.has(`${finding.ruleId}|${finding.file}|${finding.line}`)), perRule);
        const rows = picked.map((finding) => JSON.stringify({ repo: result.repo, rule: finding.ruleId, file: finding.file, line: finding.line, verdict: null, reason: '' }));
        const target = path.join(LABELS_DIR, `${result.repo}.todo.jsonl`);
        fs.writeFileSync(target, rows.length > 0 ? `${rows.join('\n')}\n` : '');
        console.log(`${result.repo}: ${rows.length} findings to label -> ${path.relative(process.cwd(), target)}`);
    }
}

main();
