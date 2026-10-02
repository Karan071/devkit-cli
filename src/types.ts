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
    findings: Finding[];
    metrics: RepoMetrics;
    generatedFiles: string[];
}
