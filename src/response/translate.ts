/**
 * Translates a response `type` into a message in the request's language
 * (`language` header or Accept-Language). Falls back to the type itself
 * when no translation exists, same as the backend service.
 */

import { I18nContext } from 'nestjs-i18n';

/** Returns the translated message for `type`, or `type` itself. */
export function translate(
  i18n: I18nContext | undefined,
  type: string,
  args?: Record<string, unknown>,
): string {
  if (!i18n || !type) return type;
  const key = `messages.${type}`;
  const message = i18n.t(key, { args });
  return typeof message === 'string' && message !== key ? message : type;
}
