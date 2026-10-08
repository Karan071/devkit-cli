#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { writeConfig } from './config';
import { getRuleById, listRules } from './rules';
import { formatBaselineCompare, formatDoctor, formatJson, formatMarkdown, formatMetrics, formatSarif, formatTerminal } from './reporters';
import { scanRepository, type ScanOptions as ScanEngineOptions } from './scanner';
import { isShownByDefault } from './ruleQuality';
import { changedLinesSince, filterToChanged } from './since';
import { runInteractiveInit } from './initInteractive';
import { planFixes, writeFixes } from './fixes';
import { parseAdapterList, type AdapterName } from './adapters';
import readline from 'node:readline/promises';
import { ProgressRenderer, color, pad, severityColor } from './terminal';
import { determineExitFailure, filterFindings, validateGates } from './cliLogic';
import type { ScanSummary } from './types';

function resolveTarget(target: string | undefined): string {
    const root = path.resolve(target ?? process.cwd());
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Not a directory: ${root}`);
    }
    return root;
}

function scanWithProgress(root: string, engineOptions: ScanEngineOptions = {}): ScanSummary {
    const progress = new ProgressRenderer();
    try {
        const summary = scanRepository(root, (update) => progress.update(update), engineOptions);
        const coverage = summary.coverage;
        progress.finish(coverage ? `Scanned ${coverage.analyzedFiles} source files + ${coverage.textFilesScanned} other files` : 'Scan complete');
        return summary;
    } catch (error) {
        progress.fail();
        throw error;
    }
}

const program = new Command();

program.name('devkit').description('Deterministic repository-quality scanner for JavaScript and TypeScript projects').version('0.1.0');

program
    .command('init')
    .description('Create a DevKit config file in the current project')
    .option('-i, --interactive', 'Scan the project and propose ignores based on its frameworks and its noisiest directories')
    .option('-y, --yes', 'With --interactive: accept framework build-output ignores without asking')
    .action(async (options: { interactive?: boolean; yes?: boolean }) => {
        if (!options.interactive) {
            const configPath = writeConfig(process.cwd());
            console.log(`Created config at ${configPath}`);
            return;
        }
        if (!process.stdin.isTTY && !options.yes) {
            console.error('init --interactive needs a terminal to ask questions. Use --yes to accept the framework ignores without asking.');
            process.exitCode = 1;
            return;
        }
        const root = process.cwd();
        const summary = scanWithProgress(root);
        const terminal = options.yes && !process.stdin.isTTY ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            const result = await runInteractiveInit(
                root,
                summary,
                async (question, defaultYes) => {
                    const answer = (await terminal!.question(`${question} [${defaultYes ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
                    return answer === '' ? defaultYes : answer.startsWith('y');
                },
                { assumeYes: options.yes, log: (line) => console.log(line) }
            );
            console.log(`Wrote ${result.configPath} (${result.accepted.length} ignore${result.accepted.length === 1 ? '' : 's'} added)`);
        } finally {
            terminal?.close();
        }
    });

interface ScanOptions {
    json?: boolean;
    format?: string;
    category?: string;
    severity?: string;
    minScore?: string;
    failOn?: string;
    all?: boolean;
    audit?: boolean;
    since?: string;
    with?: string;
}

const OUTPUT_FORMATS = ['terminal', 'json', 'markdown', 'sarif'];

