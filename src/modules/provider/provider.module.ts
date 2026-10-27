/**
 * Provider module: the tenant's provider configs (ProviderService) and the
 * send-path pieces the workers use (ProviderResolver + ProviderRegistry).
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProviderConfig } from '../../models/index.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { ProviderConfigService } from './provider-config.service.js';
import { ProviderController } from './provider.controller.js';
import { ProviderRegistry } from './provider.registry.js';
import { ProviderResolver } from './provider.resolver.js';

@Module({
  imports: [TypeOrmModule.forFeature([ProviderConfig])],
  controllers: [ProviderController],
  providers: [ProviderConfigRepository, ProviderConfigService, ProviderRegistry, ProviderResolver],
  exports: [ProviderResolver, ProviderConfigRepository],
})
export class ProviderModule {}
