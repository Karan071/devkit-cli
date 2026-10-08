import { apiKey, awsAccessKey, dbPassword, githubToken, stripeKey } from './config';
import { findUser, findUserByKnex, findUserByPrisma, findUserBySequelize, findUserByQuery, findUserSafely } from './db';
import { hasVersion, listDirectory } from './shell';
import { evaluate, readUpload } from './server';
import { renderGreeting, renderStatic } from './render';
import { fingerprint, checksum } from './hash';
import { disableTlsGlobally, fetchInsecure, insecureAgent } from './http';
import { runUntrusted } from './sandbox';
import { isBrowser, readOptional, sameId, sameId } from './env';
import { legacy, server, swallow } from './quality';
import { cycleA } from './cycleA';
import { registerRoutes } from './routes';
import { anthropicKey, azureConnection, databaseUrl, gitlabToken, googleKey, npmToken, openaiKey, sendgridKey, twilioKey } from './keys';
import { firebaseConfig } from './firebase';
import { publishableKey, sampleToken } from './billing';
import { passwordField, passwordHint, tokenLabel } from './labels';

export function main(): void {
    void [anthropicKey, azureConnection, databaseUrl, gitlabToken, googleKey, npmToken, openaiKey, sendgridKey, twilioKey];
    void [firebaseConfig, publishableKey, sampleToken, passwordField, passwordHint, tokenLabel];
    void [findUserByKnex, findUserByPrisma, findUserBySequelize];
    void registerRoutes;
    void [apiKey, dbPassword, awsAccessKey, stripeKey, githubToken];
    void [findUser, findUserByQuery, findUserSafely, listDirectory, hasVersion, evaluate, readUpload];
    void [renderGreeting, renderStatic, fingerprint, checksum, fetchInsecure, insecureAgent, disableTlsGlobally];
    void [runUntrusted, isBrowser, readOptional, sameId, cycleA, legacy, server, swallow];
}
