/**
 * In-app inbox: InboxService (gRPC) and the worker-side write used by the
 * dispatcher for CHANNEL_IN_APP.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxMessage } from '../../models/index.js';
import { InboxController } from './inbox.controller.js';
import { InboxRepository } from './inbox.repository.js';
import { InboxService } from './inbox.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([InboxMessage])],
  controllers: [InboxController],
  providers: [InboxRepository, InboxService],
  exports: [InboxService],
})
export class InboxModule {}
