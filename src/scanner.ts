import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { countLines, discoverFiles, isTestFile, readFileSafe, toRelative } from './discovery';
import { createProgram } from './ast/parse';
import { buildModuleGraph } from './moduleGraph';
import { loadConfig } from './config';
import type { RuleContext } from './context';
import { collectFunctionMetrics, runComplexityRules } from './rules/complexity';
import { runDeadCodeRules } from './rules/deadCode';
import { runDependencyRules } from './rules/dependencies';
import { runDuplicationRules } from './rules/duplication';
import { runErrorHandlingRules } from './rules/errorHandling';
import { runRedundancyRules } from './rules/redundancy';
import { runTypeScriptRules } from './rules/typescript';
import { runJavaScriptRules } from './rules/javascript';
import { runSecurityRules } from './rules/security';
import { runArchitectureRules } from './rules/architecture';
import { runHygieneRules } from './rules/hygiene';
import { computeScores } from './scoring';
import { isSuppressed } from './suppressions';
import type { Finding, RepoMetrics, ScanCoverage, ScanSummary } from './types';

export interface ScanProgress {
    /** 1-based index of the current phase. */
    step: number;
    totalSteps: number;
    label: string;
    /** Optional per-file progress inside a phase. */
    current?: number;
    total?: number;
}

export type ProgressListener = (progress: ScanProgress) => void;

