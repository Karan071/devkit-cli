import path from 'node:path';
import type { RuleContext } from '../context';
import type { Finding } from '../types';
import { buildFinding } from '../finding';
import { isRuleEnabled } from '../config';
import { matchesAnyGlob } from '../glob';

function layerForFile(relativePath: string, layers: Record<string, { match: string[]; cannotImport: string[] }>): string | null {
    for (const [layerName, layer] of Object.entries(layers)) {
        if (matchesAnyGlob(relativePath, layer.match)) {
            return layerName;
        }
    }
    return null;
}

export function runArchitectureRules(context: RuleContext): Finding[] {
    if (!isRuleEnabled(context.config, 'ARCH001')) return [];

    const layers = context.config.architecture?.layers;
    if (!layers || Object.keys(layers).length === 0) return [];

    const findings: Finding[] = [];
    const { moduleGraph, projectRoot } = context;

    for (const [file, targets] of moduleGraph.edges) {
        const sourceRelative = path.relative(projectRoot, file).replace(/\\/g, '/');
        const sourceLayer = layerForFile(sourceRelative, layers);
        if (!sourceLayer) continue;

        const forbidden = layers[sourceLayer].cannotImport ?? [];
        if (forbidden.length === 0) continue;

        for (const target of targets) {
            const targetRelative = path.relative(projectRoot, target).replace(/\\/g, '/');
            const targetLayer = layerForFile(targetRelative, layers);
            if (!targetLayer || !forbidden.includes(targetLayer)) continue;

            findings.push(
                buildFinding({
                    ruleId: 'ARCH001',
                    category: 'architecture',
                    severity: 'HIGH',
                    confidence: 'CERTAIN',
                    file: sourceRelative,
                    line: 1,
                    column: 1,
                    message: 'Forbidden layer import',
                    description: `Layer "${sourceLayer}" is configured to never import from layer "${targetLayer}".`,
                    evidence: `${sourceRelative} -> ${targetRelative}`,
                    suggestion: 'Remove the import or restructure the dependency to respect the architecture boundary.',
                    fixAvailable: false
                })
            );
        }
    }

    return findings;
}
