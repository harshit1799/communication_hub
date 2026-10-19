/**
 * End-to-end tests. Boots the full application in memory and sends real
 * HTTP requests to it with supertest. Needs a running PostgreSQL; the
 * connection defaults to the test database set in vitest.config.e2e.ts.
 */

// Type of the running Nest app.
import { INestApplication } from '@nestjs/common';
// Used to read the app config, same as main.ts.
import { ConfigService } from '@nestjs/config';
// Builds the application from AppModule for testing.
import { Test, TestingModule } from '@nestjs/testing';
// supertest: makes HTTP requests against the app without opening a port.
import request from 'supertest';
// Type of the HTTP server supertest talks to.
import { App } from 'supertest/types.js';
// Root module and the shared global setup.
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/app.setup.js';
// Typed config shape.
import { AppConfig } from './../src/config/configuration.js';
// Used to read rows straight from the database.
import { DataSource } from 'typeorm';

describe('Communication Hub (e2e)', () => {
  // App instance, recreated before each test.
  let app: INestApplication<App>;

  // Start a fresh app before each test.
  beforeEach(async () => {
    // Compile the full module tree.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Create the HTTP application.
    app = moduleFixture.createNestApplication();
    // Apply the same prefix, versioning and validation as production.
    configureApp(app, app.get(ConfigService).getOrThrow<AppConfig>('app'));
    // Initialise without listening on a port.
    await app.init();
  });

  // Shut the app down after each test to free resources.
  afterEach(async () => {
    await app.close();
  });

  it('GET /api/health', () => {
    // Health endpoint should return 200 with status "ok".
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
        expect(res.body.database).toBe('up');
      });
  });

  it('rejects requests without a tenant header', () => {
    // No x-tenant-id header -> 400.
    return request(app.getHttpServer())
      .post('/api/v1/notifications')
      .send({ channel: 'email', recipient: 'a@b.com', body: 'hi' })
      .expect(400);
  });

  it('validates the payload', () => {
    // Invalid channel and missing body -> 400 from ValidationPipe.
    return request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('x-tenant-id', 'acme')
      .send({ channel: 'carrier-pigeon', recipient: 'a@b.com' })
      .expect(400);
  });

  it('sends a plain email', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('x-tenant-id', 'acme')
      .send({
        channel: 'email',
        recipient: 'a@b.com',
        subject: 'Hi',
        body: 'hi',
      })
      .expect(201);
    // The console provider always succeeds.
    expect(res.body.status).toBe('sent');

    // The row is stored in Postgres with the final status.
    const [row] = await app
      .get(DataSource)
      .query('SELECT status, tenant_id FROM notifications WHERE id = $1', [
        res.body.id,
      ]);
    expect(row).toEqual({ status: 'sent', tenant_id: 'acme' });
  });

  it('sends an email from a template', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('x-tenant-id', 'acme')
      .send({
        channel: 'email',
        recipient: 'a@b.com',
        subject: 'Your code is {{code}}',
        template: 'otp',
        data: { name: 'Jane', code: '123456' },
      })
      .expect(201);
    expect(res.body.subject).toBe('Your code is 123456');
    expect(res.body.template).toBe('otp');
  });

  it('requires a subject for email', () => {
    return request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('x-tenant-id', 'acme')
      .send({ channel: 'email', recipient: 'a@b.com', body: 'hi' })
      .expect(400);
  });

  it('rejects unknown templates and templates on non-email channels', async () => {
    const server = app.getHttpServer();
    await request(server)
      .post('/api/v1/notifications')
      .set('x-tenant-id', 'acme')
      .send({
        channel: 'email',
        recipient: 'a@b.com',
        subject: 'Hi',
        template: 'nope',
      })
      .expect(400);
    await request(server)
      .post('/api/v1/notifications')
      .set('x-tenant-id', 'acme')
      .send({ channel: 'sms', recipient: '+10000000000', template: 'otp' })
      .expect(400);
  });
});
