import { getRuleById, listRules } from './rules';
import { SECURITY_CAP, summarizeHotspots } from './scoring';
import {
    color,
    formatDuration,
    glyph,
    pad,
    padStart,
    renderBox,
    renderCodeFrame,
    renderScoreBar,
    renderStackedBar,
    scoreColor,
    scoreGrade,
    scoreLabel,
    sectionHeading,
    severityBadge,
    severityColor,
    terminalWidth,
    truncateMiddle
} from './terminal';
import type { Confidence, Environment, Finding, ScanSummary, Severity } from './types';

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

const CONFIDENCE_RANK: Record<Confidence, number> = { CERTAIN: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

function confidenceRank(confidence: Confidence): number {
    return CONFIDENCE_RANK[confidence] ?? 0;
}

const MAX_DETAILED_FINDINGS = 6;
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

const INSTALL_COMMAND: Record<string, string> = { pnpm: 'pnpm install', yarn: 'yarn install', npm: 'npm install', bun: 'bun install' };

/** One line for the scan header: the project facts that decide how much to trust the findings. */
function environmentLine(environment: Environment): string {
    const parts = [
        environment.dependenciesInstalled ? 'dependencies installed' : 'dependencies NOT installed',
        environment.tsconfig ? `${environment.tsconfig}${environment.nestedTsconfigs > 0 ? ` +${environment.nestedTsconfigs} nested` : ''}` : 'no tsconfig.json',
        plural(environment.packages, 'package'),
        ...(environment.frameworks.length > 0 ? [environment.frameworks.slice(0, 4).join(', ')] : []),
        `${plural(environment.entryPoints, 'entry point')}`,
        `${environment.unresolvedImports} unresolved import${environment.unresolvedImports === 1 ? '' : 's'}`
    ];
    return parts.join(` ${glyph.bullet} `);
}

export function formatDoctor(summary: ScanSummary): string {
    const environment = summary.environment;
    const width = terminalWidth();
    const lines: string[] = [...renderBox([`${color.bold(color.cyan('DevKit'))} ${color.dim(glyph.bullet)} ${color.bold('Project doctor')}`, color.dim(truncateMiddle(displayPath(summary.repository), width - 6))], width), ''];
    if (!environment) return [...lines, '  No environment information was collected.', ''].join('\n');

    const row = (label: string, status: string, detail = ''): void => { lines.push(`  ${color.dim(pad(label, 14))}${status}${detail ? `  ${color.dim(detail)}` : ''}`); };
    const ok = (text: string) => color.green(`${glyph.check} ${text}`);
    const warn = (text: string) => color.yellow(`${glyph.warn} ${text}`);
    const install = INSTALL_COMMAND[environment.packageManager ?? 'npm'];

    row('Dependencies', environment.dependenciesInstalled ? ok('installed') : warn('not installed'),
        environment.dependenciesInstalled ? (environment.packageManager ?? '') : `run \`${install}\` first: type-based findings (TS001, ERR003) are unreliable without it`);
    row('TypeScript', environment.tsconfig ? ok(environment.tsconfig) : warn('no root tsconfig.json'),
        environment.tsconfig ? (environment.nestedTsconfigs > 0 ? `plus ${plural(environment.nestedTsconfigs, 'nested config')}` : '') : 'compiler defaults are assumed');
    row('Packages', ok(String(environment.packages)), environment.workspaceGlobs.length > 0 ? `workspaces: ${environment.workspaceGlobs.join(', ')}` : environment.packages > 1 ? 'no workspace globs declared' : '');
    row('Frameworks', environment.frameworks.length > 0 ? ok(environment.frameworks.join(', ')) : color.dim('none detected'));
    row('Entry points', environment.entryPoints > 0 ? ok(String(environment.entryPoints)) : warn('none found'), environment.entryPoints > 0 ? '' : 'every file will look unused: set "main" or "exports" in package.json');
    row('Imports', environment.unresolvedImports === 0 ? ok('all resolved') : warn(`${environment.unresolvedImports} unresolved`),
        environment.unresolvedImports === 0 ? '' : `${environment.unresolvedSample.join(', ')}${environment.unresolvedImports > environment.unresolvedSample.length ? ', ...' : ''}`);
    for (const warning of summary.coverage?.warnings ?? []) lines.push('', `  ${color.yellow(`${glyph.warn} ${warning}`)}`);
    lines.push('');
    return lines.join('\n');
}

function hiddenNote(count: number): string {
    return `${plural(count, 'lower-confidence finding')} hidden. Run with --all to list them (--audit also includes tests and examples).`;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function displayPath(repository: string): string {
    const home = process.env.HOME;
    return home && repository.startsWith(home) ? `~${repository.slice(home.length)}` : repository;
}

function renderHeader(summary: ScanSummary, width: number): string[] {
    const title = `${color.bold(color.cyan('DevKit'))} ${color.dim(glyph.bullet)} ${color.bold('Repository Quality Scan')}`;
    return renderBox([title, color.dim(truncateMiddle(displayPath(summary.repository), width - 6))], width);
}

function renderScore(summary: ScanSummary, width: number): string[] {
    const lines: string[] = [];
    const grade = scoreColor(summary.score, color.bold(` ${scoreGrade(summary.score)} `));
    const scoreText = `${color.bold(scoreColor(summary.score, summary.score.toFixed(1)))}${color.dim(' / 10')}`;
    lines.push(`  ${scoreText}   ${color.dim('grade')} ${grade}  ${scoreColor(summary.score, scoreLabel(summary.score))}`);
    lines.push(`  ${renderScoreBar(summary.score, Math.min(48, width - 4))}`);
    const drains = summary.scoreDrains ?? [];
    if (drains.length > 0) {
        lines.push(`  ${color.dim('Biggest score drains:')}`);
        drains.forEach((drain, index) => {
            const title = getRuleById(drain.ruleId)?.title ?? drain.ruleId;
            lines.push(`  ${color.dim(`${index + 1}.`)} ${color.cyan(pad(drain.ruleId, 11))}${pad(truncateMiddle(title, 34), 36)}${color.red(`-${drain.pointsLost.toFixed(2)}`)} ${color.dim(`(${plural(drain.count, 'finding')})`)}`);
        });
    }
    if (summary.securityCapped) {
        lines.push(`  ${color.red(`${glyph.warn} Capped at ${SECURITY_CAP}`)} ${color.dim('— a high-confidence security finding outweighs code quality. Fix it first.')}`);
    }
    if (summary.coverage && summary.coverage.analyzedFiles === 0) {
        lines.push(`  ${color.yellow(`${glyph.warn} No JavaScript/TypeScript files were analyzed, so this score means nothing.`)}`);
        lines.push(`  ${color.dim('  Check that you ran devkit from the project root, and your scan.include / .devkitignore settings.')}`);
    }
    return lines;
}

function renderCoverage(summary: ScanSummary, width: number): string[] {
    const coverage = summary.coverage;
    if (!coverage) return [];
    const lines: string[] = ['', sectionHeading('Scan coverage', width, `${formatDuration(coverage.durationMs)} · via ${coverage.discoveryMethod === 'git' ? 'git (respects .gitignore)' : 'filesystem walk'}`)];
    const stat = (value: number, label: string) => `${color.bold(String(value))} ${color.dim(label)}`;
    lines.push(
        `  ${stat(coverage.discoveredFiles, 'files found')}   ${stat(coverage.analyzedFiles, 'analyzed as JS/TS')}   ${stat(coverage.textFilesScanned, 'other files secret-scanned')}`
    );
    const skipped: string[] = [];
    if (coverage.generatedFilesSkipped > 0) skipped.push(plural(coverage.generatedFilesSkipped, 'generated file'));
    if (coverage.tooLargeFilesSkipped.length > 0) skipped.push(`${plural(coverage.tooLargeFilesSkipped.length, 'oversized file')}`);
    if (coverage.binaryFilesSkipped > 0) skipped.push(plural(coverage.binaryFilesSkipped, 'binary file'));
    if (coverage.nonProductionFindingsHidden > 0) skipped.push(`${plural(coverage.nonProductionFindingsHidden, 'test/example finding')} hidden`);
    lines.push(`  ${color.dim('Lines of code:')} ${summary.metrics.sourceLOC.toLocaleString()} ${color.dim('source ·')} ${summary.metrics.testLOC.toLocaleString()} ${color.dim('test')}${skipped.length ? `   ${color.dim(`Skipped: ${skipped.join(', ')}`)}` : ''}`);
    const languages = Object.entries(coverage.languages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([extension, count]) => `${extension} ${color.dim(String(count))}`)
        .join(color.dim('  ·  '));
    if (languages) lines.push(`  ${color.dim('Files:')} ${languages}`);
    if (summary.environment) lines.push(`  ${color.dim('Project:')} ${environmentLine(summary.environment)}`);
    for (const warning of coverage.warnings ?? []) lines.push(`  ${color.yellow(`${glyph.warn} ${warning}`)}`);
    return lines;
}

function renderCategories(summary: ScanSummary, width: number): string[] {
    const counts = new Map<string, number>();
    const worst = new Map<string, Severity>();
    for (const finding of summary.findings) {
        counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
        const previous = worst.get(finding.category);
        if (!previous || severityRank(finding.severity) > severityRank(previous)) worst.set(finding.category, finding.severity);
    }

    const categories = Object.keys(CATEGORY_LABELS).filter((category) => category in summary.categoryScores);
    if (!categories.includes('security')) categories.push('security');
    const nameWidth = Math.max(...categories.map((category) => humanizeCategory(category).length)) + 2;
    const barWidth = Math.max(10, Math.min(30, width - nameWidth - 30));

    const lines: string[] = ['', sectionHeading('Categories', width)];
    for (const category of categories) {
        const score = category === 'security' ? summary.securityScore : summary.categoryScores[category];
        const count = counts.get(category) ?? 0;
        const countText = count === 0 ? color.green(`${glyph.check} clean`) : severityColor(worst.get(category) ?? 'LOW', plural(count, 'finding'));
        lines.push(`  ${pad(humanizeCategory(category), nameWidth)}${scoreColor(score, padStart(score.toFixed(1), 4))}  ${renderScoreBar(score, barWidth)}  ${countText}`);
    }
    if (!('architecture' in summary.categoryScores)) {
        lines.push(`  ${pad(humanizeCategory('architecture'), nameWidth)}${color.dim(' n/a')}  ${color.dim('not scored — add "architecture.layers" to .devkitrc.json')}`);
    }
    return lines;
}

function renderSeverity(summary: ScanSummary, width: number): string[] {
    const bySeverity: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
    for (const finding of summary.findings) bySeverity[finding.severity] += 1;
    const legend = SEVERITIES.filter((severity) => bySeverity[severity] > 0)
        .map((severity) => `${severityColor(severity, glyph.dot)} ${bySeverity[severity]} ${severity.toLowerCase()}`)
        .join('   ');
    const bar = renderStackedBar(
        SEVERITIES.map((severity) => ({ value: bySeverity[severity], paint: (text: string) => severityColor(severity, text) })),
        Math.min(60, width - 4)
    );
    return ['', sectionHeading('Findings', width, `${summary.findings.length} total`), `  ${bar}`, `  ${legend}`];
}

function renderHotspots(summary: ScanSummary, width: number): string[] {
    const hotspots = summarizeHotspots(summary.findings);
    if (hotspots.length === 0) return [];
    const fileWidth = Math.min(Math.max(...hotspots.map((hotspot) => hotspot.file.length)) + 2, width - 30);
    const lines: string[] = ['', sectionHeading('Hotspots', width, 'files that cost the most points')];
    for (const hotspot of hotspots) {
        lines.push(`  ${severityColor(hotspot.worst, glyph.dot)} ${color.cyan(pad(truncateMiddle(hotspot.file, fileWidth - 2), fileWidth))}${padStart(plural(hotspot.count, 'finding'), 12)}  ${color.dim(`worst: ${hotspot.worst.toLowerCase()}`)}`);
    }
    return lines;
}

function renderTopIssues(summary: ScanSummary, width: number): string[] {
    const severityRankedFindings = [...summary.findings].sort(
        (a, b) => severityRank(b.severity) - severityRank(a.severity) || confidenceRank(b.confidence) - confidenceRank(a.confidence)
    );

    // One representative per category (its worst finding) so the detail section reads as a
    // scannable cross-section of the repository rather than six variations of the same rule.
    const representativeByCategory = new Map<string, Finding>();
    for (const finding of severityRankedFindings) {
        if (!representativeByCategory.has(finding.category)) {
            representativeByCategory.set(finding.category, finding);
        }
    }
    const topFindings = [...representativeByCategory.values()].slice(0, MAX_DETAILED_FINDINGS);
    if (topFindings.length === 0) return [];

    const lines: string[] = ['', sectionHeading('Top issues', width, 'worst finding per category')];
    for (const finding of topFindings) {
        const rail = severityColor(finding.severity, glyph.rail);
        lines.push('');
        lines.push(`  ${severityBadge(finding.severity)} ${color.bold(finding.message)}  ${color.dim(`${humanizeCategory(finding.category)} · ${finding.ruleId}`)}`);
        lines.push(`  ${rail} ${finding.description}`);
        lines.push(`  ${rail} ${color.green(glyph.arrow)} ${finding.suggestion}`);
        lines.push(`  ${rail} ${color.cyan(`${finding.file}:${finding.line}`)}${finding.confidence === 'LOW' ? color.dim('  (low confidence)') : ''}`);
        lines.push(...renderCodeFrame(summary.repository, finding.file, finding.line, finding.column, finding.severity));
    }
    return lines;
}

export function formatTerminal(summary: ScanSummary): string {
    const width = terminalWidth();
    const lines: string[] = [];

    lines.push(...renderHeader(summary, width));
    lines.push('');
    lines.push(...renderScore(summary, width));
    lines.push(...renderCoverage(summary, width));
    lines.push(...renderCategories(summary, width));

    if (summary.findings.length === 0) {
        lines.push('');
        if ((summary.hiddenByDefault ?? 0) > 0) {
            lines.push(`  ${color.green(`${glyph.check} No findings worth acting on.`)} ${color.dim(hiddenNote(summary.hiddenByDefault ?? 0))}`);
        } else {
            lines.push(`  ${color.green(`${glyph.check} No findings.`)} ${color.dim('The repository looks clean.')}`);
        }
        lines.push('');
        return lines.join('\n');
    }

    lines.push(...renderSeverity(summary, width));
    lines.push(...renderHotspots(summary, width));
    lines.push(...renderTopIssues(summary, width));

    const shown = Math.min(MAX_DETAILED_FINDINGS, new Set(summary.findings.map((finding) => finding.category)).size);
    const remaining = summary.findings.length - shown;
    lines.push('');
    lines.push(sectionHeading('Next steps', width));
    if (remaining > 0) {
        lines.push(color.dim(`  ${plural(remaining, 'more finding')} not shown above.`));
    }
    if ((summary.hiddenByDefault ?? 0) > 0) lines.push(color.dim(`  ${hiddenNote(summary.hiddenByDefault ?? 0)}`));
    const hint = (command: string, text: string) => `  ${color.cyan(pad(command, 32))}${color.dim(text)}`;
    lines.push(hint('devkit scan --category <name>', 'focus on one category (e.g. security, dead-code)'));
    lines.push(hint('devkit scan --format markdown', 'full report with every finding'));
    lines.push(hint('devkit explain <RULE_ID>', 'why a rule exists and how to fix it'));
    lines.push(hint('devkit fix', 'preview findings marked safe to fix'));
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
    lines.push(`- Overall score: ${summary.score.toFixed(1)} / 10 (grade ${scoreGrade(summary.score)}, ${scoreLabel(summary.score)})`);
    lines.push(`- Security score: ${summary.securityScore.toFixed(1)} / 10${summary.securityCapped ? ` — overall score capped at ${SECURITY_CAP} by a high-confidence security finding` : ''}`);
    if (summary.coverage) {
        const coverage = summary.coverage;
        lines.push(`- Coverage: ${coverage.discoveredFiles} files found, ${coverage.analyzedFiles} analyzed as JS/TS, ${coverage.textFilesScanned} other files secret-scanned, ${coverage.generatedFilesSkipped} generated skipped (${formatDuration(coverage.durationMs)})`);
        if (summary.environment) lines.push(`- Project: ${environmentLine(summary.environment)}`);
        for (const warning of coverage.warnings ?? []) lines.push(`- **Warning:** ${warning}`);
    }
    lines.push('');

    lines.push('## Category scores');
    lines.push('');
    lines.push('| Category | Score |');
    lines.push('| --- | ---: |');
    for (const [category, score] of Object.entries(summary.categoryScores)) {
        lines.push(`| ${humanizeCategory(category)} | ${score.toFixed(1)} |`);
    }
    if (!('architecture' in summary.categoryScores)) {
        lines.push('| Architecture | n/a (no layers configured) |');
    }

    lines.push('');
    lines.push('## Biggest score drains');
    lines.push('');
    const drains = summary.scoreDrains ?? [];
    if (drains.length === 0) {
        lines.push('No deductions.');
    } else {
        for (const drain of drains) {
            lines.push(`- ${drain.ruleId} ${getRuleById(drain.ruleId)?.title ?? ''} (${humanizeCategory(drain.category)}): -${drain.pointsLost.toFixed(2)} points, ${drain.count} finding(s)`);
        }
    }
    if ((summary.hiddenByDefault ?? 0) > 0) {
        lines.push('');
        lines.push(`_${hiddenNote(summary.hiddenByDefault ?? 0)}_`);
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
        // Stable across refactors (see finding ids), so code-scanning alerts are not closed and reopened by line shifts.
        partialFingerprints: { 'devkit/v1': finding.id },
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

    const builtIn = new Set(listRules().map((rule) => rule.id));
    const externalRules = [...new Set(summary.findings.map((finding) => finding.ruleId).filter((id) => !builtIn.has(id)))].map((id) => ({
        id,
        name: id,
        shortDescription: { text: id.startsWith('GITLEAKS:') ? `gitleaks rule ${id.slice('GITLEAKS:'.length)}` : `knip ${id.slice('KNIP:'.length)}` },
        properties: { category: summary.findings.find((finding) => finding.ruleId === id)?.category ?? 'external' }
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
                            rules: [...sarifRules, ...externalRules]
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
    const width = terminalWidth();
    const lines: string[] = [...renderBox([color.bold('Repository metrics'), color.dim(truncateMiddle(displayPath(summary.repository), width - 6))], width)];
    const row = (key: string, value: string, note = '') => `  ${color.dim(pad(key, 24))}${pad(value, 12)}${color.dim(note)}`;

    lines.push('', sectionHeading('Size', width));
    lines.push(row('totalFiles', color.bold(String(metrics.totalFiles)), `${metrics.sourceFiles} source · ${metrics.testFiles} test`));
    lines.push(row('sourceLOC', metrics.sourceLOC.toLocaleString()));
    lines.push(row('testLOC', metrics.testLOC.toLocaleString()));
    lines.push(row('commentLOC', metrics.commentLOC.toLocaleString()));
    lines.push(row('dependencyCount', String(metrics.dependencyCount)));
    if (summary.coverage) {
        lines.push(row('otherFilesSecretScanned', String(summary.coverage.textFilesScanned)));
        lines.push(row('generatedFilesSkipped', String(summary.coverage.generatedFilesSkipped)));
        lines.push(row('nonProductionFindingsHidden', String(summary.coverage.nonProductionFindingsHidden)));
    }

    lines.push('', sectionHeading('Structure', width));
    lines.push(row('functionCount', String(metrics.functionCount), `avg ${metrics.averageFunctionSize.toFixed(1)} lines`));
    lines.push(row('classCount', String(metrics.classCount)));
    const distribution = metrics.complexityDistribution;
    lines.push(
        `  ${color.dim(pad('complexity', 24))}${renderStackedBar(
            [
                { value: distribution.low, paint: color.green },
                { value: distribution.medium, paint: color.yellow },
                { value: distribution.high, paint: color.red }
            ],
            30
        )}  ${color.green(`${distribution.low} low`)} ${color.dim('·')} ${color.yellow(`${distribution.medium} medium`)} ${color.dim('·')} ${color.red(`${distribution.high} high`)}`
    );

    lines.push('', sectionHeading('Health', width));
    const percent = (value: number, invert = false) => {
        const score = invert ? 10 - value / 10 : value / 10;
        return scoreColor(score, `${value.toFixed(1)}%`);
    };
    lines.push(row('duplicationPercentage', percent(metrics.duplicationPercentage, true)));
    lines.push(row('deadCodePercentage', percent(metrics.deadCodePercentage, true)));
    lines.push(row('testToSourceRatio', metrics.testToSourceRatio.toFixed(2), metrics.testToSourceRatio < 0.3 ? 'low test coverage by volume' : ''));

    if (metrics.largestFunctions.length > 0) {
        lines.push('', sectionHeading('Largest functions', width));
        for (const fn of metrics.largestFunctions) {
            lines.push(`  ${padStart(String(fn.size), 5)} ${color.dim('lines')}  ${color.cyan(fn.name)} ${color.dim(fn.file)}`);
        }
    }

    if (metrics.largestFiles.length > 0) {
        lines.push('', sectionHeading('Largest files', width));
        for (const file of metrics.largestFiles) {
            lines.push(`  ${padStart(String(file.loc), 5)} ${color.dim('lines')}  ${color.cyan(file.file)}`);
        }
    }

    return lines.join('\n');
}

export function formatBaselineCompare(previousScore: number, currentScore: number): string {
    const delta = Number((currentScore - previousScore).toFixed(1));
    const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`;
    const verdict = delta < 0 ? color.red(`${glyph.warn} regression ${deltaText}`) : delta > 0 ? color.green(`${glyph.check} improved ${deltaText}`) : color.dim(`no change ${deltaText}`);
    const lines: string[] = [];
    lines.push(color.bold('Baseline compare'));
    lines.push(`  ${color.dim('Previous')}  ${renderScoreBar(previousScore, 24)} ${previousScore.toFixed(1)}`);
    lines.push(`  ${color.dim('Current ')}  ${renderScoreBar(currentScore, 24)} ${currentScore.toFixed(1)}`);
    lines.push(`  ${verdict}`);
    return lines.join('\n');
}
