/**
 * Templates module. Provides TemplatesService to any module that imports it.
 */

// Module decorator.
import { Module } from '@nestjs/common';
// The Handlebars renderer.
import { TemplatesService } from './templates.service.js';

@Module({
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
