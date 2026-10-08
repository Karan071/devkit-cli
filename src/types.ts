export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type Confidence = 'CERTAIN' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface RuleDefinition {
    id: string;
    title: string;
    category: string;
    severity: Severity;
    confidence: Confidence;
    description: string;
    explanation: string;
    example: string;
    why: string;
    fixClassification: 'safe' | 'unsafe' | 'manual';
    defaultThreshold?: number;
}

export interface Finding {
    id: string;
    ruleId: string;
    category: string;
    severity: Severity;
    confidence: Confidence;
    file: string;
    line: number;
    column: number;
    message: string;
    description: string;
    evidence: string;
    suggestion: string;
    fixAvailable: boolean;
}

export interface RepoMetrics {
    totalFiles: number;
    sourceFiles: number;
    testFiles: number;
    totalLOC: number;
    sourceLOC: number;
    testLOC: number;
    commentLOC: number;
    functionCount: number;
    classCount: number;
    dependencyCount: number;
    averageFunctionSize: number;
    largestFunctions: Array<{ name: string; size: number; file: string }>;
    largestFiles: Array<{ file: string; loc: number }>;
    complexityDistribution: {
        low: number;
        medium: number;
        high: number;
    };
    duplicationPercentage: number;
    deadCodePercentage: number;
    testToSourceRatio: number;
}

export interface ScanSummary {
    repository: string;
    score: number;
    categoryScores: Record<string, number>;
    securityScore: number;
    /** True when the overall score was capped because of a credible security finding. */
    securityCapped?: boolean;
    findings: Finding[];
    metrics: RepoMetrics;
    generatedFiles: string[];
    coverage?: ScanCoverage;
}

export interface ScanCoverage {
    /** How files were enumerated: `git` honors .gitignore exactly, `filesystem` is the fallback walk. */
    discoveryMethod: 'git' | 'filesystem';
    /** Non-ignored files found in the repository. */
    discoveredFiles: number;
    /** JS/TS files that received full AST + type-checker analysis. */
    analyzedFiles: number;
    /** Other text files (configs, env files, other languages) that received a secret scan. */
    textFilesScanned: number;
    generatedFilesSkipped: number;
    /** Findings hidden because the rule does not apply to tests, examples, benchmarks or fixtures. Use `scan.includeNonProduction` to show them. */
    nonProductionFindingsHidden: number;
    tooLargeFilesSkipped: string[];
    binaryFilesSkipped: number;
    /** File count per extension across all discovered files, e.g. `{ ".ts": 42, ".json": 6 }`. */
    languages: Record<string, number>;
    durationMs: number;
    /** Conditions that make parts of this scan less reliable, e.g. dependencies not installed. */
    warnings?: string[];
}
