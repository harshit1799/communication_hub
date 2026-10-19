/** Bootstrap module: runs one-off startup tasks (see BootstrapService). */

import { Module } from '@nestjs/common';
import { TenantModule } from '../modules/tenant/tenant.module.js';
import { BootstrapService } from './bootstrap.service.js';

/** Needs TenantModule to seed the bootstrap tenant. */
@Module({
  imports: [TenantModule],
  providers: [BootstrapService],
})
export class BootstrapModule {}
