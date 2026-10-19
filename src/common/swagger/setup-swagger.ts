/**
 * Swagger (OpenAPI) setup. Generates API documentation from controller and
 * DTO decorators and serves an interactive UI.
 */

// INestApplication: type of the running Nest app.
import { INestApplication } from '@nestjs/common';
// DocumentBuilder: builds the base OpenAPI document; SwaggerModule: serves it.
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// Tenant header name, registered as an auth scheme in Swagger.
import { TENANT_HEADER } from '../constants.js';

/**
 * Creates the OpenAPI document and mounts Swagger UI.
 * @param app  The Nest application.
 * @param opts path = URL path for the UI, title/version = document metadata.
 */
export function setupSwagger(
  app: INestApplication,
  opts: { path: string; title: string; version: string },
) {
  // Describe the API (title, description, version, auth schemes).
  const config = new DocumentBuilder()
    // Title shown at the top of the Swagger page.
    .setTitle(opts.title)
    // Description shown under the title (Markdown is supported).
    .setDescription(
      'White-label notification service. Every tenant-scoped request must ' +
        `carry the \`${TENANT_HEADER}\` header.`,
    )
    // API version shown in the UI.
    .setVersion(opts.version)
    // Register the tenant header as an "API key" so the Authorize button
    // lets users enter it once and sends it with every request.
    .addApiKey(
      { type: 'apiKey', name: TENANT_HEADER, in: 'header' },
      TENANT_HEADER,
    )
    // Produce the final configuration object.
    .build();

  // Scan all controllers/DTOs and generate the full OpenAPI document.
  const document = SwaggerModule.createDocument(app, config);
  // Serve the UI at /<path> and the raw JSON spec at /<path>/json.
  SwaggerModule.setup(opts.path, app, document, {
    jsonDocumentUrl: `${opts.path}/json`,
    // Keep the entered tenant header after a page refresh.
    swaggerOptions: { persistAuthorization: true },
  });
}
