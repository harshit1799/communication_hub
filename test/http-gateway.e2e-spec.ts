/**
 * HTTP/JSON gateway + Swagger UI over the real gRPC server: docs are served
 * and generated from proto/, JSON requests run the gRPC pipeline, and gRPC
 * errors map to HTTP statuses.
 */

import { HttpGateway } from '../src/gateway/http-gateway.js';
import { ADMIN_KEY, Hub, startHub } from './support/grpc-hub.js';

describe('HTTP gateway + Swagger (e2e)', () => {
  let hub: Hub;
  let gateway: HttpGateway;
  let base: string;
  let apiKey: string;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    hub = await startHub();
    gateway = new HttpGateway({
      grpcTarget: hub.address,
      port: 0,
      host: '127.0.0.1',
      maxBodyBytes: 1024 * 1024,
      title: 'Communication Hub',
      swagger: { enabled: true, path: '/docs' },
    });
    base = `http://127.0.0.1:${await gateway.start()}`;
    const created = await post('TenantAdminService/CreateTenant', { name: 'Gateway', slug: `e2e-gw-${Date.now()}` }, { 'x-admin-key': ADMIN_KEY });
    expect(created.status).toBe(200);
    apiKey = created.body.apiKey.key;
  });

  afterAll(async () => {
    await gateway?.stop();
    await hub?.close();
  });

  it('serves Swagger UI and an OpenAPI document generated from the protos', async () => {
    const page = await fetch(`${base}/docs`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('swagger-ui-bundle.js');
    expect((await fetch(`${base}/docs/swagger-ui-bundle.js`)).status).toBe(200);
    expect((await fetch(`${base}/docs/init.js`)).status).toBe(200);

    const doc = (await (await fetch(`${base}/docs/openapi.json`)).json()) as Record<string, any>;
    expect(doc.openapi).toBe('3.0.3');
    const send = doc.paths['/api/v1/NotificationService/SendNotification'].post;
    expect(send.security).toEqual([{ apiKey: [] }]);
    expect(doc.paths['/api/v1/TenantAdminService/CreateTenant'].post.security).toEqual([{ adminKey: [] }]);
    expect(doc.components.schemas.Channel.enum).toEqual(['CHANNEL_EMAIL', 'CHANNEL_SMS', 'CHANNEL_PUSH', 'CHANNEL_IN_APP']);
    expect(doc.paths['/api/v1/InboxService/ListInboxMessages']).toBeDefined();
    // Descriptions come from the proto comments.
    expect(send.summary).toContain('Accepts one notification');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
  });

  it('sends through the gRPC pipeline with proto3 JSON (Struct as object, timestamps as strings)', async () => {
    const res = await post(
      'NotificationService/SendNotification',
      { notification: { channel: 'CHANNEL_SMS', recipient: '+14155550123', template: 'otp', data: { code: '135790' } } },
      { 'x-api-key': apiKey, 'x-request-id': 'gw-req-1' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('gw-req-1');
    expect(res.body).toMatchObject({ replayed: false, notification: { status: 'NOTIFICATION_STATUS_QUEUED', data: { code: '135790' } } });
    expect(res.body.notification.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    let status = '';
    for (let i = 0; i < 50 && status !== 'NOTIFICATION_STATUS_SENT'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await post('NotificationService/GetNotification', { id: res.body.notification.id }, { 'x-api-key': apiKey })).body.notification.status;
    }
    expect(status).toBe('NOTIFICATION_STATUS_SENT');
  });

  it('maps gRPC errors to HTTP statuses with the error type', async () => {
    const invalid = await post('NotificationService/SendNotification', { notification: { channel: 'CHANNEL_SMS', recipient: '123', body: 'x' } }, { 'x-api-key': apiKey });
    expect(invalid).toMatchObject({ status: 400, body: { code: 'INVALID_ARGUMENT', type: 'VALIDATION_ERROR' } });
    expect(invalid.body.data.errors[0]).toContain('E.164');

    expect(await post('NotificationService/ListNotifications', {})).toMatchObject({ status: 401, body: { type: 'API_KEY_MISSING' } });
    const missing = await post('NotificationService/GetNotification', { id: '7d3f4b6e-2f7a-4c43-9d1e-2a9a3c1b5e10' }, { 'x-api-key': apiKey });
    expect(missing).toMatchObject({ status: 404, body: { type: 'NOTIFICATION_NOT_FOUND' } });
  });

  it('rejects malformed JSON, unknown fields, bad enums, wrong methods and unknown routes', async () => {
    expect((await post('NotificationService/SendNotification', { notification: { nope: 1 } }, { 'x-api-key': apiKey })).status).toBe(400);
    expect((await post('NotificationService/SendNotification', { notification: { channel: 'EMAIL' } }, { 'x-api-key': apiKey })).body.message).toContain('CHANNEL_EMAIL');
    const bad = await fetch(`${base}/api/v1/NotificationService/ListNotifications`, { method: 'POST', body: '{oops', headers: { 'x-api-key': apiKey } });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/v1/NotificationService/ListNotifications`)).status).toBe(405);
    expect((await post('Nope/Nothing', {})).status).toBe(404);
  });
});
