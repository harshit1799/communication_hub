/**
 * Tenant and API key management (admin API + bootstrap).
 */

import { Injectable } from '@nestjs/common';
import {
  ApiKeyResponseDto,
  CreateApiKeyDto,
  CreatedApiKeyResponseDto,
  CreatedTenantResponseDto,
  CreateTenantDto,
  UpdateTenantDto,
} from '../../dto/index.js';
import { AppException } from '../../exceptions/index.js';
import { ApiKey, Tenant } from '../../models/index.js';
import { ERROR } from '../../response/response.js';
import { ApiKeyRepository } from './api-key.repository.js';
import { ApiKeyService } from './api-key.service.js';
import { TenantRepository } from './tenant.repository.js';

/** Postgres error code for unique constraint violations (unique_violation). */
const UNIQUE_VIOLATION = '23505';

/** Used by the admin controller and by BootstrapService. */
@Injectable()
export class TenantService {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly apiKeyRepository: ApiKeyRepository,
    private readonly apiKeys: ApiKeyService,
  ) {}

  /**
   * Creates a tenant together with its first ("default") key. `rawKey` lets the
   * bootstrap use a known key; normally a random one is generated.
   * Throws TENANT_SLUG_TAKEN if the slug exists.
   */
  async create(dto: CreateTenantDto, rawKey?: string): Promise<CreatedTenantResponseDto> {
    let tenant: Tenant;
    try {
      tenant = await this.tenants.createTenant(dto);
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new AppException(ERROR.TENANT_SLUG_TAKEN);
      }
      throw err;
    }
    const { apiKey, key } = await this.apiKeys.issue(tenant.id, 'default', undefined, rawKey);
    return { tenant, apiKey: { ...this.toKeyDto(apiKey), key } };
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
  async update(id: string, dto: UpdateTenantDto): Promise<Tenant> {
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
  async createApiKey(tenantId: string, dto: CreateApiKeyDto): Promise<CreatedApiKeyResponseDto> {
    await this.findOne(tenantId);
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    const { apiKey, key } = await this.apiKeys.issue(tenantId, dto.name, expiresAt);
    return { ...this.toKeyDto(apiKey), key };
  }

  /** Metadata of all keys of a tenant (including revoked ones). */
  async listApiKeys(tenantId: string): Promise<ApiKeyResponseDto[]> {
    await this.findOne(tenantId);
    return (await this.apiKeyRepository.findByTenant(tenantId)).map((k) => this.toKeyDto(k));
  }

  /** Revokes a key; revoking an already revoked key is a no-op. */
  async revokeApiKey(tenantId: string, keyId: string): Promise<void> {
    const apiKey = await this.apiKeyRepository.findForTenant(tenantId, keyId);
    if (!apiKey) throw new AppException(ERROR.API_KEY_NOT_FOUND);
    if (!apiKey.revokedAt) await this.apiKeys.revoke(apiKey);
  }

  /** Never exposes the key hash. */
  private toKeyDto(k: ApiKey): ApiKeyResponseDto {
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      lastUsedAt: k.lastUsedAt,
      expiresAt: k.expiresAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    };
  }
}
