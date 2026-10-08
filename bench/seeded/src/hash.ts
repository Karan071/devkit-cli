import { createHash } from 'node:crypto';

export function checksum(data: string): string {
    return createHash('md5').update(data).digest('hex'); // planted: weak-hash
}

export function fingerprint(data: string): string {
    return createHash('sha256').update(data).digest('hex'); // decoy: strong-hash
}
