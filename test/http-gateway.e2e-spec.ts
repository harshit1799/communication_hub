/**
 * REST gateway + Swagger UI over the real gRPC server: routes come from the
 * protos' google.api.http annotations (GET reads, POST creates, PATCH,
 * DELETE), requests run the gRPC pipeline, and gRPC errors map to HTTP.
 */

import { HttpGateway } from '../src/gateway/http-gateway.js';
import { ADMIN_KEY, Hub, startHub } from './support/grpc-hub.js';

type Json = Record<string, any>;

describe('REST gateway + Swagger (e2e)', () => {
  let hub: Hub;
  let gateway: HttpGateway;
  let base: string;
  let apiKey: string;

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { 'x-api-key': apiKey }) => {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : undefined) as Json };
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
    const created = await call('POST', '/admin/tenants', { name: 'Gateway', slug: `e2e-gw-${Date.now()}` }, { 'x-admin-key': ADMIN_KEY });
    expect(created.status).toBe(201);
    apiKey = created.body.apiKey.key;
  });

  afterAll(async () => {
    await gateway?.stop();
    await hub?.close();
  });

  it('serves Swagger UI and a REST OpenAPI document generated from the protos', async () => {
    const page = await fetch(`${base}/docs`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('swagger-ui-bundle.js');
    expect((await fetch(`${base}/docs/swagger-ui-bundle.js`)).status).toBe(200);

    const doc = (await (await fetch(`${base}/docs/openapi.json`)).json()) as Json;
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths['/api/v1/notifications']).sort()).toEqual(['get', 'post']);
    expect(doc.paths['/api/v1/notifications'].post.responses).toHaveProperty('202');
    expect(doc.paths['/api/v1/notifications/{id}'].get.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(doc.paths['/api/v1/notifications'].get.parameters.map((p: Json) => p.name)).toContain('page.limit');
    expect(doc.paths['/api/v1/providers/{id}'].delete.responses).toHaveProperty('204');
    expect(doc.paths['/api/v1/providers'].post.security).toEqual([{ apiKey: [] }]);
    expect(doc.paths['/api/v1/admin/tenants'].post.security).toEqual([{ adminKey: [] }]);
    expect(doc.paths['/api/v1/users/{user_id}/inbox'].get).toBeDefined();
    expect(doc.components.schemas.Channel.enum).toEqual(['CHANNEL_EMAIL', 'CHANNEL_SMS', 'CHANNEL_PUSH', 'CHANNEL_IN_APP']);
    // Descriptions come from the proto comments.
    expect(doc.paths['/api/v1/notifications'].post.summary).toContain('Accepts one notification');
  });

  it('POST sends (202), GET reads by id and lists with query filters', async () => {
    const sent = await call('POST', '/notifications', { channel: 'CHANNEL_SMS', recipient: '+14155550123', template: 'otp', data: { code: '135790' } }, {
      'x-api-key': apiKey,
      'x-request-id': 'gw-req-1',
    });
    expect(sent.status).toBe(202);
    expect(sent.headers.get('x-request-id')).toBe('gw-req-1');
    expect(sent.body).toMatchObject({ replayed: false, notification: { status: 'NOTIFICATION_STATUS_QUEUED', data: { code: '135790' } } });
    const id = sent.body.notification.id as string;

    let got: Json = {};
    for (let i = 0; i < 50 && got.notification?.status !== 'NOTIFICATION_STATUS_SENT'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      got = (await call('GET', `/notifications/${id}`)).body;
    }
    expect(got.notification.status).toBe('NOTIFICATION_STATUS_SENT');
    expect(got.attempts).toHaveLength(1);

    const list = await call('GET', '/notifications?page.limit=1&channel=CHANNEL_SMS&recipient=%2B14155550123');
    expect(list.status).toBe(200);
    expect(list.body.notifications.map((n: Json) => n.id)).toEqual([id]);
    // Only one notification: last page, so no next cursor.
    expect(list.body.page.nextCursor).toBeUndefined();
  });

  it('PATCH updates, DELETE removes (204), path params bind to fields', async () => {
    const created = await call('POST', '/providers', {
      channel: 'CHANNEL_EMAIL',
      provider: 'console',
      name: 'gw-console',
      settings: { from: 'Acme <hi@acme.test>' },
    });
    expect(created).toMatchObject({ status: 201, body: { priority: 100, settings: { from: 'Acme <hi@acme.test>' } } });
    const patched = await call('PATCH', `/providers/${created.body.id}`, { priority: 5, active: false });
    expect(patched).toMatchObject({ status: 200, body: { id: created.body.id, priority: 5, active: false } });
    expect((await call('GET', `/providers?channel=CHANNEL_EMAIL`)).body.providers.map((p: Json) => p.id)).toContain(created.body.id);

    const deleted = await call('DELETE', `/providers/${created.body.id}`);
    expect(deleted.status).toBe(204);
    expect(deleted.body).toBeUndefined();
    expect(await call('DELETE', `/providers/${created.body.id}`)).toMatchObject({ status: 404, body: { type: 'PROVIDER_CONFIG_NOT_FOUND' } });
  });

  it('inbox routes are nested under the user', async () => {
    const res = await call('GET', '/users/someone/inbox?unread_only=true&page.limit=5');
    expect(res).toMatchObject({ status: 200, body: { unreadCount: 0 } });
    expect((await call('GET', '/users/someone/inbox/unread-count')).body).toEqual({ unreadCount: 0 });
  });

  it('maps gRPC errors to HTTP statuses with the error type', async () => {
    const invalid = await call('POST', '/notifications', { channel: 'CHANNEL_SMS', recipient: '123', body: 'x' });
    expect(invalid).toMatchObject({ status: 400, body: { code: 'INVALID_ARGUMENT', type: 'VALIDATION_ERROR' } });
    expect(invalid.body.data.errors[0]).toContain('E.164');
    expect(await call('GET', '/notifications', undefined, {})).toMatchObject({ status: 401, body: { type: 'API_KEY_MISSING' } });
    expect(await call('GET', '/notifications/7d3f4b6e-2f7a-4c43-9d1e-2a9a3c1b5e10')).toMatchObject({ status: 404, body: { type: 'NOTIFICATION_NOT_FOUND' } });
  });

  it('rejects wrong methods, unknown routes and bad parameters', async () => {
    const wrong = await call('PUT', '/notifications', {});
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST, GET');
    expect((await call('GET', '/nothing-here')).status).toBe(404);
    expect((await call('GET', '/notifications?nope=1')).body.message).toContain('unknown parameter');
    expect((await call('GET', '/notifications?page.limit=ten')).body.message).toContain('must be an integer');
    expect((await call('GET', '/notifications?channel=EMAIL')).body.message).toContain('CHANNEL_EMAIL');
    expect((await call('POST', '/notifications', { nope: 1 })).status).toBe(400);
    const bad = await fetch(`${base}/api/v1/notifications`, { method: 'POST', body: '{oops', headers: { 'x-api-key': apiKey } });
    expect(bad.status).toBe(400);
  });
});
