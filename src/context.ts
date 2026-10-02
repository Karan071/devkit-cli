import type ts from 'typescript';
import type { DevkitConfig } from './config';
import type { ModuleGraph } from './moduleGraph';

export interface RuleContext {
    projectRoot: string;
    files: string[];
    allFiles: string[];
    program: ts.Program;
    moduleGraph: ModuleGraph;
    config: DevkitConfig;
    packageJson: Record<string, unknown> | null;
}
