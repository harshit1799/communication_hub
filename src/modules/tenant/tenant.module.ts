/** Tenant module: tenants, API keys and the admin API to manage them. */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiKey, Tenant } from '../../models/index.js';
import { ApiKeyRepository } from './api-key.repository.js';
import { ApiKeyService } from './api-key.service.js';
import { TenantController } from './tenant.controller.js';
import { TenantRepository } from './tenant.repository.js';
import { TenantService } from './tenant.service.js';

/** Registers the tenants and api_keys repositories and the admin controller. */
@Module({
  imports: [TypeOrmModule.forFeature([Tenant, ApiKey])],
  controllers: [TenantController],
  providers: [TenantRepository, ApiKeyRepository, ApiKeyService, TenantService],
  // ApiKeyService: used by the global AuthGuard. TenantService: bootstrap.
  exports: [ApiKeyService, TenantService],
})
export class TenantModule {}
