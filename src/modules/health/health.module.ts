/**
 * Health feature module. Groups the health controller so it can be imported
 * into AppModule.
 */

// Module: decorator that marks a class as a Nest module.
import { Module } from '@nestjs/common';
// The controller exposing GET /api/health.
import { HealthController } from './health.controller.js';

// Register the controller; this module has no services.
@Module({ controllers: [HealthController] })
export class HealthModule {}
