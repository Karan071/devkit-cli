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
