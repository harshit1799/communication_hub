/**
 * Tenant-managed configuration end to end, over gRPC:
 *
 *   1. Templates live in the database and are versioned without deployments
 *   2. Several senders per channel, chosen at send time or by rule
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
  const senders = (method: string, req: object) => hub.call('SenderService', method, req, hub.tenant(tenant.key));
  const providers = (method: string, req: object) => hub.call('ProviderAdminService', method, req, hub.admin());
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

  describe('2. Multiple senders, chosen at send time or by rule', () => {
    let support: Msg;
    let vip: Msg;

    beforeAll(async () => {
      support = await senders('CreateSender', { channel: 'CHANNEL_EMAIL', value: 'Acme Support <support@acme.test>', isDefault: true });
      vip = await senders('CreateSender', { channel: 'CHANNEL_EMAIL', value: 'Acme VIP <vip@acme.test>' });
      await senders('CreateSenderRule', {
        channel: 'CHANNEL_EMAIL',
        match: 'SENDER_RULE_MATCH_RECIPIENT_DOMAIN',
        matchValue: 'vip.example.com',
        senderId: vip.id,
        priority: 10,
      });
    });

    const email = (recipient: string, extra: object = {}) => ({ channel: 'CHANNEL_EMAIL', recipient, subject: 'Hi', body: 'Hello', ...extra });

    it('uses the tenant default sender when no rule matches', async () => {
      const { attempts } = await delivered(email('jane@other.example.com'));
      expect(attempts[0].sender).toBe(support.value);
    });

    it('applies a matching rule', async () => {
      const { attempts } = await delivered(email('boss@VIP.example.com'));
      expect(attempts[0].sender).toBe(vip.value);
    });

    it('an explicit sender_id wins over rules', async () => {
      const { notification, attempts } = await delivered(email('boss@vip.example.com', { senderId: support.id }));
      expect(notification.senderId).toBe(support.id);
      expect(attempts[0].sender).toBe(support.value);
    });

    it('rejects unknown senders and makes only one default per channel', async () => {
      await hub.expectError(send(email('a@b.com', { senderId: randomUUID() })), status.NOT_FOUND, 'SENDER_NOT_FOUND');
      await senders('UpdateSender', { id: vip.id, isDefault: true });
      const list = await senders('ListSenders', { channel: 'CHANNEL_EMAIL' });
      expect(list.senders.filter((s: Msg) => s.isDefault).map((s: Msg) => s.id)).toEqual([vip.id]);
      await senders('UpdateSender', { id: support.id, isDefault: true });
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
      const broken = await providers('CreateProviderConfig', {
        tenantId: tenant.id,
        channel: 'CHANNEL_EMAIL',
        provider: 'smtp',
        name: 'smtp-down',
        priority: 1,
        settings: { host: '127.0.0.1', port: '1' },
      });
      const backup = await providers('CreateProviderConfig', {
        tenantId: tenant.id,
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
      await providers('UpdateProviderConfig', { tenantId: tenant.id, id: broken.id, active: false });
      const after = await delivered(email);
      expect(after.attempts.map((a: Msg) => a.provider)).toEqual(['console']);
      await providers('DeleteProviderConfig', { tenantId: tenant.id, id: backup.id });
      await providers('DeleteProviderConfig', { tenantId: tenant.id, id: broken.id });
    });

    it('stores credentials encrypted and never returns them', async () => {
      const created = await providers('CreateProviderConfig', {
        tenantId: tenant.id,
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
      await providers('DeleteProviderConfig', { tenantId: tenant.id, id: created.id });
    });

    it('validates provider settings per kind', async () => {
      await hub.expectError(
        providers('CreateProviderConfig', { tenantId: tenant.id, channel: 'CHANNEL_EMAIL', provider: 'sendgrid', name: 'sg', priority: 1 }),
        status.INVALID_ARGUMENT,
        'PROVIDER_CONFIG_INVALID',
      );
      await hub.expectError(
        providers('CreateProviderConfig', { tenantId: tenant.id, channel: 'CHANNEL_SMS', provider: 'ses', name: 'wrong', priority: 1, settings: { region: 'x' } }),
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
