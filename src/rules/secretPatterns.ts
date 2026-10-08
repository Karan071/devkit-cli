export interface SecretPattern {
    id: string;
    label: string;
    regex: RegExp;
    /** Keys that ship in client code on purpose (publishable keys); reported as informational. */
    publicByDesign?: boolean;
    /** Distinctive provider tokens: still a leak when found in a test or example file. */
    productionLike?: (match: string) => boolean;
    /** Second-stage check on the matched text: `reject` drops it, `weak` keeps it at low confidence. */
    assess?: (match: string) => 'reject' | 'weak' | undefined;
}

const ALWAYS = (): boolean => true;

// Order matters: the first pattern that matches a line wins, so specific prefixes come before general ones.
export const SECRET_PATTERNS: SecretPattern[] = [
    { id: 'aws-access-key', label: 'AWS access key ID', regex: /\bAKIA[0-9A-Z]{16}\b/, productionLike: ALWAYS },
    { id: 'stripe-secret-key', label: 'Stripe secret key', regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/, productionLike: (match) => match.startsWith('sk_live_') },
    { id: 'stripe-publishable-key', label: 'Stripe publishable key', regex: /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/, publicByDesign: true },
    {
        id: 'github-token',
        label: 'GitHub token',
        regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
        productionLike: ALWAYS,
        assess: (match) => (isValidGithubToken(match) ? undefined : 'weak')
    },
    { id: 'gitlab-token', label: 'GitLab personal access token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/, productionLike: ALWAYS },
    { id: 'anthropic-key', label: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/, productionLike: ALWAYS },
    {
        id: 'openai-key',
        label: 'OpenAI API key',
        regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/,
        productionLike: ALWAYS,
        // Real keys always carry digits; a long `sk-` slug made of words is a class name or an id.
        assess: (match) => (/\d/.test(match) ? undefined : 'reject')
    },
    { id: 'npm-token', label: 'npm access token', regex: /\bnpm_[A-Za-z0-9]{36}\b/, productionLike: ALWAYS },
    { id: 'sendgrid-key', label: 'SendGrid API key', regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, productionLike: ALWAYS },
    { id: 'twilio-key', label: 'Twilio API key', regex: /\bSK[0-9a-f]{32}\b/, productionLike: ALWAYS },
    { id: 'azure-storage-key', label: 'Azure storage account key', regex: /\bAccountKey=[A-Za-z0-9+/]{86}==/, productionLike: ALWAYS },
    { id: 'google-api-key', label: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
    {
        id: 'database-url',
        label: 'database URL with an embedded password',
        regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/([^\s:/@'"`]+):([^\s@'"`/]+)@[^\s'"`]+/i,
        assess: (match) => (isPlaceholderPassword(match) ? 'reject' : undefined)
    },
    { id: 'pem-private-key', label: 'PEM private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
    { id: 'jwt', label: 'JWT token', regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
    { id: 'slack-token', label: 'Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, productionLike: ALWAYS }
];

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

let crcTable: number[] | undefined;
function crc32(text: string): number {
    crcTable ??= Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    let crc = 0xffffffff;
    for (const byte of Buffer.from(text, 'utf8')) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

/** The 6-character checksum GitHub appends to the 30 random characters of a token: CRC32, base62, zero-padded. */
export function githubTokenChecksum(entropy: string): string {
    let value = crc32(entropy);
    let encoded = '';
    while (value > 0) {
        encoded = BASE62[value % 62] + encoded;
        value = Math.floor(value / 62);
    }
    return encoded.padStart(6, '0');
}

/** Whether a `gh?_` token has GitHub's format: 36 characters whose last 6 are the checksum of the first 30. */
export function isValidGithubToken(token: string): boolean {
    const body = token.slice(token.indexOf('_') + 1);
    return body.length === 36 && body.slice(30) === githubTokenChecksum(body.slice(0, 30));
}

const PLACEHOLDER_PASSWORD = /^(?:password|passwd|pass|pwd|secret|changeme|change[-_]?me|example|test|admin|root|user|xxx+|\*+|\.+|redacted|your[-_a-z]*|<[^>]*>|\{[^}]*\}|\$\{?[A-Za-z_][\w]*\}?|%[sd]|\[[^\]]*\])$/i;

/** `scheme://user:password@host` whose password is a template slot or a well-known stand-in rather than a real value. */
function isPlaceholderPassword(url: string): boolean {
    const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^\s:/@]+):([^\s@/]+)@/i);
    if (!match) return true;
    const [, user, password] = match;
    return PLACEHOLDER_PASSWORD.test(password) || password === user || /^\$|^<|^\{/.test(password);
}

/** Variable, property or config-key names that mean "this holds a credential" (the name must end in the credential word). */
const CREDENTIAL_NAME = /(?:^|_)(?:api_?key|secret|secret_?key|token|access_?token|auth_?token|refresh_?token|passw(?:or)?d|passwd|pwd|private_?key|access_?key|client_?secret|credentials?)$/;
const PASSWORD_NAME = /(?:^|_)(?:passw(?:or)?d|passwd|pwd)$/;

function nameWords(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/** `dbPassword`, `DB_PASSWORD` and `db-password` are all password-like; `passwordHash` and `tokenizer` are not. */
export function credentialKind(name: string): 'password' | 'secret' | null {
    // An identifier or config key, not a sentence: translation files use whole English sentences as keys.
    if (/\s/.test(name) || name.length > 80) return null;
    const words = nameWords(name);
    if (PASSWORD_NAME.test(words)) return 'password';
    return CREDENTIAL_NAME.test(words) ? 'secret' : null;
}

/**
 * Whether a value assigned to a credential-like name could be a credential: one unbroken token (no
 * spaces, so prose and code snippets are out) that mixes character types (so plain words and
 * identifiers are out) and is not trivially repetitive. Passwords are shorter than keys, so they need
 * three character types instead of a long, high-entropy string.
 */
export function looksLikeSecretValue(value: string, kind: 'password' | 'secret', minLength: number): boolean {
    if (/\s/.test(value)) return false;
    // Credentials are ASCII (base64, hex, random alphanumerics). Text in any other script is prose.
    if (/[^\x00-\x7F]/.test(value)) return false;
    // A call, arrow function or template slot is code, not a credential.
    if (/[A-Za-z_$][\w$]*\(|=>|&&|\|\||\$\{/.test(value)) return false;
    // Plain words, identifier paths, and words joined by hyphens, underscores or dots (`Two-Factor-Token`, `some_label`).
    if (/^[A-Za-z]+(?:[-_.][A-Za-z]+)*$/.test(value) || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value)) return false;
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
    if (classes < 2) return false;
    if (kind === 'password') return value.length >= 8 && classes >= 3 && looksHighEntropy(value, 8, 2.8);
    return looksHighEntropy(value, minLength);
}

export function looksHighEntropy(value: string, minLength = 20, minEntropy = 3.2): boolean {
    if (value.length < minLength) return false;
    const frequencies = new Map<string, number>();
    for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce((sum, count) => {
        const probability = count / value.length;
        return sum - probability * Math.log2(probability);
    }, 0);
    return entropy >= minEntropy;
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
