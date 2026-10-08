import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DevkitConfig } from './config';
import { matchesAnyGlob } from './glob';
import { loadIgnorePatterns } from './ignore';

export const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

// Tool caches and framework build output: never source, wherever they appear.
export const IGNORE_DIRS = new Set([
    'node_modules', '.git', '.devkit', '.next', '.nuxt', '.svelte-kit', '.angular', '.turbo', '.cache',
    '.vercel', '.output', '.parcel-cache', '.yarn', '.pnpm-store', '__pycache__', '.venv', '.idea'
]);

// Build-output names that are only build output when they sit directly in a package root
// (next to a package.json). `src/build/` or `src/commands/out/` are ordinary source folders.
// Deliberately excludes `vendor`: vendored/checked-in third-party code is sometimes kept out of
// lint configs, but it is still real, committed content that must stay visible to a security scan.
const PACKAGE_OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'coverage']);

const GENERATED_DIRS = new Set(['generated', '__generated__']);

const MAX_SOURCE_FILE_BYTES = 1_500_000;
const MAX_TEXT_FILE_BYTES = 1_000_000;

// Files whose contents are machine-produced noise for a secret scan.
const NON_SCANNABLE_TEXT = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.(?:map|svg|snap|lock)$/i;
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|avif|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|flac|psd|sketch|fig|db|sqlite3?|bin|dat|pyc)$/i;

export function isRelevantFile(filePath: string): boolean {
    return SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function isTestFile(filePath: string): boolean {
    const lower = filePath.replace(/\\/g, '/').toLowerCase();
    return (
        /\.(?:test|spec|e2e|stories)\.[cm]?[jt]sx?$/.test(lower) ||
        /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|e2e|cypress|playwright|fixtures?)\//.test(lower)
    );
}

export function isGeneratedFile(filePath: string): boolean {
    const segments = filePath.replace(/\\/g, '/').toLowerCase().split('/');
    const basename = segments[segments.length - 1] ?? '';
    return (
        segments.some((segment) => IGNORE_DIRS.has(segment) || GENERATED_DIRS.has(segment)) ||
        /\.d\.[cm]?ts$/.test(basename) ||
        /[.-]min\.[cm]?js$/.test(basename) ||
        /\.bundle\.[cm]?js$/.test(basename)
    );
}

