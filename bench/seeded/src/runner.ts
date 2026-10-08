import { exec } from 'node:child_process';

export function runShell(command: string): void {
    exec(`sh -c "${command}"`, () => undefined);
}
