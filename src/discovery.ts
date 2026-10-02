import fs from 'node:fs';
import path from 'node:path';

export const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
export const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.devkit', 'generated', 'vendor']);
export const GENERATED_HINTS = ['generated', 'dist', 'build', '.d.ts', '.min.', 'coverage'];

export function isRelevantFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SOURCE_EXTENSIONS.has(ext);
}

export function isTestFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return lower.includes('.test.') || lower.includes('.spec.') || lower.includes('__tests__');
}

export function isGeneratedFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return GENERATED_HINTS.some((hint) => lower.includes(hint));
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
