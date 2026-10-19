/**
 * Data access for the `tenants` table.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant, TenantSettings } from '../../models/index.js';

/** Thin wrapper around the TypeORM repository. */
@Injectable()
export class TenantRepository {
  constructor(@InjectRepository(Tenant) private readonly tenants: Repository<Tenant>) {}

  /** Inserts a tenant. Throws a unique violation if the slug exists. */
  create(input: { name: string; slug: string; settings?: TenantSettings }): Promise<Tenant> {
    return this.tenants.save(this.tenants.create({ ...input, settings: input.settings ?? {} }));
  }

  /** Tenant by id, or null. */
  findById(id: string): Promise<Tenant | null> {
    return this.tenants.findOneBy({ id });
  }

  /** Tenant by slug, or null. */
  findBySlug(slug: string): Promise<Tenant | null> {
    return this.tenants.findOneBy({ slug });
  }

  /** All tenants, newest first. */
  findAll(): Promise<Tenant[]> {
    return this.tenants.find({ order: { createdAt: 'DESC' } });
  }

  /** Persists changes to a loaded tenant. */
  save(tenant: Tenant): Promise<Tenant> {
    return this.tenants.save(tenant);
  }
}
