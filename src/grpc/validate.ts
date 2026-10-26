/**
 * Validates a decoded request against a class-validator DTO and returns
 * the DTO instance. Failures become VALIDATION_ERROR (INVALID_ARGUMENT) with
 * one message per field, nested errors flattened ("notifications.0.recipient ...").
 */

import { Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { AppException } from '../exceptions/index.js';
import { ERROR } from '../response/response.js';

/** Most fundamental rule first (class-validator lists constraints in reverse decorator order). */
function messages(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((e) => {
    const path = parent ? `${parent}.${e.property}` : e.property;
    const prefix = parent ? `${parent}.` : '';
    return [...Object.values(e.constraints ?? {}).reverse().map((m) => prefix + m), ...messages(e.children ?? [], path)];
  });
}

/** Returns the validated DTO or throws AppException(VALIDATION_ERROR). */
export function validateInput<T extends object>(cls: Type<T>, plain: object): T {
  const dto = plainToInstance(cls, plain);
  const errors = validateSync(dto, { whitelist: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    const list = messages(errors);
    throw new AppException(ERROR.VALIDATION_ERROR, { errors: list }, { detail: list[0] });
  }
  return dto;
}
