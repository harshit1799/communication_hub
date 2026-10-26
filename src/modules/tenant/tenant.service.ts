/**
 * Tenant and API key management (admin API + bootstrap).
 */

import { Injectable } from '@nestjs/common';
import { CreateApiKeyDto, CreateTenantDto, UpdateTenantDto } from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { ApiKey, Tenant } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { TemplateService } from '../template/template.service.js';
import { ApiKeyRepository } from './api-key.repository.js';
import { ApiKeyService } from './api-key.service.js';
import { TenantRepository } from './tenant.repository.js';

/** Postgres error code for unique constraint violations (unique_violation). */
const UNIQUE_VIOLATION = '23505';

/** A newly issued key: the only time the raw key is returned. */
export interface IssuedKey {
  apiKey: ApiKey;
  key: string;
}

/** Used by the admin controller and by BootstrapService. */
@Injectable()
export class TenantService {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly apiKeyRepository: ApiKeyRepository,
    private readonly apiKeys: ApiKeyService,
    private readonly templates: TemplateService,
  ) {}

  /**
   * Creates a tenant with the starter templates (one transaction) and its
   * first ("default") key. `rawKey` lets the bootstrap use a known key;
   * normally a random one is generated. Throws TENANT_SLUG_TAKEN.
   */
  async create(dto: CreateTenantDto, rawKey?: string): Promise<{ tenant: Tenant; apiKey: IssuedKey }> {
    let tenant: Tenant;
    try {
      tenant = await this.tenants.transaction(async (manager) => {
        const created = await manager.getRepository(Tenant).save(
          manager.getRepository(Tenant).create({ name: dto.name, slug: dto.slug, settings: { ...dto.settings } }),
        );
        await this.templates.seedStarterTemplates(created.id, manager);
        return created;
      });
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new AppException(ERROR.TENANT_SLUG_TAKEN);
      }
      throw err;
    }
    return { tenant, apiKey: await this.apiKeys.issue(tenant.id, 'default', undefined, rawKey) };
  }

  /** All tenants, newest first. */
  findAll(): Promise<Tenant[]> {
    return this.tenants.findAll();
  }

  /** The tenant with this slug, or null. */
  findBySlug(slug: string): Promise<Tenant | null> {
    return this.tenants.findBySlug(slug);
  }

  /** The tenant with this id. Throws TENANT_NOT_FOUND. */
  async findOne(id: string): Promise<Tenant> {
    const tenant = await this.tenants.findById(id);
    if (!tenant) throw new AppException(ERROR.TENANT_NOT_FOUND);
    return tenant;
  }

  /**
   * Applies the changes and invalidates the tenant's cached keys, so a
   * deactivation or new branding applies to the very next request.
   */
  async update(dto: UpdateTenantDto): Promise<Tenant> {
    const id = dto.id;
    const tenant = await this.findOne(id);
    if (dto.name !== undefined) tenant.name = dto.name;
    if (dto.isActive !== undefined) tenant.isActive = dto.isActive;
    if (dto.settings) tenant.settings = { ...tenant.settings, ...dto.settings };
    const saved = await this.tenants.save(tenant);
    // Cached keys embed tenant status and settings.
    await this.apiKeys.invalidateTenant(id);
    return saved;
  }

  /** Issues a new key for an existing tenant. */
  async createApiKey(dto: CreateApiKeyDto): Promise<IssuedKey> {
    await this.findOne(dto.tenantId);
    return this.apiKeys.issue(dto.tenantId, dto.name, dto.expiresAt);
  }

  /** Metadata of all keys of a tenant (including revoked ones). */
  async listApiKeys(tenantId: string): Promise<ApiKey[]> {
    await this.findOne(tenantId);
    return this.apiKeyRepository.findByTenant(tenantId);
  }

  /** Revokes a key; revoking an already revoked key is a no-op. */
  async revokeApiKey(tenantId: string, keyId: string): Promise<void> {
    const apiKey = await this.apiKeyRepository.findForTenant(tenantId, keyId);
    if (!apiKey) throw new AppException(ERROR.API_KEY_NOT_FOUND);
    if (!apiKey.revokedAt) await this.apiKeys.revoke(apiKey);
  }
}
