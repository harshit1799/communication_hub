/**
 * Prometheus metrics, scraped from GET /metrics on the ops port (OPS_PORT)
 * of every process (api and worker). Dashboards and alerts:
 * observability/grafana, observability/prometheus/alerts.yml.
 *
 * Labels are kept low-cardinality on purpose: channel, provider kind,
 * outcome, RPC method. Never tenant ids or recipients (that is what the
 * logs in Loki are for: they carry tenantId / notificationId per line).
 */

import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Callback that reports queue job counts when Prometheus scrapes. */
export type QueueDepthSource = () => Promise<{ queue: string; state: string; count: number }[]>;

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  // gRPC API
  readonly rpcRequests = new Counter({
    name: 'chub_grpc_requests_total',
    help: 'gRPC calls by method and status code',
    labelNames: ['method', 'code'] as const,
    registers: [this.registry],
  });
  readonly rpcDuration = new Histogram({
    name: 'chub_grpc_request_duration_seconds',
    help: 'gRPC call latency',
    labelNames: ['method'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  // Intake
  readonly accepted = new Counter({
    name: 'chub_notifications_accepted_total',
    help: 'Notifications accepted for delivery (replays excluded)',
    labelNames: ['channel', 'priority'] as const,
    registers: [this.registry],
  });
  readonly replayed = new Counter({
    name: 'chub_notifications_replayed_total',
    help: 'Requests answered with an earlier notification (idempotency key reuse)',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });

  // Delivery (worker)
  readonly attempts = new Counter({
    name: 'chub_delivery_attempts_total',
    help: 'Provider calls by outcome: success | transient_error | permanent_error',
    labelNames: ['channel', 'provider', 'outcome'] as const,
    registers: [this.registry],
  });
  readonly deliveryDuration = new Histogram({
    name: 'chub_delivery_duration_seconds',
    help: 'Time spent in the provider call',
    labelNames: ['channel', 'provider'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [this.registry],
  });
  readonly finished = new Counter({
    name: 'chub_notifications_finished_total',
    help: 'Notifications that reached a final state from the worker: sent | failed',
    labelNames: ['channel', 'status'] as const,
    registers: [this.registry],
  });
  readonly retries = new Counter({
    name: 'chub_delivery_retries_total',
    help: 'Attempts that failed transiently and were scheduled for another attempt',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });
  readonly failovers = new Counter({
    name: 'chub_provider_failovers_total',
    help: 'Transient provider failures handed over to the next provider',
    labelNames: ['channel', 'from_provider'] as const,
    registers: [this.registry],
  });
  readonly inboxSignals = new Counter({
    name: 'chub_inbox_signals_total',
    help: 'FCM signals after an in-app delivery: silent | visible | no_devices | failed',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });
  readonly inboxPurged = new Counter({
    name: 'chub_inbox_purged_total',
    help: 'Expired inbox messages deleted by the maintenance queue',
    registers: [this.registry],
  });
  readonly throttled = new Counter({
    name: 'chub_provider_throttled_total',
    help: 'Sends held back by a provider limit (spilled to the next provider or delayed): reason rate | concurrency',
    labelNames: ['channel', 'provider', 'reason'] as const,
    registers: [this.registry],
  });
  readonly requeued = new Counter({
    name: 'chub_sweeper_requeued_total',
    help: 'Stuck notifications re-enqueued by the maintenance sweeper',
    registers: [this.registry],
  });

  // Queue health, read from BullMQ at scrape time (prom-client calls collect()).
  private queueDepth?: QueueDepthSource;
  private readonly queueJobs: Gauge<'queue' | 'state'> = new Gauge({
    name: 'chub_queue_jobs',
    help: 'BullMQ jobs per queue and state (waiting, delayed, active, failed)',
    labelNames: ['queue', 'state'] as const,
    registers: [this.registry],
    collect: async () => {
      if (!this.queueDepth) return;
      const depths = await this.queueDepth().catch(() => []);
      this.queueJobs.reset();
      for (const { queue, state, count } of depths) this.queueJobs.set({ queue, state }, count);
    },
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'chub_' });
  }

  /** Registers where queue depth comes from (NotificationQueue). */
  setQueueDepthSource(source: QueueDepthSource): void {
    this.queueDepth = source;
  }

  /** Text exposition format for GET /metrics. */
  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
