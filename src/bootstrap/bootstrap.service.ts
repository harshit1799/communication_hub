/**
 * Startup tasks, same role as the backend's BootstrapService:
 *
 *   - registers the maintenance job scheduler (idempotent upsert, so every
 *     replica can run it safely; BullMQ keeps exactly one schedule)
 *   - optionally seeds a tenant with a known API key from BOOTSTRAP_TENANT_*
 *     (handy locally and for the first deploy; skipped if it exists)
 */

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AppConfig } from '../config/configuration.js';
import { AppRole, MAINTENANCE_JOB, MAINTENANCE_QUEUE } from '../constant/index.js';
import { AppException } from '../exceptions/index.js';
import { TenantService } from '../modules/tenant/tenant.service.js';
import { ERROR } from '../response/response.js';
import { errorMessage } from '../utils/appUtils.js';

// How often the stuck-notification sweeper runs.
const SWEEP_EVERY_MS = 60_000;
// How often expired inbox messages are purged.
const PURGE_INBOX_EVERY_MS = 60 * 60_000;

/** Runs once per process after all modules are initialised. */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapService.name);
  private readonly app: AppConfig;

  constructor(
    private readonly tenants: TenantService,
    @InjectQueue(MAINTENANCE_QUEUE) private readonly maintenance: Queue,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
  }

  /** Nest lifecycle hook: runs after all modules are initialised. */
  async onApplicationBootstrap() {
    // Not awaited: with Redis down this waits until Redis is back, and that
    // must not hold up startup (the readiness probe reports Redis instead).
    this.scheduleMaintenance().then(
      () => this.logger.log(`Stuck-notification sweeper scheduled every ${SWEEP_EVERY_MS / 1000}s`),
      (err: unknown) => this.logger.error(`Could not schedule the sweeper: ${errorMessage(err)}`),
    );
    // Seeding writes to the DB; leave it to API processes (they also migrate).
    if (this.app.role !== AppRole.Worker) await this.seedTenant();
  }

  /**
   * Creates or updates the repeating sweeper job. upsertJobScheduler is
   * idempotent, so every replica can call it and only one schedule exists.
   */
  private async scheduleMaintenance() {
    await this.maintenance.upsertJobScheduler(
      MAINTENANCE_JOB.REQUEUE_STUCK,
      { every: SWEEP_EVERY_MS },
      { name: MAINTENANCE_JOB.REQUEUE_STUCK, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    await this.maintenance.upsertJobScheduler(
      MAINTENANCE_JOB.PURGE_INBOX,
      { every: PURGE_INBOX_EVERY_MS },
      { name: MAINTENANCE_JOB.PURGE_INBOX, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
  }

  /**
   * Creates the BOOTSTRAP_TENANT_* tenant if it doesn't exist yet.
   * Safe when several replicas start at once (the slug is unique).
   */
  private async seedTenant() {
    const { tenantName, tenantSlug, tenantApiKey } = this.app.bootstrap;
    if (!tenantSlug || !tenantApiKey) return;
    if (await this.tenants.findBySlug(tenantSlug)) return;
    try {
      await this.tenants.create({ name: tenantName ?? tenantSlug, slug: tenantSlug }, tenantApiKey);
      this.logger.log(`Bootstrap tenant "${tenantSlug}" created`);
    } catch (err) {
      // Another replica created it first.
      if (err instanceof AppException && err.getStatus() === ERROR.TENANT_SLUG_TAKEN.status) return;
      this.logger.error(`Bootstrap tenant creation failed: ${errorMessage(err)}`);
    }
  }
}
