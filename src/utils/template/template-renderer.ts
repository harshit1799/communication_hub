/**
 * Renders Handlebars templates whose source comes from the database
 * (template_versions). Versions are immutable, so a compiled version is
 * cached by its id for the life of the process, in a bounded LRU
 * (LIMITS.TEMPLATE_COMPILE_CACHE entries).
 *
 * Escaping: email HTML escapes {{values}}; subjects, text parts, SMS and
 * push are plain text and are not escaped ("&" must stay "&").
 */

import { Injectable } from '@nestjs/common';
import Handlebars from 'handlebars';
import { LIMITS } from '../../constant/index.js';

/** Values available to {{placeholders}}. */
export type TemplateData = Record<string, unknown>;

/** The content of one version (or inline subject/body). */
export interface TemplateSource {
  subject?: string | null;
  body?: string | null;
  html?: string | null;
}

/** Rendered content; parts absent from the source stay undefined. */
export interface RenderedContent {
  subject?: string;
  body?: string;
  html?: string;
}

type Compiled = { [K in keyof TemplateSource]?: Handlebars.TemplateDelegate };

@Injectable()
export class TemplateRenderer {
  // Own Handlebars instance, so helpers registered here never leak globally.
  private readonly hbs = Handlebars.create();
  // Map keeps insertion order: re-inserting on hit makes it an LRU.
  private readonly cache = new Map<string, Compiled>();

  /**
   * Compiles every part, throwing on syntax errors. Used to validate
   * content before it is stored, so a broken template can't be published.
   */
  compile(source: TemplateSource): void {
    this.compileParts(source);
  }

  /**
   * Renders a stored version. `cacheKey` identifies the immutable source
   * (the version id). `subjectOverride` (an already rendered request
   * subject) replaces the template's; either way the final subject is
   * available to the body as {{subject}} (<title>{{subject}}</title>).
   */
  render(cacheKey: string, source: TemplateSource, data: TemplateData, subjectOverride?: string): RenderedContent {
    const compiled = this.cached(cacheKey, source);
    const subject = subjectOverride ?? compiled.subject?.(data);
    const withSubject = { ...data, subject };
    return {
      subject,
      body: compiled.body?.(withSubject).trim(),
      html: compiled.html?.(withSubject).trim(),
    };
  }

  /** Renders an inline string such as a request subject ("Hi {{name}}"). */
  renderText(text: string, data: TemplateData): string {
    return this.hbs.compile(text, { noEscape: true, strict: false })(data);
  }

  private cached(key: string, source: TemplateSource): Compiled {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const compiled = this.compileParts(source);
    this.cache.set(key, compiled);
    if (this.cache.size > LIMITS.TEMPLATE_COMPILE_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return compiled;
  }

  /** Handlebars compiles lazily; precompile() surfaces syntax errors now. */
  private compileParts(source: TemplateSource): Compiled {
    const part = (text: string | null | undefined, escape: boolean) => {
      if (!text) return undefined;
      this.hbs.precompile(text);
      return this.hbs.compile(text, { noEscape: !escape });
    };
    return { subject: part(source.subject, false), body: part(source.body, false), html: part(source.html, true) };
  }
}
