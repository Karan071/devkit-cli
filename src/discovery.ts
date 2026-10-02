import fs from 'node:fs';
import path from 'node:path';
import type { DevkitConfig } from './config';
import { matchesAnyGlob } from './glob';

export const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
export const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.devkit', 'generated', 'vendor', '.next', '.nuxt', '.svelte-kit', '.angular', 'out']);
export const GENERATED_HINTS = ['generated', 'dist', 'build', '.d.ts', '.min.', 'coverage', '.next', '.nuxt', '.svelte-kit', '.angular', 'out'];

export function isRelevantFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SOURCE_EXTENSIONS.has(ext);
}

export function isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('.test.') || lower.includes('.spec.') || lower.includes('__tests__');
}

export function isGeneratedFile(filePath: string): boolean {
    const lower = filePath.replace(/\\/g, '/').toLowerCase();
    const segments = lower.split('/');
    const generatedDirectories = new Set(['generated', 'dist', 'build', 'coverage', '.next', '.nuxt', '.svelte-kit', '.angular', 'out']);
    const basename = segments[segments.length - 1] ?? '';
    return segments.some((segment) => generatedDirectories.has(segment)) || basename.endsWith('.d.ts') || basename.includes('.min.');
}

export function isGeneratedByContent(text: string): boolean {
    return /(?:@generated|\bDO NOT EDIT\b|\bGENERATED FILE\b)/i.test(text) || /^\/\/[#@]\s*sourceMappingURL=/m.test(text);
}

export function filterScannedFiles(
    allFiles: string[],
    projectRoot: string,
    config: DevkitConfig,
    ignorePatterns: string[]
): { files: string[]; generatedFiles: string[] } {
    const files: string[] = [];
    const generatedFiles: string[] = [];
    for (const file of allFiles) {
        if (!isRelevantFile(file)) continue;
        const relative = path.relative(projectRoot, file).replace(/\\/g, '/');
        if (!matchesAnyGlob(relative, config.scan.include)) continue;
        if (matchesAnyGlob(relative, config.scan.exclude) || matchesAnyGlob(relative, ignorePatterns)) continue;
        const text = readFileSafe(file);
        if (isGeneratedFile(relative) || isGeneratedByContent(text)) {
            generatedFiles.push(relative);
            continue;
        }
        files.push(file);
    }
    return { files, generatedFiles };
}

export function walkDirectory(rootDir: string): string[] {
    const allFiles: string[] = [];

    const visit = (currentDir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (IGNORE_DIRS.has(entry.name)) {
                    continue;
                }

                visit(absolutePath);
                continue;
            }

            if (entry.isFile()) {
                allFiles.push(absolutePath);
            }
        }
    };

    visit(rootDir);
    return allFiles;
}

export function readFileSafe(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return '';
    }
}

export function countLines(content: string): number {
    if (!content.trim()) {
        return 0;
    }

    return content.split(/\r\n|\r|\n/).length;
}