/** The comment block (and blank lines) at the very top of a file, before any code. */
function leadingCommentBlock(text: string): string {
    const header: string[] = [];
    for (const line of text.split(/\r\n|\r|\n/, 40)) {
        const trimmed = line.trim();
        if (trimmed && !/^(?:\/\/|\/\*|\*|#!|'use |"use )/.test(trimmed)) break;
        header.push(line);
    }
    return header.join('\n');
}

/**
 * Only the leading comment block is inspected: a "do not edit" note inside a hand-written
 * file must not hide that file from the scan.
 */
export function isGeneratedByContent(text: string): boolean {
    const header = leadingCommentBlock(text);
    // `DO NOT EDIT` is matched case-sensitively: generators emit it uppercase, while a human's
    // "do not edit this by hand" note is not a generated-file marker.
    if (/\bDO NOT EDIT\b/.test(header) || /@generated\b|\bauto-?generated\b|\bGENERATED FILE\b|\bThis file (?:is|was) (?:automatically )?generated\b/i.test(header)) {
        return true;
    }
    if (/^\/\/[#@]\s*sourceMappingURL=/m.test(text.slice(-400))) return true;
    return looksMinified(text);
}

// Output of the Emscripten toolchain: its runtime shell and wasm loaders are never hand-written.
const EMSCRIPTEN_MARKER = /\bEMSCRIPTEN_(?:START|END)_|\bvar Module\s*=\s*(?:typeof Module|\{)|\bModule\[["'](?:preRun|postRun|wasmBinary|locateFile)["']\]|\/\/ include: (?:shell|preamble|postamble)\.js/;

/**
 * Judged by shape, since not every generated file says so: very long lines (inlined wasm or base64 payloads,
 * bundles), Emscripten glue, or a preserved `/*!` license banner above bundled code.
 */
function looksMinified(text: string): boolean {
    if (text.length < 2000) return false;
    const lines = text.split('\n');
    const averageLine = text.length / lines.length;
    if (averageLine > 200) return true;
    if (EMSCRIPTEN_MARKER.test(text.slice(0, 20_000))) return true;
    // A `/*! ... */` or `@license`/`@preserve` banner survives minification; with long lines below it, this is a vendored bundle.
    return averageLine > 120 && /^\s*\/\*[!*]\s*(?:[\s\S]{0,2000}?)(?:@license|@preserve|\*\/)/.test(text.slice(0, 2500)) && /(?:^|\n)\s*\/\*!/.test(text.slice(0, 2500));
}

function isBinaryContent(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, 8000);
    return sample.includes(0);
}

export interface DiscoveryResult {
    /** Every non-ignored file in the repository (respects .gitignore). */
    allFiles: string[];
    /** JS/TS files that get full AST + type-checker analysis. */
    files: string[];
    /** Other text files (config, env, docs, other languages) that get a secret scan. */
    textFiles: string[];
    generatedFiles: string[];
    skipped: { tooLarge: string[]; binary: number };
    method: 'git' | 'filesystem';
}

function listGitFiles(projectRoot: string): string[] | null {
    try {
        const output = execFileSync('git', ['-C', projectRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 256 * 1024 * 1024
        });
        const listed = output.split('\0').filter(Boolean);
        // An empty listing usually means the folder is itself ignored by an enclosing repository.
        if (listed.length === 0) return null;
        return listed
            .map((relative) => path.join(projectRoot, relative))
            .filter((file) => {
                try {
                    return fs.statSync(file).isFile();
                } catch {
                    return false; // tracked but deleted in the working tree
                }
            });
    } catch {
        return null;
    }
}

/** Drops files inside ignored directories, including build output located in a package root. */
function isInIgnoredDirectory(relativePath: string, packageRoots: Set<string>): boolean {
    const segments = relativePath.split('/');
    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (IGNORE_DIRS.has(segment)) return true;
        if (PACKAGE_OUTPUT_DIRS.has(segment) && packageRoots.has(segments.slice(0, index).join('/'))) return true;
    }
    return false;
}

function collectPackageRoots(relativeFiles: string[]): Set<string> {
    const roots = new Set<string>(['']);
    for (const relative of relativeFiles) {
        if (relative === 'package.json' || relative.endsWith('/package.json')) {
            roots.add(relative.slice(0, -'package.json'.length).replace(/\/$/, ''));
        }
    }
    return roots;
}

export function filterScannedFiles(
    allFiles: string[],
    projectRoot: string,
    config: DevkitConfig,
    ignorePatterns: string[]
): { files: string[]; generatedFiles: string[]; tooLarge: string[] } {
    const files: string[] = [];
    const generatedFiles: string[] = [];
    const tooLarge: string[] = [];
    for (const file of allFiles) {
        if (!isRelevantFile(file)) continue;
        const relative = toRelative(projectRoot, file);
        if (!matchesAnyGlob(relative, config.scan.include)) continue;
        if (matchesAnyGlob(relative, config.scan.exclude) || matchesAnyGlob(relative, ignorePatterns)) continue;
        if (fileSize(file) > MAX_SOURCE_FILE_BYTES) {
            tooLarge.push(relative);
            continue;
        }
        if (isGeneratedFile(relative) || isGeneratedByContent(readFileSafe(file))) {
            generatedFiles.push(relative);
            continue;
        }
        files.push(file);
    }
    return { files, generatedFiles, tooLarge };
}

export function discoverFiles(projectRoot: string, config: DevkitConfig): DiscoveryResult {
    const gitFiles = listGitFiles(projectRoot);
    const ignorePatterns = loadIgnorePatterns(projectRoot, { includeGitignore: gitFiles === null });
    const candidates = gitFiles ?? walkDirectory(projectRoot);
    const relativeCandidates = candidates.map((file) => toRelative(projectRoot, file));
    const packageRoots = collectPackageRoots(relativeCandidates);

    const allFiles = candidates
        .filter((_, index) => !isInIgnoredDirectory(relativeCandidates[index], packageRoots))
        .filter((file) => !matchesAnyGlob(toRelative(projectRoot, file), ignorePatterns))
        .sort();

    const { files, generatedFiles, tooLarge } = filterScannedFiles(allFiles, projectRoot, config, ignorePatterns);

    const textFiles: string[] = [];
    let binary = 0;
    for (const file of allFiles) {
        if (isRelevantFile(file)) continue;
        const relative = toRelative(projectRoot, file);
        if (matchesAnyGlob(relative, config.scan.exclude)) continue;
        if (BINARY_EXTENSIONS.test(file)) {
            binary += 1;
            continue;
        }
        if (NON_SCANNABLE_TEXT.test(relative)) continue;
        if (fileSize(file) > MAX_TEXT_FILE_BYTES) {
            tooLarge.push(relative);
            continue;
        }
        let buffer: Buffer;
        try {
            buffer = fs.readFileSync(file);
        } catch {
            continue;
        }
        if (isBinaryContent(buffer)) {
            binary += 1;
            continue;
        }
        textFiles.push(file);
    }

    return { allFiles, files, textFiles, generatedFiles, skipped: { tooLarge, binary }, method: gitFiles ? 'git' : 'filesystem' };
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

export function toRelative(projectRoot: string, file: string): string {
    return path.relative(projectRoot, file).replace(/\\/g, '/');
}

function fileSize(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
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