function countClassDeclarations(program: ts.Program, files: string[]): number {
    let count = 0;

    for (const file of files) {
        const sourceFile = program.getSourceFile(file);
        if (!sourceFile) continue;

        const visit = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
                count += 1;
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return count;
}

function estimateDuplicatedLines(findings: Finding[]): number {
    let total = 0;
    for (const finding of findings) {
        if (finding.ruleId !== 'DUP001') continue;
        const match = finding.description.match(/^Lines (\d+)-(\d+)/);
        if (match) {
            total += Number(match[2]) - Number(match[1]) + 1;
        }
    }
    return total;
}

function countLanguages(files: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const file of files) {
        const base = path.basename(file);
        const key = path.extname(file).toLowerCase() || (base.startsWith('.') ? base : '(none)');
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}

const RULE_PHASES: Array<[string, (context: RuleContext) => Finding[]]> = [
    ['Dead code', runDeadCodeRules],
    ['Dependencies', runDependencyRules],
    ['Duplication', runDuplicationRules],
    ['Error handling', runErrorHandlingRules],
    ['Redundant logic', runRedundancyRules],
    ['Type safety', (context) => [...runTypeScriptRules(context), ...runJavaScriptRules(context)]],
    ['Security', runSecurityRules],
    ['Architecture', runArchitectureRules],
    ['Hygiene', runHygieneRules]
];

// discovery, program, type-check, module graph, function metrics + rule phases + scoring
const TOTAL_STEPS = 5 + RULE_PHASES.length + 1;

export function scanRepository(projectRoot: string, onProgress: ProgressListener = () => undefined): ScanSummary {
    const startedAt = Date.now();
    let step = 0;
    const phase = (label: string, current?: number, total?: number): void => {
        onProgress({ step, totalSteps: TOTAL_STEPS, label, current, total });
    };
    const nextPhase = (label: string): void => {
        step += 1;
        phase(label);
    };

    nextPhase('Discovering files');
    const config = loadConfig(projectRoot);
    const discovery = discoverFiles(projectRoot, config);
    const { files, allFiles, textFiles, generatedFiles } = discovery;

    const packageJsonPath = path.join(projectRoot, 'package.json');
    let packageJson: Record<string, unknown> | null = null;
    if (fs.existsSync(packageJsonPath)) {
        try {
            packageJson = JSON.parse(readFileSafe(packageJsonPath));
        } catch {
            packageJson = null;
        }
    }

    nextPhase(`Parsing ${files.length} source files`);
    const program = createProgram(files);

    // Type-check every file up front: the program caches diagnostics, so the rule phases that
    // need them are cheap afterwards, and this (the slowest step) can report per-file progress.
    nextPhase('Type-checking');
    files.forEach((file, index) => {
        phase('Type-checking', index + 1, files.length);
        const sourceFile = program.getSourceFile(file);
        if (!sourceFile) return;
        try {
            program.getSemanticDiagnostics(sourceFile);
        } catch {
            // A checker crash on one file must not abort the whole scan; rules skip it the same way.
        }
    });

    nextPhase('Building module graph');
    const moduleGraph = buildModuleGraph(projectRoot, files, packageJson, config);

    const context: RuleContext = { projectRoot, files, allFiles, textFiles, program, moduleGraph, config, packageJson };

    nextPhase('Measuring complexity');
    const functionMetrics = collectFunctionMetrics(context);
    const allFindings: Finding[] = [...runComplexityRules(context, functionMetrics)];

    for (const [label, run] of RULE_PHASES) {
        nextPhase(label);
        allFindings.push(...run(context));
    }

    nextPhase('Scoring');
    const findings: Finding[] = allFindings.filter((finding) => {
        const sourceFile = context.program.getSourceFile(path.resolve(projectRoot, finding.file));
        return !sourceFile || !isSuppressed(sourceFile, finding.line, finding.ruleId);
    });

    let sourceLOC = 0;
    let testLOC = 0;
    let commentLOC = 0;
    const largestFiles: Array<{ file: string; loc: number }> = [];

    for (const file of files) {
        const text = program.getSourceFile(file)?.text ?? readFileSafe(file);
        const relativePath = toRelative(projectRoot, file);
        const loc = countLines(text);

        if (isTestFile(relativePath)) {
            testLOC += loc;
        } else {
            sourceLOC += loc;
        }

        commentLOC += (text.match(/^\s*(\/\/|\/\*|\*)/gm) ?? []).length;

        if (loc > 0) {
            largestFiles.push({ file: relativePath, loc });
        }
    }

    const testFiles = files.filter((file) => isTestFile(toRelative(projectRoot, file))).length;
    const sourceFiles = files.length - testFiles;

    const dependencyCount = [
        ...Object.keys((packageJson?.dependencies as Record<string, string>) ?? {}),
        ...Object.keys((packageJson?.devDependencies as Record<string, string>) ?? {})
    ].length;

    const functionCount = functionMetrics.length;
    const classCount = countClassDeclarations(program, files);
    const deadCodeFindingCount = findings.filter((finding) => finding.category === 'deadCode').length;

    const metrics: RepoMetrics = {
        totalFiles: files.length,
        sourceFiles,
        testFiles,
        totalLOC: sourceLOC + testLOC,
        sourceLOC,
        testLOC,
        commentLOC,
        functionCount,
        classCount,
        dependencyCount,
        averageFunctionSize: functionCount > 0 ? functionMetrics.reduce((sum, metric) => sum + metric.lines, 0) / functionCount : 0,
        largestFunctions: [...functionMetrics]
            .sort((a, b) => b.lines - a.lines)
            .slice(0, 5)
            .map((metric) => ({ name: metric.name, size: metric.lines, file: metric.file })),
        largestFiles: largestFiles.sort((a, b) => b.loc - a.loc).slice(0, 5),
        complexityDistribution: {
            low: functionMetrics.filter((metric) => metric.cyclomatic <= 10).length,
            medium: functionMetrics.filter((metric) => metric.cyclomatic > 10 && metric.cyclomatic <= 25).length,
            high: functionMetrics.filter((metric) => metric.cyclomatic > 25).length
        },
        duplicationPercentage: sourceLOC > 0 ? Math.min(100, (estimateDuplicatedLines(findings) / sourceLOC) * 100) : 0,
        // Normalized against declared functions/classes rather than LOC, since dead code is a count of
        // unused declarations, not a span of lines.
        deadCodePercentage: functionCount + classCount > 0 ? Math.min(100, (deadCodeFindingCount / (functionCount + classCount)) * 100) : 0,
        testToSourceRatio: sourceLOC > 0 ? testLOC / sourceLOC : 0
    };

    const architectureConfigured = Object.keys(config.architecture?.layers ?? {}).length > 0;
    const { overallScore, categoryScores, securityScore, securityCapped } = computeScores(findings, sourceLOC + testLOC, { architectureConfigured });

    const coverage: ScanCoverage = {
        discoveryMethod: discovery.method,
        discoveredFiles: allFiles.length,
        analyzedFiles: files.length,
        textFilesScanned: textFiles.length,
        generatedFilesSkipped: generatedFiles.length,
        tooLargeFilesSkipped: discovery.skipped.tooLarge,
        binaryFilesSkipped: discovery.skipped.binary,
        languages: countLanguages(allFiles),
        durationMs: Date.now() - startedAt
    };

    return {
        repository: projectRoot,
        score: overallScore,
        categoryScores,
        securityScore,
        securityCapped,
        findings,
        metrics,
        generatedFiles,
        coverage
    };
}
