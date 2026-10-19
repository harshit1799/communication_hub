/**
 * Renders message templates with Handlebars.
 *
 *   views/email/<name>.html   full HTML email
 *   views/sms/<name>.txt      SMS text
 *   views/push/<name>.txt     push body
 *
 * <name> is what clients send as `template`. Adding a template = dropping a
 * file into the right folder; no code changes. Compiled templates are cached.
 */

import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationChannel } from '../../constant/index.js';

// src/views in dev, dist/views after build.
const VIEWS_DIR = join(import.meta.dirname, '..', '..', 'views');

/** File extension per channel. */
const EXTENSION: Record<NotificationChannel, string> = {
  [NotificationChannel.Email]: 'html',
  [NotificationChannel.Sms]: 'txt',
  [NotificationChannel.Push]: 'txt',
};

/** Values available to {{placeholders}}. */
export type TemplateData = Record<string, unknown>;

/** Compiled templates are cached for the life of the process. */
@Injectable()
export class TemplateService {
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();
  // Own Handlebars instance, so helpers registered here never leak globally.
  private readonly hbs = Handlebars.create();

  /** Whether views/<channel>/<name>.<ext> exists. */
  exists(channel: NotificationChannel, name: string): boolean {
    return this.cache.has(this.cacheKey(channel, name)) || existsSync(this.file(channel, name));
  }

  /** Renders a template file. HTML templates escape {{values}}. */
  render(channel: NotificationChannel, name: string, data: TemplateData): string {
    return this.load(channel, name)(data).trim();
  }

  /** Renders an inline string such as a subject line ("Hi {{name}}"). */
  renderText(text: string, data: TemplateData): string {
    // noEscape: plain text, not HTML, so "&" must stay "&".
    return this.hbs.compile(text, { noEscape: true })(data);
  }

  /** Compiles a template file once and caches it. */
  private load(channel: NotificationChannel, name: string): Handlebars.TemplateDelegate {
    const key = this.cacheKey(channel, name);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const template = this.hbs.compile(readFileSync(this.file(channel, name), 'utf8'), {
      // Only HTML needs escaping; SMS/push are plain text.
      noEscape: channel !== NotificationChannel.Email,
    });
    this.cache.set(key, template);
    return template;
  }

  /** Cache key: "<channel>/<name>". */
  private cacheKey(channel: NotificationChannel, name: string) {
    return `${channel}/${name}`;
  }

  /** Absolute path of a template file. */
  private file(channel: NotificationChannel, name: string) {
    return join(VIEWS_DIR, channel, `${name}.${EXTENSION[channel]}`);
  }
}
