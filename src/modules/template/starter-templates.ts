/**
 * Starter templates ("otp", "welcome" per channel) copied into every new
 * tenant as version 1, so a fresh tenant can send right away. After that
 * they are ordinary DB templates the tenant can edit, version or archive.
 *
 * The content ships in src/views/<channel>/<name>.<ext>; this is the only
 * place those files are read.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationChannel } from '../../constant/index.js';

// src/views in dev and tests, dist/views after build.
const VIEWS_DIR = join(import.meta.dirname, '..', '..', 'views');

/** One starter template: where its version 1 content comes from. */
export interface StarterTemplate {
  channel: NotificationChannel;
  name: string;
  description: string;
  subject: string | null;
  body: string | null;
  html: string | null;
}

const read = (channel: string, file: string) => readFileSync(join(VIEWS_DIR, channel, file), 'utf8').trim();

/** Reads the starter templates from disk (called rarely: tenant creation, migration). */
export function loadStarterTemplates(): StarterTemplate[] {
  const E = NotificationChannel.Email;
  const S = NotificationChannel.Sms;
  const P = NotificationChannel.Push;
  const I = NotificationChannel.InApp;
  return [
    { channel: E, name: 'otp', description: 'One-time code', subject: '{{appName}} verification code', body: null, html: read(E, 'otp.html') },
    { channel: E, name: 'welcome', description: 'Welcome email', subject: 'Welcome to {{appName}}', body: null, html: read(E, 'welcome.html') },
    { channel: S, name: 'otp', description: 'One-time code', subject: null, body: read(S, 'otp.txt'), html: null },
    { channel: S, name: 'welcome', description: 'Welcome SMS', subject: null, body: read(S, 'welcome.txt'), html: null },
    { channel: P, name: 'otp', description: 'One-time code', subject: null, body: read(P, 'otp.txt'), html: null },
    { channel: P, name: 'welcome', description: 'Welcome push', subject: null, body: read(P, 'welcome.txt'), html: null },
    { channel: I, name: 'welcome', description: 'Welcome inbox message', subject: 'Welcome to {{appName}}', body: read(I, 'welcome.txt'), html: null },
  ];
}
