export interface SecretPattern {
    id: string;
    label: string;
    regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
    { id: 'aws-access-key', label: 'AWS access key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { id: 'stripe-secret-key', label: 'Stripe secret key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
    { id: 'github-token', label: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
    { id: 'pem-private-key', label: 'PEM private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { id: 'jwt', label: 'JWT token', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
    { id: 'slack-token', label: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ }
];

export function looksHighEntropy(value: string, minLength = 20): boolean {
    if (value.length < minLength) return false;
    const frequencies = new Map<string, number>();
    for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce((sum, count) => {
        const probability = count / value.length;
        return sum - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.2;
}

/**
 * Values assigned to credential-looking names that are not credentials: references to environment
 * variables (`env(NAME)`, `${NAME}`), URLs without embedded credentials, and file or module paths.
 */
export function looksLikeNonSecretValue(value: string): boolean {
    if (/^(?:env|secret|vault|ssm|file)\(/i.test(value) || /^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(value)) return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
        // `scheme://user:password@host` embeds a credential; a plain URL does not.
        return !/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]+@/i.test(value);
    }
    if (/^(?:\.{0,2}\/)[\w@./-]+$/.test(value) || /^[\w@./-]+\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|html?|css|pem|crt|key)$/i.test(value)) return true;
    return false;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
    const payload = token.split('.')[1];
    if (!payload) return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/**
 * Tokens that are public by design: client-side "anon" keys (Supabase, Firebase-style) and the well-known
 * demo/sample tokens that ship with local development stacks. The payload says so (`role: anon`, `iss: ...-demo`).
 */
export function isPublicOrDemoJwt(token: string): boolean {
    const payload = decodeJwtPayload(token);
    if (!payload) return false;
    const issuer = typeof payload.iss === 'string' ? payload.iss : '';
    return payload.role === 'anon' || /(?:^|[-_.\s])(?:demo|example|sample|test|local|dev)(?:$|[-_.\s])/i.test(issuer);
}
