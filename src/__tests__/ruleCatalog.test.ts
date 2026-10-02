import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('rule catalog synchronization', () => {
    it('registers every rule ID emitted by rule implementation files', () => {
        const rulesDir = path.join(process.cwd(), 'src/rules');
        const catalog = fs.readFileSync(path.join(process.cwd(), 'src/rules.ts'), 'utf8');
        const catalogIds = new Set([...catalog.matchAll(/id:\s*['"]([A-Z]{2,}\d{3})['"]/g)].map((match) => match[1]));
        const emittedIds = new Set<string>();
        for (const file of fs.readdirSync(rulesDir).filter((name) => name.endsWith('.ts'))) {
            const text = fs.readFileSync(path.join(rulesDir, file), 'utf8');
            for (const match of text.matchAll(/\b([A-Z]{2,}\d{3})\b/g)) emittedIds.add(match[1]);
        }
        expect([...emittedIds].filter((id) => !catalogIds.has(id))).toEqual([]);
    });
});
