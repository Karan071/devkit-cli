import https from 'node:https';

export const insecureAgent = new https.Agent({ rejectUnauthorized: false }); // planted: tls-agent

export function fetchInsecure(url: string): void {
    https.get(url, { agent: insecureAgent });
}

export function disableTlsGlobally(): void {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // planted: tls-env
}