function runScan(target: string | undefined, options: ScanOptions): boolean {
    const gateError = validateGates(options);
    if (gateError) {
        console.error(gateError);
        return true;
    }
    const outputType = options.json ? 'json' : (options.format ?? 'terminal');
    if (!OUTPUT_FORMATS.includes(outputType)) {
        console.error(`Unknown format "${outputType}". Use one of: ${OUTPUT_FORMATS.join(', ')}`);
        return true;
    }

    const root = resolveTarget(target);
    // Resolve the ref first: a typo should fail in a moment, not after a full scan.
    let changed: ReturnType<typeof changedLinesSince> | null = null;
    if (options.since) {
        try {
            changed = changedLinesSince(root, options.since);
        } catch (error) {
            console.error(`--since ${options.since}: ${error instanceof Error ? error.message : String(error)}`);
            return true;
        }
    }

    let adapters: AdapterName[] = [];
    if (options.with) {
        try {
            adapters = parseAdapterList(options.with);
        } catch (error) {
            console.error(error instanceof Error ? error.message : String(error));
            return true;
        }
    }

    // --audit also lists findings in tests, examples, benchmarks and fixtures (the score still ignores them).
    const summary = scanWithProgress(root, { ...(options.audit ? { includeNonProduction: true } : {}), adapters });

    // By default only findings worth acting on are listed; --all and --audit list everything. --since keeps the
    // findings on changed lines. Filters narrow the findings that are displayed; scores always describe the whole
    // repository, so `--category security --min-score 8` still gates on the real overall score.
    const showEverything = !!(options.all || options.audit);
    const candidates = changed ? filterToChanged(summary.findings, changed) : summary.findings;
    const listed = showEverything ? candidates : candidates.filter(isShownByDefault);
    const filteredFindings = filterFindings(listed, options);
    const filteredSummary = { ...summary, findings: filteredFindings, hiddenByDefault: candidates.length - listed.length };
    if ((options.category || options.severity) && filteredFindings.length === 0 && summary.findings.length > 0 && outputType === 'terminal') {
        console.error(color.yellow(`No findings match the filter. Categories: ${[...new Set(summary.findings.map((finding) => finding.category))].join(', ')}`));
    }

    const output =
        outputType === 'json'
            ? formatJson(filteredSummary)
            : outputType === 'markdown'
                ? formatMarkdown(filteredSummary)
                : outputType === 'sarif'
                    ? formatSarif(filteredSummary)
                    : formatTerminal(filteredSummary);

    console.log(output);

    return determineExitFailure(summary, { minScore: options.minScore }) || determineExitFailure(filteredSummary, { failOn: options.failOn });
}

program
    .command('scan [path]')
    .description('Scan a repository (default: current directory) for code-quality issues')
    .option('--json', 'Output JSON instead of terminal text')
    .option('--format <type>', 'Output format: terminal, json, markdown, sarif')
    .option('--category <name>', 'Show only one category (e.g. security, dead-code, complexity)')
    .option('--severity <level>', 'Show only one severity (critical, high, medium, low, info)')
    .option('--min-score <score>', 'Fail with exit code 1 when the overall score falls below this threshold')
    .option('--fail-on <severity>', 'Fail with exit code 1 when any shown finding is at or above this severity')
    .option('--since <ref>', 'List only findings on lines changed since this git ref (e.g. origin/main); the score still covers the whole repository')
    .option('--with <tools>', 'Also run external tools when installed and merge their findings into the score and SARIF output: gitleaks, knip (comma-separated)')
    .option('--all', 'List every finding, including low-confidence ones and rules with low measured accuracy')
    .option('--audit', 'Like --all, and also list findings in tests, examples, benchmarks and fixtures')
    .action((target: string | undefined, options: ScanOptions) => {
        if (runScan(target, options)) {
            process.exitCode = 1;
        }
    });

program
    .command('doctor [path]')
    .description('Check how well the project can be analyzed: installed dependencies, tsconfig, workspaces, frameworks, entry points, unresolved imports')
    .action((target: string | undefined) => {
        console.log(formatDoctor(scanWithProgress(resolveTarget(target))));
    });

program
    .command('report [path]')
    .description('Generate a detailed Markdown report of a repository')
    .action((target: string | undefined) => {
        console.log(formatMarkdown(scanWithProgress(resolveTarget(target))));
    });

program
    .command('metrics [path]')
    .description('Print repository metrics')
    .action((target: string | undefined) => {
        console.log(formatMetrics(scanWithProgress(resolveTarget(target))));
    });

