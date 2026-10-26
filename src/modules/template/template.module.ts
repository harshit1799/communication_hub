/**
 * Template module: DB-stored, versioned templates (tenant gRPC service),
 * and TemplateService for the send path (accept-time resolution, rendering).
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Template, TemplateVersion } from '../../models/index.js';
import { TemplateRenderer } from '../../utils/template/template-renderer.js';
import { TemplateController } from './template.controller.js';
import { TemplateRepository } from './template.repository.js';
import { TemplateService } from './template.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Template, TemplateVersion])],
  controllers: [TemplateController],
  providers: [TemplateRepository, TemplateRenderer, TemplateService],
  exports: [TemplateService, TemplateRepository],
})
export class TemplateModule {}
