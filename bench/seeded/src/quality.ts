import express from 'express'; // planted: unlisted-dependency

export function swallow(run: () => void): void {
    try {
        run();
    } catch (error) {} // planted: empty-catch
}

export function legacy(): number {
    var total = 0; // planted: var-declaration
    return total;
}

export const server = express;