program
    .command('rules')
    .description('List the available built-in rules')
    .action(() => {
        const rules = listRules();
        const idWidth = Math.max(...rules.map((rule) => rule.id.length)) + 2;
        const titleWidth = Math.max(...rules.map((rule) => rule.title.length)) + 2;
        let category = '';
        for (const rule of [...rules].sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id))) {
            if (rule.category !== category) {
                category = rule.category;
                console.log(`\n${color.bold(category)}`);
            }
            console.log(`  ${color.cyan(pad(rule.id, idWidth))}${pad(rule.title, titleWidth)}${severityColor(rule.severity, rule.severity.toLowerCase())}`);
        }
        console.log(color.dim(`\n${rules.length} rules · devkit explain <RULE_ID> for details`));
    });

program
    .command('explain <ruleId>')
    .description('Explain a rule by its ID')
    .action((ruleId: string) => {
        const rule = getRuleById(ruleId.toUpperCase());

        if (!rule) {
            console.error(`Unknown rule: ${ruleId}`);
            process.exitCode = 1;
            return;
        }

        console.log(`${rule.id}: ${rule.title}`);
        console.log(`Category: ${rule.category}`);
        console.log(`Severity: ${rule.severity}`);
        console.log(`Confidence: ${rule.confidence}`);
        console.log(`Description: ${rule.description}`);
        console.log(`Why it matters: ${rule.why}`);
        console.log(`Example: ${rule.example}`);
        console.log(`Fix classification: ${rule.fixClassification}`);
        if (rule.defaultThreshold !== undefined) {
            console.log(`Default threshold: ${rule.defaultThreshold}`);
        }
    });

program
    .command('baseline <action> [path]')
    .description('Create or compare a baseline score stored under .devkit')
    .action((action: string, target: string | undefined) => {
        const root = resolveTarget(target);
        const dir = path.join(root, '.devkit');
        const baselineFile = path.join(dir, 'baseline.json');

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (action === 'create') {
            const summary = scanWithProgress(root);
            fs.writeFileSync(baselineFile, JSON.stringify({ score: summary.score }, null, 2));
            console.log(`Created baseline at ${baselineFile} with score ${summary.score.toFixed(1)}`);
            return;
        }

        if (action === 'compare') {
            if (!fs.existsSync(baselineFile)) {
                console.error('No baseline exists. Run "devkit baseline create" first.');
                process.exitCode = 1;
                return;
            }

            const previousBaseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as { score?: number };
            const current = scanWithProgress(root);
            const previousScore = Number(previousBaseline.score ?? current.score);
            console.log(formatBaselineCompare(previousScore, current.score));
            return;
        }

        console.error(`Unsupported baseline action: ${action}`);
        process.exitCode = 1;
    });

program
    .command('fix [path]')
    .description('Preview, or with --write apply, the safe mechanical fixes: unused imports, console.log/debug statements, var declarations')
    .option('--write', 'Edit files in place. Each file is re-checked and left alone if a fix would add a compile error')
    .action((target: string | undefined, options: { write?: boolean }) => {
        const root = resolveTarget(target);
        const summary = scanWithProgress(root);
        const plan = planFixes(root, summary.findings);

        console.log(options.write ? 'Applying safe fixes' : 'Safe fix preview');
        if (plan.files.length === 0) {
            console.log('No auto-fixable findings were detected.');
        }
        for (const file of plan.files) {
            console.log(`${file.relativePath}`);
            for (const fix of file.fixes) console.log(`  ${fix.ruleId}  line ${fix.line}: ${fix.description}`);
        }
        for (const skipped of plan.skipped) console.log(color.dim(`skipped ${skipped.relativePath}: ${skipped.reason}`));

        const count = plan.files.reduce((total, file) => total + file.fixes.length, 0);
        if (options.write) {
            writeFixes(plan);
            console.log(`Fixed ${count} finding${count === 1 ? '' : 's'} in ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}. Review the diff and run your tests.`);
        } else if (count > 0) {
            console.log(color.dim(`${count} fix${count === 1 ? '' : 'es'} in ${plan.files.length} file${plan.files.length === 1 ? '' : 's'}. Run "devkit fix --write" to apply them.`));
        }
    });

program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
