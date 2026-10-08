import { apiKey, awsAccessKey, dbPassword, githubToken, stripeKey } from './config';
import { findUser, findUserByQuery, findUserSafely } from './db';
import { hasVersion, listDirectory } from './shell';
import { evaluate, readUpload } from './server';
import { renderGreeting, renderStatic } from './render';
import { fingerprint, checksum } from './hash';
import { disableTlsGlobally, fetchInsecure, insecureAgent } from './http';
import { runUntrusted } from './sandbox';
import { isBrowser, readOptional } from './env';
import { legacy, server, swallow } from './quality';
import { cycleA } from './cycleA';

export function main(): void {
    void [apiKey, dbPassword, awsAccessKey, stripeKey, githubToken];
    void [findUser, findUserByQuery, findUserSafely, listDirectory, hasVersion, evaluate, readUpload];
    void [renderGreeting, renderStatic, fingerprint, checksum, fetchInsecure, insecureAgent, disableTlsGlobally];
    void [runUntrusted, isBrowser, readOptional, cycleA, legacy, server, swallow];
}
