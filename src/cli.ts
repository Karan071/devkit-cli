#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { writeConfig } from './config';
import { getRuleById, listRules } from './rules';
import { formatBaselineCompare, formatJson, formatMarkdown, formatMetrics, formatSarif, formatTerminal } from './reporters';
import { scanRepository } from './scanner';
import { computeScores } from './scoring';
import { Spinner, waitForNextTick } from './terminal';
import type { Severity } from './types';

async function runWithSpinner<T>(text: string, task: () => T): Promise<T> {
    const spinner = new Spinner(text);
    spinner.start();
    await waitForNextTick();
    try {
        return task();
    } finally {
        spinner.stop();
    }
}

const program = new Command();

program.name('devkit').description('Deterministic repository-quality scanner for JavaScript and TypeScript projects').version('0.1.0');

const SEVERITY_RANK: Record<Severity, number> = {
    INFO: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4
};

program
    .command('init')
    .description('Create a default DevKit config file in the current project')
    .action(() => {
        const configPath = writeConfig(process.cwd());
        console.log(`Created config at ${configPath}`);
    });

async function runScan(options: { json?: boolean; format?: string; category?: string; severity?: string; minScore?: string; failOn?: string }): Promise<boolean> {
    const summary = await runWithSpinner('Scanning repository...', () => scanRepository(process.cwd()));

    let filteredFindings = summary.findings;
    if (options.category) {
        filteredFindings = filteredFindings.filter((finding) => finding.category.toLowerCase() === options.category!.toLowerCase());
    }
    if (options.severity) {
        filteredFindings = filteredFindings.filter((finding) => finding.severity.toLowerCase() === options.severity!.toLowerCase());
    }

    const filteredSummary =
        filteredFindings.length === summary.findings.length
            ? summary
            : {
                ...summary,
                findings: filteredFindings,
                ...computeScores(filteredFindings, summary.metrics.sourceLOC)
            };

    const outputType = options.json ? 'json' : (options.format ?? 'terminal');
    const output =
        outputType === 'json'
            ? formatJson(filteredSummary)
            : outputType === 'markdown'
                ? formatMarkdown(filteredSummary)
                : outputType === 'sarif'
                    ? formatSarif(filteredSummary)
                    : formatTerminal(filteredSummary);

    console.log(output);

    let failed = false;

    if (options.minScore !== undefined) {
        const minimum = Number(options.minScore);
        if (filteredSummary.score < minimum) {
            failed = true;
        }
    }

    if (options.failOn) {
        const threshold = options.failOn.toUpperCase() as Severity;
        if (!(threshold in SEVERITY_RANK)) {
            console.error(`Unknown severity: ${options.failOn}`);
            failed = true;
        } else if (filteredFindings.some((finding) => SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold])) {
            failed = true;
        }
    }

    return failed;
}

program
    .command('scan')
    .description('Scan the current repository for code-quality issues')
    .option('--json', 'Output JSON instead of terminal text')
    .option('--format <type>', 'Output format: terminal, json, markdown, sarif')
    .option('--category <name>', 'Filter by category')
    .option('--severity <level>', 'Filter by severity')
    .option('--min-score <score>', 'Fail with exit code 1 when score falls below this threshold')
    .option('--fail-on <severity>', 'Fail with exit code 1 when any finding at or above this severity exists')
    .action(async (options) => {
        if (await runScan(options)) {
            process.exitCode = 1;
        }
    });

program
    .command('report')
    .description('Generate a detailed Markdown report of the current repository')
    .action(async () => {
        const summary = await runWithSpinner('Scanning repository...', () => scanRepository(process.cwd()));
        console.log(formatMarkdown(summary));
    });

program
    .command('metrics')
    .description('Print repository metrics for the current project')
    .action(async () => {
        const summary = await runWithSpinner('Scanning repository...', () => scanRepository(process.cwd()));
        console.log(formatMetrics(summary));
    });

program
    .command('rules')
    .description('List the available built-in rules')
    .action(() => {
        for (const rule of listRules()) {
            console.log(`${rule.id} - ${rule.title} (${rule.category})`);
        }
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
    .command('baseline <action>')
    .description('Create or compare a baseline score stored under .devkit')
    .action(async (action: string) => {
        const root = process.cwd();
        const dir = path.join(root, '.devkit');
        const baselineFile = path.join(dir, 'baseline.json');

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        if (action === 'create') {
            const summary = await runWithSpinner('Scanning repository...', () => scanRepository(root));
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
            const current = await runWithSpinner('Scanning repository...', () => scanRepository(root));
            const previousScore = Number(previousBaseline.score ?? current.score);
            console.log(formatBaselineCompare(previousScore, current.score));
            return;
        }

        console.error(`Unsupported baseline action: ${action}`);
        process.exitCode = 1;
    });

program
    .command('fix')
    .description('Preview safe automatic repairs for common, low-risk findings')
    .option('--dry-run', 'Preview changes without writing files')
    .action(async (options) => {
        const summary = await runWithSpinner('Scanning repository...', () => scanRepository(process.cwd()));
        const safeFixes = summary.findings.filter((finding) => finding.fixAvailable);
        const mode = options.dryRun ? 'dry-run preview' : 'write mode';

        console.log(`Safe fix preview (${mode})`);
        if (safeFixes.length === 0) {
            console.log('No auto-fixable findings were detected.');
            return;
        }

        for (const fix of safeFixes.slice(0, 10)) {
            console.log(`- ${fix.ruleId}: ${fix.file}:${fix.line} - ${fix.message}`);
        }
    });

program.parseAsync(process.argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
