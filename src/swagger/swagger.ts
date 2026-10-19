/**
 * Swagger (OpenAPI) setup. Generates documentation from controller and DTO
 * decorators and serves an interactive UI at /<SWAGGER_PATH>.
 * Set SWAGGER_USER/SWAGGER_PASS to put the docs behind HTTP basic auth.
 */

import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppConfig } from '../config/configuration.js';
import { HEADER, SECURITY } from '../constant/index.js';
import { safeEqual } from '../utils/appUtils.js';

/** Same entry-point style as the backend's SwaggerConfig. */
export class SwaggerConfig {
  /**
   * Builds the OpenAPI document and mounts the UI. Must run before
   * app.listen(), because Fastify hooks can't be added after start.
   */
  static setup(app: NestFastifyApplication, config: AppConfig): void {
    const { path, user, pass } = config.swagger;
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle(config.name)
        .setDescription(
          'Multi-tenant email, SMS and push notification service.\n\n' +
            `Tenant routes need the \`${HEADER.API_KEY}\` header; admin routes need \`${HEADER.ADMIN_KEY}\`. ` +
            'Every response uses the envelope `{ statusCode, type, message, data }`. ' +
            `Send a \`${HEADER.LANGUAGE}\` header to localise \`message\`.`,
        )
        .setVersion('1.0')
        .addApiKey({ type: 'apiKey', in: 'header', name: HEADER.API_KEY }, SECURITY.TENANT)
        .addApiKey({ type: 'apiKey', in: 'header', name: HEADER.ADMIN_KEY }, SECURITY.ADMIN)
        .build(),
    );

    if (user && pass) {
      const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      app
        .getHttpAdapter()
        .getInstance()
        .addHook('onRequest', (request, reply, done) => {
          const isDocs = request.url === `/${path}` || request.url.startsWith(`/${path}/`);
          if (isDocs && !safeEqual(request.headers.authorization ?? '', expected)) {
            reply.header('www-authenticate', 'Basic realm="docs"').code(401).send();
            return;
          }
          done();
        });
    }

    SwaggerModule.setup(path, app, document, {
      jsonDocumentUrl: `${path}/json`,
      swaggerOptions: { persistAuthorization: true },
    });
  }
}
