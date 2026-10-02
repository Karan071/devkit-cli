import { listRules } from './rules';
import { summarizeTopDeductions } from './scoring';
import { color, pad, padStart, renderCodeFrame, renderScoreBar, scoreColor, scoreLabel, severityColor } from './terminal';
import type { ScanSummary } from './types';

const CATEGORY_LABELS: Record<string, string> = {
    deadCode: 'Dead Code',
    dependencies: 'Dependencies',
    complexity: 'Complexity',
    duplication: 'Duplication',
    redundantLogic: 'Redundant Logic',
    errorHandling: 'Error Handling',
    typescript: 'Type Safety',
    architecture: 'Architecture',
    hygiene: 'Hygiene',
    security: 'Security'
};

function humanizeCategory(category: string): string {
    return CATEGORY_LABELS[category] ?? category;
}

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };

function severityRank(severity: string): number {
    return SEVERITY_RANK[severity] ?? 0;
}

const MAX_DETAILED_FINDINGS = 6;

export function formatTerminal(summary: ScanSummary): string {
    const lines: string[] = [];

    lines.push(color.bold('DevKit Repository Scan'));
    lines.push(color.dim(summary.repository));
    lines.push('');

    lines.push(`  ${color.bold(summary.score.toFixed(1))}${color.dim('/10')}  ${scoreColor(summary.score, scoreLabel(summary.score))}`);
    lines.push(`  ${renderScoreBar(summary.score)}`);
    lines.push('');

    const categoryEntries = Object.entries(summary.categoryScores);
    const nameWidth = Math.max(...categoryEntries.map(([category]) => humanizeCategory(category).length)) + 2;
    for (const [category, score] of categoryEntries) {
        const label = pad(humanizeCategory(category), nameWidth);
        const scoreText = padStart(score.toFixed(1), 4);
        lines.push(`  ${color.dim(label)}${scoreColor(score, scoreText)}`);
    }
    const securityLabel = pad('Security', nameWidth);
    const securityScoreText = padStart(summary.securityScore.toFixed(1), 4);
    lines.push(`  ${color.dim(securityLabel)}${scoreColor(summary.securityScore, securityScoreText)} ${color.dim('(reported separately)')}`);

    lines.push('');
    lines.push(color.dim('─'.repeat(50)));

    if (summary.findings.length === 0) {
        lines.push('');
        lines.push(color.green('No findings. The repository looks clean.'));
        lines.push('');
        return lines.join('\n');
    }

    const bySeverityCount = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    for (const finding of summary.findings) {
        bySeverityCount[finding.severity] += 1;
    }
    const severitySummary = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const)
        .filter((severity) => bySeverityCount[severity] > 0)
        .map((severity) => severityColor(severity, `${bySeverityCount[severity]} ${severity.toLowerCase()}`))
        .join(color.dim(' · '));

    lines.push('');
    lines.push(`  ${color.bold(String(summary.findings.length))} findings  ${color.dim('(')}${severitySummary}${color.dim(')')}`);

    const findingsByCategory = new Map<string, typeof summary.findings>();
    for (const finding of summary.findings) {
        if (!findingsByCategory.has(finding.category)) findingsByCategory.set(finding.category, []);
        findingsByCategory.get(finding.category)!.push(finding);
    }

    lines.push('');
    const categoryCountWidth = Math.max(...[...findingsByCategory.keys()].map((category) => humanizeCategory(category).length)) + 2;
    for (const [category, categoryFindings] of [...findingsByCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const worst = categoryFindings.reduce((max, finding) => (severityRank(finding.severity) > severityRank(max.severity) ? finding : max));
        lines.push(
            `  ${pad(humanizeCategory(category), categoryCountWidth)} ${color.dim('›')} ${severityColor(worst.severity, `${categoryFindings.length} finding${categoryFindings.length === 1 ? '' : 's'}`)}`
        );
    }

    const severityRankedFindings = [...summary.findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

    // One representative per category (its worst finding) so the detail section reads as a
    // scannable cross-section of the repository rather than six variations of the same rule.
    const representativeByCategory = new Map<string, (typeof summary.findings)[number]>();
    for (const finding of severityRankedFindings) {
        if (!representativeByCategory.has(finding.category)) {
            representativeByCategory.set(finding.category, finding);
        }
    }
    const topFindings = [...representativeByCategory.values()].slice(0, MAX_DETAILED_FINDINGS);

    if (topFindings.length > 0) {
        lines.push('');
        lines.push(color.dim('─'.repeat(50)));
        lines.push('');
        lines.push(color.bold('Top issues'));
    }

    for (const finding of topFindings) {
        lines.push('');
        lines.push(`  ${color.dim(`${humanizeCategory(finding.category)}:`)} ${severityColor(finding.severity, finding.message)} ${color.dim(`[${finding.ruleId}]`)}`);
        lines.push(`  ${finding.description}`);
        lines.push(`  ${color.dim('→')} ${finding.suggestion}`);
        lines.push(`  ${color.cyan(`${finding.file}:${finding.line}`)}`);
        lines.push('');
        for (const frameLine of renderCodeFrame(summary.repository, finding.file, finding.line, finding.column, finding.severity)) {
            lines.push(frameLine);
        }
    }

    const remaining = summary.findings.length - topFindings.length;
    lines.push('');
    lines.push(color.dim('─'.repeat(50)));
    lines.push('');
    if (remaining > 0) {
        lines.push(color.dim(`  + ${remaining} more finding${remaining === 1 ? '' : 's'} not shown above.`));
    }
    lines.push(`  ${color.dim('devkit scan --format json')}      full machine-readable output`);
    lines.push(`  ${color.dim('devkit scan --category <name>')}  focus on one category`);
    lines.push(`  ${color.dim('devkit explain <RULE_ID>')}       why a rule exists and how to fix it`);
    lines.push(`  ${color.dim('devkit fix')}                    preview findings marked safe to fix`);
    lines.push('');

    return lines.join('\n');
}

export function formatJson(summary: ScanSummary): string {
    return JSON.stringify(summary, null, 2);
}

export function formatMarkdown(summary: ScanSummary): string {
    const lines: string[] = [];
    lines.push('# DevKit Scan Report');
    lines.push('');
    lines.push(`- Repository: ${summary.repository}`);
    lines.push(`- Overall score: ${summary.score.toFixed(1)} / 10`);
    lines.push(`- Security score (reported separately): ${summary.securityScore.toFixed(1)} / 10`);
    lines.push('');

    lines.push('## Category scores');
    lines.push('');
    lines.push('| Category | Score |');
    lines.push('| --- | ---: |');
    for (const [category, score] of Object.entries(summary.categoryScores)) {
        lines.push(`| ${humanizeCategory(category)} | ${score.toFixed(1)} |`);
    }

    lines.push('');
    lines.push('## Main deductions');
    lines.push('');
    const deductions = summarizeTopDeductions(summary.findings);
    if (deductions.length === 0) {
        lines.push('No deductions.');
    } else {
        for (const deduction of deductions) {
            lines.push(`- ${deduction.count} ${deduction.ruleId} finding(s) (${humanizeCategory(deduction.category)})`);
        }
    }

    lines.push('');
    lines.push('## Findings');
    lines.push('');

    if (summary.findings.length === 0) {
        lines.push('No findings.');
    } else {
        for (const finding of summary.findings) {
            lines.push(`- ${finding.ruleId}: ${finding.message} (${finding.severity}) in ${finding.file}:${finding.line}`);
        }
    }

    return lines.join('\n');
}

export function formatSarif(summary: ScanSummary): string {
    const results = summary.findings.map((finding) => ({
        ruleId: finding.ruleId,
        level: finding.severity === 'CRITICAL' || finding.severity === 'HIGH' ? 'error' : finding.severity === 'MEDIUM' ? 'warning' : 'note',
        message: {
            text: finding.message
        },
        locations: [
            {
                physicalLocation: {
                    artifactLocation: {
                        uri: finding.file
                    },
                    region: {
                        startLine: finding.line,
                        startColumn: finding.column
                    }
                }
            }
        ]
    }));

    const sarifRules = listRules().map((rule) => ({
        id: rule.id,
        name: rule.title,
        shortDescription: { text: rule.title },
        fullDescription: { text: rule.description },
        helpUri: '',
        properties: {
            category: rule.category,
            severity: rule.severity,
            confidence: rule.confidence
        }
    }));

    return JSON.stringify(
        {
            version: '2.1.0',
            $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
            runs: [
                {
                    tool: {
                        driver: {
                            name: 'DevKit',
                            rules: sarifRules
                        }
                    },
                    results
                }
            ]
        },
        null,
        2
    );
}

export function formatMetrics(summary: ScanSummary): string {
    const metrics = summary.metrics;
    const lines: string[] = [];
    lines.push(color.bold('Repository metrics'));
    lines.push(color.dim(summary.repository));
    lines.push('');
    lines.push(`  totalFiles            ${color.bold(String(metrics.totalFiles))}`);
    lines.push(`  sourceFiles           ${metrics.sourceFiles}`);
    lines.push(`  testFiles             ${metrics.testFiles}`);
    lines.push(`  totalLOC              ${metrics.totalLOC}`);
    lines.push(`  sourceLOC             ${metrics.sourceLOC}`);
    lines.push(`  testLOC               ${metrics.testLOC}`);
    lines.push(`  commentLOC            ${metrics.commentLOC}`);
    lines.push(`  functionCount         ${metrics.functionCount}`);
    lines.push(`  classCount            ${metrics.classCount}`);
    lines.push(`  dependencyCount       ${metrics.dependencyCount}`);
    lines.push(`  averageFunctionSize   ${metrics.averageFunctionSize.toFixed(1)}`);
    lines.push(`  duplicationPercentage ${metrics.duplicationPercentage.toFixed(1)}%`);
    lines.push(`  deadCodePercentage    ${metrics.deadCodePercentage.toFixed(1)}%`);
    lines.push(`  testToSourceRatio     ${metrics.testToSourceRatio.toFixed(2)}`);

    if (metrics.largestFunctions.length > 0) {
        lines.push('');
        lines.push(color.bold('Largest functions'));
        for (const fn of metrics.largestFunctions) {
            lines.push(`  ${color.cyan(fn.name)} ${color.dim(`(${fn.file})`)} - ${fn.size} lines`);
        }
    }

    if (metrics.largestFiles.length > 0) {
        lines.push('');
        lines.push(color.bold('Largest files'));
        for (const file of metrics.largestFiles) {
            lines.push(`  ${color.cyan(file.file)} - ${file.loc} lines`);
        }
    }

    return lines.join('\n');
}

export function formatBaselineCompare(previousScore: number, currentScore: number): string {
    const delta = Number((currentScore - previousScore).toFixed(1));
    const lines: string[] = [];
    lines.push(color.bold('Baseline compare'));
    lines.push(`  Previous score: ${previousScore.toFixed(1)}`);
    lines.push(`  Current score:  ${currentScore.toFixed(1)}`);
    const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
    lines.push(`  Regression:     ${delta < 0 ? color.red(deltaText) : color.green(deltaText)}`);
    return lines.join('\n');
}
