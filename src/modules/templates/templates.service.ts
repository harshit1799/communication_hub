/**
 * Renders email templates from src/views with Handlebars.
 *
 *   views/<name>.html   one complete HTML email per file; <name> is what
 *                       clients send as `template`
 *
 * Adding a new email = dropping a new .html file into views. No code
 * changes are needed.
 */

// Nest DI and HTTP exceptions.
import { BadRequestException, Injectable } from '@nestjs/common';
// Reads the typed `app` configuration (used for the brand name).
import { ConfigService } from '@nestjs/config';
// Handlebars: the template engine ({{value}} is HTML-escaped automatically).
import Handlebars from 'handlebars';
// File system helpers to load template files.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Typed config shape.
import { AppConfig } from '../../config/configuration.js';

// Absolute path of the views folder (src/views in dev, dist/views after build).
const VIEWS_DIR = join(import.meta.dirname, '..', '..', 'views');

/** Values available inside every template. */
export type TemplateData = Record<string, unknown>;

@Injectable()
export class TemplatesService {
  // Compiled templates by name, so each file is read only once.
  private readonly cache = new Map<string, Handlebars.TemplateDelegate>();
  // Default brand name shown in templates (clients may override via data).
  private readonly appName: string;

  constructor(config: ConfigService) {
    this.appName = config.getOrThrow<AppConfig>('app').name;
  }

  /** Renders views/<name>.html and returns the HTML. */
  renderEmail(name: string, data: TemplateData = {}): string {
    // Defaults first, so the caller's data can override them.
    return this.load(name)({
      appName: this.appName,
      year: new Date().getFullYear(),
      ...data,
    });
  }

  /** Renders a short inline string such as a subject line ("Hi {{name}}"). */
  renderText(text: string, data: TemplateData = {}): string {
    // noEscape: plain text, not HTML, so "&" must stay "&".
    return Handlebars.compile(text, { noEscape: true })({
      appName: this.appName,
      ...data,
    });
  }

  /** Compiles a template file once and returns it from the cache afterwards. */
  private load(name: string): Handlebars.TemplateDelegate {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const file = join(VIEWS_DIR, `${name}.html`);
    if (!existsSync(file)) {
      throw new BadRequestException(`Template "${name}" does not exist`);
    }
    const template = Handlebars.compile(readFileSync(file, 'utf8'));
    this.cache.set(name, template);
    return template;
  }
}
