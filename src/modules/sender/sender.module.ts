/**
 * Sender module: sender identities and rules (tenant gRPC service) and the
 * SenderResolver used by the API (accept-time check) and the workers.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SenderIdentity, SenderRule } from '../../models/index.js';
import { ProviderModule } from '../provider/provider.module.js';
import { TemplateModule } from '../template/template.module.js';
import { SenderController } from './sender.controller.js';
import { SenderRepository } from './sender.repository.js';
import { SenderResolver } from './sender.resolver.js';
import { SenderService } from './sender.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([SenderIdentity, SenderRule]), ProviderModule, TemplateModule],
  controllers: [SenderController],
  providers: [SenderRepository, SenderResolver, SenderService],
  exports: [SenderResolver],
})
export class SenderModule {}
