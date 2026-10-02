import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { countLines, filterScannedFiles, isTestFile, readFileSafe, walkDirectory } from './discovery';
import { createProgram } from './ast/parse';
import { buildModuleGraph } from './moduleGraph';
import { loadConfig } from './config';
import { loadIgnorePatterns } from './ignore';
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
import type { Finding, RepoMetrics, ScanSummary } from './types';

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

export function scanRepository(projectRoot: string): ScanSummary {
    const config = loadConfig(projectRoot);
    const allFiles = walkDirectory(projectRoot);
    const { files, generatedFiles } = filterScannedFiles(allFiles, projectRoot, config, loadIgnorePatterns(projectRoot));

    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = fs.existsSync(packageJsonPath) ? JSON.parse(readFileSafe(packageJsonPath)) : null;

    const program = createProgram(files);
    const moduleGraph = buildModuleGraph(projectRoot, files, packageJson, config);

    const context: RuleContext = { projectRoot, files, allFiles, program, moduleGraph, config, packageJson };

    const functionMetrics = collectFunctionMetrics(context);

    const allFindings: Finding[] = [
        ...runDeadCodeRules(context),
        ...runDependencyRules(context),
        ...runComplexityRules(context, functionMetrics),
        ...runDuplicationRules(context),
        ...runErrorHandlingRules(context),
        ...runRedundancyRules(context),
        ...runTypeScriptRules(context),
        ...runJavaScriptRules(context),
        ...runSecurityRules(context),
        ...runArchitectureRules(context),
        ...runHygieneRules(context)
    ];
    const findings: Finding[] = allFindings.filter((finding) => {
        const sourceFile = context.program.getSourceFile(path.resolve(projectRoot, finding.file));
        return !sourceFile || !isSuppressed(sourceFile, finding.line, finding.ruleId);
    });

    let sourceLOC = 0;
    let testLOC = 0;
    let commentLOC = 0;
    const largestFiles: Array<{ file: string; loc: number }> = [];

    for (const file of files) {
        const text = readFileSafe(file);
        const relativePath = path.relative(projectRoot, file).replace(/\\/g, '/');
        const isTest = isTestFile(relativePath);
        const loc = countLines(text);

        if (isTest) {
            testLOC += loc;
        } else {
            sourceLOC += loc;
        }

        commentLOC += (text.match(/^\s*(\/\/|\/\*|\*)/gm) ?? []).length;

        if (loc > 0) {
            largestFiles.push({ file: relativePath, loc });
        }
    }

    const sourceFiles = files.filter((file) => !isTestFile(file)).length;
    const testFiles = files.filter((file) => isTestFile(file)).length;

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

    const { overallScore, categoryScores, securityScore } = computeScores(findings, sourceLOC);

    return {
        repository: projectRoot,
        score: overallScore,
        categoryScores,
        securityScore,
        findings,
        metrics,
        generatedFiles
    };
}
