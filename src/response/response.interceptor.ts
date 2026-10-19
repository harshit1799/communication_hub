/**
 * Wraps every successful response in the standard envelope:
 *   { statusCode, type, message, data }
 * `type` comes from the @ResponseMessage() decorator on the handler.
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply } from 'fastify';
import { I18nContext } from 'nestjs-i18n';
import { map, Observable } from 'rxjs';
import { RESPONSE_MESSAGE_KEY } from '../decorator/response.decorator.js';
import { SUCCESS } from './response.js';
import { translate } from './translate.js';

/** Shape of every successful response body. */
export interface ResponseEnvelope<T> {
  statusCode: number;
  type: string;
  message: string;
  data: T;
}

/** Registered globally as APP_INTERCEPTOR. */
@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, ResponseEnvelope<T>>
{
  constructor(private readonly reflector: Reflector) {}

  /**
   * Wraps the handler result in the envelope. The status code is read
   * from the reply, so @HttpCode(202) etc. is respected.
   */
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ResponseEnvelope<T>> {
    const type =
      this.reflector.get<string>(RESPONSE_MESSAGE_KEY, context.getHandler()) ??
      SUCCESS.OK;
    return next.handle().pipe(
      map((data) => ({
        statusCode: context.switchToHttp().getResponse<FastifyReply>().statusCode,
        type,
        message: translate(I18nContext.current(), type),
        data,
      })),
    );
  }
}
