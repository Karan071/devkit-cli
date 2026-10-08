export function isBrowser(): boolean {
    return typeof window != 'undefined'; // decoy: typeof-loose-equality
}

export function readOptional(value: string | null): boolean {
    return value == null; // decoy: null-loose-equality
}

export function sameId(left: string, right: number): boolean {
    return left == right; // planted: loose-equality
}
