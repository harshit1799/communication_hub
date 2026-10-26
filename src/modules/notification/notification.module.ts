/**
 * Notifications: gRPC API and queue workers. Workers are always registered;
 * WorkerLifecycle starts them only in the worker/all roles (APP_ROLE).
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Notification, NotificationAttempt } from '../../models/index.js';
import { DeviceModule } from '../device/device.module.js';
import { InboxModule } from '../inbox/inbox.module.js';
import { ProviderModule } from '../provider/provider.module.js';
import { SenderModule } from '../sender/sender.module.js';
import { TemplateModule } from '../template/template.module.js';
import { MaintenanceProcessor } from './maintenance.processor.js';
import { NotificationAttemptRepository } from './notification-attempt.repository.js';
import { NotificationController } from './notification.controller.js';
import { NotificationDispatcher } from './notification.dispatcher.js';
import { EmailProcessor, InAppProcessor, PushProcessor, SmsProcessor } from './notification.processor.js';
import { NotificationQueue } from './notification.queue.js';
import { NotificationRepository } from './notification.repository.js';
import { NotificationService } from './notification.service.js';
import { WorkerLifecycle } from './worker-lifecycle.js';

// Worker side. Registered in every role; WorkerLifecycle decides at startup
// (from ConfigService) whether they run.
const workers = [NotificationDispatcher, EmailProcessor, SmsProcessor, PushProcessor, InAppProcessor, MaintenanceProcessor, WorkerLifecycle];

/** Wires the API side and the worker side (providers resolved per tenant at send time). */
@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, NotificationAttempt]),
    TemplateModule,
    SenderModule,
    ProviderModule,
    DeviceModule,
    InboxModule,
  ],
  controllers: [NotificationController],
  providers: [NotificationRepository, NotificationAttemptRepository, NotificationQueue, NotificationService, ...workers],
  exports: [NotificationQueue],
})
export class NotificationModule {}
