/** Template module: provides TemplateService to any module that renders messages. */

import { Module } from '@nestjs/common';
import { TemplateService } from './template.service.js';

/** Stateless renderer with an in-memory cache of compiled templates. */
@Module({
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplateModule {}
