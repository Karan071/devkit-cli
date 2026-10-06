import type ts from 'typescript';
import type { DevkitConfig } from './config';
import type { ModuleGraph } from './moduleGraph';
import type { ProjectTypeSettings } from './ast/parse';

export interface RuleContext {
    projectRoot: string;
    files: string[];
    allFiles: string[];
    /** Non-JS/TS text files (config, env, other languages) that only get a secret scan. */
    textFiles: string[];
    program: ts.Program;
    moduleGraph: ModuleGraph;
    config: DevkitConfig;
    packageJson: Record<string, unknown> | null;
    /** The project's own type-checking strictness; absent in synthetic contexts, where rules assume defaults. */
    typeSettings?: ProjectTypeSettings;
}
