/**
 * Data access for the `tenants` table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BaseRepository } from '../../database/postgres/base.repository.js';
import { Tenant, TenantSettings } from '../../models/index.js';

/** Tenant queries; the common ones (findById, save, ...) come from BaseRepository. */
@Injectable()
export class TenantRepository extends BaseRepository<Tenant> {
  constructor(@InjectRepository(Tenant) repository: Repository<Tenant>) {
    super(repository);
  }

  /** Inserts a tenant. Throws a unique violation if the slug exists. */
  createTenant(input: { name: string; slug: string; settings?: TenantSettings }): Promise<Tenant> {
    return this.create({ ...input, settings: input.settings ?? {} });
  }

  /** Tenant by slug, or null. */
  findBySlug(slug: string): Promise<Tenant | null> {
    return this.findOne({ slug });
  }

  /** All tenants, newest first. */
  findAll(): Promise<Tenant[]> {
    return this.findMany({}, { order: { createdAt: 'DESC' } });
  }
}
