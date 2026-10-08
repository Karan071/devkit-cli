import { exec } from 'node:child_process';

export function listDirectory(dir: string): void {
    exec(`ls -la ${dir}`, () => undefined); // planted: command-injection
}

export function hasVersion(text: string): boolean {
    return /v(\d+)/.exec(text) !== null; // decoy: regexp-exec - RegExp.exec is not child_process
}
