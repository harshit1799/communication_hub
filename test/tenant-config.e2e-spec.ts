/**
 * Tenant-managed configuration end to end, over gRPC:
 *
 *   1. Templates live in the database and are versioned without deployments
 *   2. The "From": provider settings.from, overridable per send
 *   3. Providers per tenant from the DB (via the Redis cache), with failover
 *   4. Standard gRPC health checking
 */

import * as grpc from '@grpc/grpc-js';
import { status } from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { PROTO_FILES, PROTO_LOADER_OPTIONS } from '../src/grpc/grpc.options.js';
import { Hub, Msg, startHub, struct } from './support/grpc-hub.js';

describe('Tenant configuration (e2e)', () => {
  let hub: Hub;
  let tenant: { id: string; key: string };

  const send = (notification: object) => hub.call('NotificationService', 'SendNotification', { notification }, hub.tenant(tenant.key));
  const tpl = (method: string, req: object) => hub.call('TemplateService', method, req, hub.tenant(tenant.key));
  const providers = (method: string, req: object) => hub.call('ProviderService', method, req, hub.tenant(tenant.key));
  const delivered = async (notification: object) => hub.waitForFinal(tenant.key, (await send(notification)).notification.id);

  beforeAll(async () => {
    hub = await startHub();
    tenant = await hub.createTenant({ appName: 'Acme' });
  });

  afterAll(async () => {
    await hub?.close();
  });

  describe('1. Templates in the database, versioned', () => {
    it('new tenants get the starter templates', async () => {
      const { templates } = await tpl('ListTemplates', { channel: 'CHANNEL_SMS' });
      expect(templates.map((t: Msg) => t.name).sort()).toEqual(['otp', 'welcome']);
    });

    it('publishes new versions, pins the version per notification, and rolls back', async () => {
      const created = await tpl('CreateTemplate', { channel: 'CHANNEL_SMS', name: 'promo', content: { body: 'v1 for {{name}}' } });
      expect(created).toMatchObject({ activeVersion: 1, latestVersion: 1, archived: false });

      const first = await delivered({ channel: 'CHANNEL_SMS', recipient: '+14155550199', template: 'promo', data: struct({ name: 'Jo' }) });
      expect(first.notification.templateVersion).toBe(1);

      // Draft (not active) does not affect sends.
      const draft = await tpl('CreateTemplateVersion', { templateId: created.id, content: { body: 'v2 for {{name}}' }, activate: false });
      expect(draft).toMatchObject({ version: 2, active: false });
      const stillV1 = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550199', template: 'promo', data: struct({ name: 'Jo' }) });
      expect(stillV1.notification.templateVersion).toBe(1);

      // Publish v2: the next send uses it immediately (cache invalidated).
      await tpl('ActivateTemplateVersion', { templateId: created.id, version: 2 });
      const second = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550199', template: 'promo', data: struct({ name: 'Jo' }) });
      expect(second.notification.templateVersion).toBe(2);

      // A send can pin an older version explicitly.
      const pinned = await send({ channel: 'CHANNEL_SMS', recipient: '+14155550199', template: 'promo', templateVersion: 1 });
      expect(pinned.notification.templateVersion).toBe(1);

      const preview = await tpl('PreviewTemplate', { templateId: created.id, data: struct({ name: 'Sam' }) });
      expect(preview.body).toBe('v2 for Sam');

      // Roll back.
      expect((await tpl('ActivateTemplateVersion', { templateId: created.id, version: 1 })).activeVersion).toBe(1);
      const { versions } = await tpl('ListTemplateVersions', { id: created.id });
      expect(versions.map((v: Msg) => [v.version, v.active])).toEqual([
        [2, false],
        [1, true],
      ]);
    });

    it('rejects invalid content and duplicate names, and archived templates for new sends', async () => {
      await hub.expectError(
        tpl('CreateTemplate', { channel: 'CHANNEL_EMAIL', name: 'broken', content: { subject: 'Hi', html: '{{#if}}' } }),
        status.INVALID_ARGUMENT,
        'TEMPLATE_INVALID',
      );
      await hub.expectError(
        tpl('CreateTemplate', { channel: 'CHANNEL_EMAIL', name: 'no-subject', content: { html: '<p>x</p>' } }),
        status.INVALID_ARGUMENT,
        'TEMPLATE_INVALID',
      );
      await hub.expectError(
        tpl('CreateTemplate', { channel: 'CHANNEL_SMS', name: 'otp', content: { body: 'dup' } }),
        status.ALREADY_EXISTS,
        'TEMPLATE_NAME_TAKEN',
      );
      const t = await tpl('CreateTemplate', { channel: 'CHANNEL_SMS', name: 'old', content: { body: 'old' } });
      await tpl('ArchiveTemplate', { id: t.id });
      await hub.expectError(send({ channel: 'CHANNEL_SMS', recipient: '+14155550199', template: 'old' }), status.FAILED_PRECONDITION, 'TEMPLATE_ARCHIVED');
    });
  });

  describe('2. The From: provider settings.from, overridable per send', () => {
    let provider: Msg;
    const email = (extra: object = {}) => ({ channel: 'CHANNEL_EMAIL', recipient: 'jane@example.com', subject: 'Hi', body: 'Hello', ...extra });

    beforeAll(async () => {
      provider = await providers('CreateProvider', {
        channel: 'CHANNEL_EMAIL',
        provider: 'console',
        name: 'console-from',
        priority: 1,
        settings: { from: 'Acme Support <support@acme.test>' },
        fromAddresses: { billing: 'Acme Billing <billing@acme.test>', alerts: 'Acme Alerts <alerts@acme.test>' },
      });
    });

    afterAll(async () => {
      await providers('DeleteProvider', { id: provider.id });
    });

    it('sends as the provider settings.from', async () => {
      const { attempts } = await delivered(email());
      expect(attempts[0].sender).toBe('Acme Support <support@acme.test>');
    });

    it('a from on the request overrides it', async () => {
      const { notification, attempts } = await delivered(email({ from: 'Acme Billing <billing@acme.test>' }));
      expect(notification.from).toBe('Acme Billing <billing@acme.test>');
      expect(attempts[0].sender).toBe('Acme Billing <billing@acme.test>');
    });

    it('a From name picks the address (and the provider that has it), recorded on the notification', async () => {
      const { notification, attempts } = await delivered(email({ from: 'alerts' }));
      expect(notification).toMatchObject({ from: 'alerts', sentFrom: 'Acme Alerts <alerts@acme.test>', providerName: 'console-from' });
      expect(attempts[0]).toMatchObject({ sender: 'Acme Alerts <alerts@acme.test>', providerName: 'console-from', providerId: provider.id });
    });

    it('rejects an unknown From name when the send is made, and lists every From', async () => {
      await hub.expectError(send(email({ from: 'marketing' })), status.NOT_FOUND, 'FROM_NOT_FOUND');
      const { fromAddresses } = await providers('ListFromAddresses', { channel: 'CHANNEL_EMAIL' });
      expect(fromAddresses.map((a: Msg) => [a.name ?? '(default)', a.address, a.providerName, a.isDefault])).toEqual([
        ['(default)', 'Acme Support <support@acme.test>', 'console-from', true],
        ['alerts', 'Acme Alerts <alerts@acme.test>', 'console-from', false],
        ['billing', 'Acme Billing <billing@acme.test>', 'console-from', false],
      ]);
    });

    it('validates the From format per channel', async () => {
      await hub.expectError(send(email({ from: 'not an address' })), status.INVALID_ARGUMENT, 'VALIDATION_ERROR');
      await hub.expectError(
        send({ channel: 'CHANNEL_PUSH', recipient: 'tok', body: 'b', from: 'x@y.com' }),
        status.INVALID_ARGUMENT,
        'VALIDATION_ERROR',
      );
      await hub.expectError(
        providers('UpdateProvider', { id: provider.id, settings: { from: 'nope' } }),
        status.INVALID_ARGUMENT,
        'PROVIDER_CONFIG_INVALID',
      );
    });
  });

  describe('3. Providers per tenant, read through the cache, with failover', () => {
    it('falls back to the platform default, then uses tenant providers as soon as they are configured', async () => {
      const email = { channel: 'CHANNEL_EMAIL', recipient: 'x@example.com', subject: 's', body: 'b' };
      // No tenant providers yet: the platform default (console). This also
      // caches "no providers" for the tenant's email channel in Redis.
      expect((await delivered(email)).attempts.map((a: Msg) => a.provider)).toEqual(['console']);

      // Primary: an SMTP server that refuses connections (transient error);
      // backup: a working provider.
      const broken = await providers('CreateProvider', {
        channel: 'CHANNEL_EMAIL',
        provider: 'smtp',
        name: 'smtp-down',
        priority: 1,
        settings: { host: '127.0.0.1', port: '1' },
      });
      const backup = await providers('CreateProvider', {
        channel: 'CHANNEL_EMAIL',
        provider: 'console',
        name: 'console-backup',
        priority: 2,
      });
      expect(broken).toMatchObject({ provider: 'smtp', active: true, credentialKeys: [] });

      // The cache entry was dropped on create: the next email uses the
      // tenant providers in priority order. SMTP refuses the connection
      // (transient), the hub fails over to the backup within the attempt.
      const { notification, attempts } = await delivered(email);
      expect(notification).toMatchObject({ status: 'NOTIFICATION_STATUS_SENT', attempts: 1, provider: 'console' });
      expect(attempts.map((a: Msg) => [a.attempt, a.provider, a.success])).toEqual([
        [1, 'smtp', false],
        [1, 'console', true],
      ]);

      // Deactivating the broken one applies to the very next message.
      await providers('UpdateProvider', { id: broken.id, active: false });
      const after = await delivered(email);
      expect(after.attempts.map((a: Msg) => a.provider)).toEqual(['console']);
      await providers('DeleteProvider', { id: backup.id });
      await providers('DeleteProvider', { id: broken.id });
    });

    it('stores credentials encrypted and never returns them', async () => {
      const created = await providers('CreateProvider', {
        channel: 'CHANNEL_SMS',
        provider: 'twilio',
        name: 'twilio-main',
        priority: 5,
        settings: { messaging_service_sid: 'MG000' },
        credentials: { account_sid: 'AC123', auth_token: 'super-secret-token' },
      });
      expect(created.credentialKeys).toEqual(['account_sid', 'auth_token']);
      expect(JSON.stringify(created)).not.toContain('super-secret-token');
      const [row] = await hub.moduleRef.get(DataSource).query('SELECT credentials FROM provider_configs WHERE id = $1', [created.id]);
      expect(row.credentials).toMatch(/^enc:v1:e2e:/);
      expect(row.credentials).not.toContain('super-secret-token');
      await providers('DeleteProvider', { id: created.id });
    });

    it('belongs to the tenant: the admin key cannot manage it', async () => {
      await hub.expectError(hub.call('ProviderService', 'ListProviders', {}, hub.admin()), status.UNAUTHENTICATED, 'API_KEY_MISSING');
    });

    it('validates provider settings per kind', async () => {
      await hub.expectError(
        providers('CreateProvider', { channel: 'CHANNEL_EMAIL', provider: 'sendgrid', name: 'sg', priority: 1 }),
        status.INVALID_ARGUMENT,
        'PROVIDER_CONFIG_INVALID',
      );
      await hub.expectError(
        providers('CreateProvider', { channel: 'CHANNEL_SMS', provider: 'ses', name: 'wrong', priority: 1, settings: { region: 'x' } }),
        status.INVALID_ARGUMENT,
        'PROVIDER_CONFIG_INVALID',
      );
    });
  });

  describe('3b. Provider limits from the DB (retries, rate, concurrency)', () => {
    const sms = (body: string) => ({ channel: 'CHANNEL_SMS', recipient: '+14155550177', body });
    const created: string[] = [];
    const provider = async (body: object) => {
      const p = await providers('CreateProvider', { channel: 'CHANNEL_SMS', provider: 'console', ...body });
      created.push(p.id);
      return p;
    };

    afterEach(async () => {
      for (const id of created.splice(0)) await providers('DeleteProvider', { id });
    });

    it("the job gets the provider's retry policy", async () => {
      const p = await provider({ name: 'sms-retry', priority: 1, limits: { maxAttempts: 2, backoffMs: 250 } });
      expect(p.limits).toMatchObject({ maxAttempts: 2, backoffMs: 250 });
      const res = await send(sms('policy'));
      expect(res.queue.maxAttempts).toBe(2);
    });

    it('a rate limit spaces sends out across workers, without using attempts', async () => {
      await provider({ name: 'sms-slow', priority: 1, limits: { rateMax: 1, rateDurationMs: 700 } });
      const sent = await Promise.all([1, 2, 3].map((i) => send(sms(`rate ${i}`))));
      const done = await Promise.all(sent.map((r) => hub.waitForFinal(tenant.key, r.notification.id)));
      expect(done.every((d) => d.notification.status === 'NOTIFICATION_STATUS_SENT' && d.notification.attempts === 1)).toBe(true);
      const times = done.map((d) => Number(d.notification.sentAt.seconds) * 1000 + d.notification.sentAt.nanos / 1e6).sort((a, b) => a - b);
      // 1 per 700ms window: the three can't all go out within one window.
      expect(times[2] - times[0]).toBeGreaterThanOrEqual(600);
    });

    it('a provider at its limit spills over to the next one', async () => {
      await provider({ name: 'sms-capped', priority: 1, limits: { rateMax: 1, rateDurationMs: 60_000 } });
      await provider({ name: 'sms-overflow', priority: 2 });
      const sent = await Promise.all([1, 2, 3].map((i) => send(sms(`spill ${i}`))));
      const done = await Promise.all(sent.map((r) => hub.waitForFinal(tenant.key, r.notification.id)));
      const byProvider = done.map((d) => d.notification.providerName).sort();
      expect(byProvider).toEqual(['sms-capped', 'sms-overflow', 'sms-overflow']);
    });

    it('validates limits', async () => {
      await hub.expectError(
        providers('CreateProvider', { channel: 'CHANNEL_SMS', provider: 'console', name: 'bad-limits', limits: { rateMax: 5 } }),
        status.INVALID_ARGUMENT,
        'PROVIDER_CONFIG_INVALID',
      );
    });
  });

  describe('4. gRPC health checking', () => {
    it('reports SERVING through grpc.health.v1', async () => {
      const definition = protoLoader.loadSync(PROTO_FILES, PROTO_LOADER_OPTIONS);
      const pkg = grpc.loadPackageDefinition(definition) as unknown as { grpc: { health: { v1: { Health: grpc.ServiceClientConstructor } } } };
      // The harness client covers the hub's own services; Health is grpc.health.v1.
      const health = new pkg.grpc.health.v1.Health(hub.address, grpc.credentials.createInsecure()) as unknown as {
        Check(req: object, cb: (err: Error | null, res: Msg) => void): void;
        close(): void;
      };
      const check = (service: string) => new Promise<Msg>((resolve, reject) => health.Check({ service }, (err, res) => (err ? reject(err) : resolve(res))));
      expect((await check('')).status).toBe('SERVING');
      expect((await check('communication_hub.v1.NotificationService')).status).toBe('SERVING');
      expect((await check('nope.Service')).status).toBe('SERVICE_UNKNOWN');
      health.close();
    });
  });
});
