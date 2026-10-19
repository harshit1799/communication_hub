/**
 * Global HTTP setup shared by main.ts and the e2e tests, so both run the
 * application with exactly the same behaviour.
 */

import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { BadRequestException, ValidationError, ValidationPipe, VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppConfig } from './config/configuration.js';
import { HEADER } from './constant/index.js';
import { resolveRequestId } from './utils/request-id.js';

/**
 * The Fastify server: body limit, proxy trust and request ids. Created
 * before the app (and its ConfigService) exists, so the body limit comes
 * from the container environment (BODY_LIMIT_BYTES) or the 5 MB default.
 */
export function createFastifyAdapter(bodyLimit = Number(process.env.BODY_LIMIT_BYTES) || 5 * 1024 * 1024): FastifyAdapter {
  return new FastifyAdapter({
    bodyLimit,
    // Behind a load balancer: trust X-Forwarded-* for client IPs.
    trustProxy: true,
    genReqId: resolveRequestId,
  });
}

/**
 * One message per invalid field, most fundamental rule first (class-validator
 * lists constraints in reverse decorator order), nested errors flattened as
 * "notifications.0.recipient ...".
 */
function validationMessages(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((e) => {
    const path = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).reverse();
    const prefix = parent ? `${parent}.` : '';
    return [...own.map((m) => prefix + m), ...validationMessages(e.children ?? [], path)];
  });
}

/**
 * Registers security headers, compression, request-id echo, CORS, the
 * /api prefix, URI versioning and global validation on the app.
 */
export async function configureApp(app: NestFastifyApplication, config: AppConfig) {
  // Security headers. The CSP is relaxed just enough for Swagger UI.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: [`'self'`],
        styleSrc: [`'self'`, `'unsafe-inline'`],
        imgSrc: [`'self'`, 'data:', 'validator.swagger.io'],
        scriptSrc: [`'self'`, `https: 'unsafe-inline'`],
      },
    },
  });
  await app.register(compress, { encodings: ['gzip', 'deflate'] });
  // Echo the request id so clients can quote it in support requests.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, _payload, done) => {
      reply.header(HEADER.REQUEST_ID, request.id);
      done();
    });
  app.enableCors({
    origin: config.corsOrigins,
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      HEADER.API_KEY,
      HEADER.ADMIN_KEY,
      HEADER.REQUEST_ID,
      HEADER.IDEMPOTENCY_KEY,
      HEADER.LANGUAGE,
    ],
    exposedHeaders: [HEADER.REQUEST_ID, HEADER.IDEMPOTENT_REPLAYED],
    methods: 'GET,POST,PATCH,DELETE',
  });
  // /api/...
  app.setGlobalPrefix(config.apiPrefix);
  // /api/v1/...; routes default to version 1.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      // Strip and reject properties without validation decorators.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Plain JSON -> DTO instances (applies defaults and query param types).
      transform: true,
      exceptionFactory: (errors) => new BadRequestException(validationMessages(errors)),
    }),
  );
}
