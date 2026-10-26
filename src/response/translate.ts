/**
 * Translates an error `type` into a message in the caller's language
 * (`language` metadata). Falls back to the type itself when no translation
 * exists, same as the backend service.
 */

import { I18nService } from 'nestjs-i18n';

/** Returns the translated message for `type`, or `type` itself. */
export function translate(
  i18n: I18nService | undefined,
  type: string,
  lang: string | undefined,
  args?: Record<string, unknown>,
): string {
  if (!i18n || !type) return type;
  const key = `messages.${type}`;
  const message = i18n.translate(key, { lang, args });
  return typeof message === 'string' && message !== key ? message : type;
}
