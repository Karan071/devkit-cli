import fs from 'node:fs';
import path from 'node:path';

export interface ArchitectureLayer {
    match: string[];
    cannotImport: string[];
}

export interface RuleOverride {
    enabled?: boolean;
    severity?: string;
    max?: number;
}

export interface DevkitConfig {
    project: {
        name: string;
    };
    scan: {
        include: string[];
        exclude: string[];
    };
    architecture?: {
        layers: Record<string, ArchitectureLayer>;
    };
    rules: Record<string, RuleOverride>;
}

export const defaultConfig: DevkitConfig = {
    project: {
        name: 'my-project'
    },
    scan: {
        include: ['**/*'],
        exclude: ['node_modules/**', 'dist/**', 'coverage/**', '.git/**', '.devkit/**']
    },
    rules: {}
};

export function loadConfig(projectRoot: string): DevkitConfig {
    const configPath = path.join(projectRoot, '.devkitrc.json');

    if (!fs.existsSync(configPath)) {
        return defaultConfig;
    }

    const raw = fs.readFileSync(configPath, 'utf8');

    try {
        const parsed = JSON.parse(raw) as Partial<DevkitConfig>;
        return {
            ...defaultConfig,
            ...parsed,
            project: { ...defaultConfig.project, ...(parsed.project ?? {}) },
            scan: { ...defaultConfig.scan, ...(parsed.scan ?? {}) },
            architecture: parsed.architecture
                ? { ...parsed.architecture, layers: { ...(defaultConfig.architecture?.layers ?? {}), ...(parsed.architecture.layers ?? {}) } }
                : defaultConfig.architecture,
            rules: { ...defaultConfig.rules, ...(parsed.rules ?? {}) }
        };
    } catch {
        return defaultConfig;
    }
}

export function writeConfig(projectRoot: string): string {
    const configPath = path.join(projectRoot, '.devkitrc.json');
    fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
    return configPath;
}

export function isRuleEnabled(config: DevkitConfig, ruleId: string): boolean {
    return config.rules[ruleId]?.enabled !== false;
}

export function getRuleThreshold(config: DevkitConfig, ruleId: string, fallback: number): number {
    const override = config.rules[ruleId]?.max;
    return typeof override === 'number' ? override : fallback;
}
