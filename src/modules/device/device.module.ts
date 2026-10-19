/** Device module: the push token registry (controller, service, repository). */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeviceToken } from '../../models/index.js';
import { DeviceController } from './device.controller.js';
import { DeviceRepository } from './device.repository.js';
import { DeviceService } from './device.service.js';

/** Registers the device_tokens repository and exports it to the push worker. */
@Module({
  imports: [TypeOrmModule.forFeature([DeviceToken])],
  controllers: [DeviceController],
  providers: [DeviceRepository, DeviceService],
  // The push worker resolves userId -> tokens and deactivates dead tokens.
  exports: [DeviceRepository],
})
export class DeviceModule {}
