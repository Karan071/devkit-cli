import type { Confidence, Finding, Severity } from './types';

export function buildFinding(params: {
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
    fixAvailable?: boolean;
}): Finding {
    return {
        id: `${params.ruleId}-${params.file}-${params.line}-${params.column}`,
        ruleId: params.ruleId,
        category: params.category,
        severity: params.severity,
        confidence: params.confidence,
        file: params.file,
        line: params.line,
        column: params.column,
        message: params.message,
        description: params.description,
        evidence: params.evidence,
        suggestion: params.suggestion,
        fixAvailable: params.fixAvailable ?? false
    };
}
