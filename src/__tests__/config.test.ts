import { describe, expect, it } from 'vitest';
import { getRuleThreshold, isRuleEnabled, loadConfig } from '../config';
import { cleanupFixture, makeFixture } from './testUtils';

describe('configuration', () => {
    it('merges partial project, scan, and rule settings with defaults', () => {
        const dir = makeFixture({ '.devkitrc.json': JSON.stringify({ scan: { include: ['app/**'] }, rules: { TS001: { enabled: false, max: 2 } } }) });
        try {
            const config = loadConfig(dir);
            expect(config.scan).toEqual({ include: ['app/**'], exclude: ['node_modules/**', 'dist/**', 'coverage/**', '.git/**', '.devkit/**'] });
            expect(config.project.name).toBe('my-project');
            expect(isRuleEnabled(config, 'TS001')).toBe(false);
            expect(isRuleEnabled(config, 'TS002')).toBe(true);
            expect(getRuleThreshold(config, 'TS001', 5)).toBe(2);
            expect(getRuleThreshold(config, 'TS002', 5)).toBe(5);
        } finally { cleanupFixture(dir); }
    });
});
