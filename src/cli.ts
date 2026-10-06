#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { writeConfig } from './config';
import { getRuleById, listRules } from './rules';
import { formatBaselineCompare, formatJson, formatMarkdown, formatMetrics, formatSarif, formatTerminal } from './reporters';
import { scanRepository } from './scanner';
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

function scanWithProgress(root: string): ScanSummary {
    const progress = new ProgressRenderer();
    try {
        const summary = scanRepository(root, (update) => progress.update(update));
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
    .description('Create a default DevKit config file in the current project')
    .action(() => {
        const configPath = writeConfig(process.cwd());
        console.log(`Created config at ${configPath}`);
    });

interface ScanOptions {
    json?: boolean;
    format?: string;
    category?: string;
    severity?: string;
    minScore?: string;
    failOn?: string;
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

    const summary = scanWithProgress(resolveTarget(target));

    // Filters narrow the findings that are displayed; scores always describe the whole repository,
    // so `--category security --min-score 8` still gates on the real overall score.
    const filteredFindings = filterFindings(summary.findings, options);
    const filteredSummary = { ...summary, findings: filteredFindings };
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
    .action((target: string | undefined, options: ScanOptions) => {
        if (runScan(target, options)) {
            process.exitCode = 1;
        }
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
    .description('Preview findings marked as safe to fix')
    .action((target: string | undefined) => {
        const summary = scanWithProgress(resolveTarget(target));
        // "Safe" needs the rule to offer a fix AND enough confidence that nothing else depends on the target.
        const safeFixes = summary.findings.filter((finding) => finding.fixAvailable && (finding.confidence === 'CERTAIN' || finding.confidence === 'HIGH'));

        console.log('Safe fix preview');
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
