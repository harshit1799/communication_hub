/**
 * Admin API for tenants and their API keys. Requires the x-admin-key header.
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOnly, ApiEnvelope, ApiErrors, ResponseMessage } from '../../decorator/index.js';
import {
  ApiKeyParamsDto,
  ApiKeyResponseDto,
  CreateApiKeyDto,
  CreatedApiKeyResponseDto,
  CreatedTenantResponseDto,
  CreateTenantDto,
  TenantIdDto,
  TenantResponseDto,
  UpdateTenantDto,
} from '../../dto/index.js';
import { SUCCESS } from '../../response/response.js';
import { TenantService } from './tenant.service.js';

/** Admin-only endpoints (x-admin-key) for tenants and API keys. */
@ApiTags('Admin: Tenants')
@AdminOnly()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller({ path: 'admin/tenants', version: '1' })
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  /** Creates a tenant. The response contains its first API key. */
  @Post()
  @ApiOperation({ summary: 'Create a tenant and its first API key' })
  @ApiEnvelope(CreatedTenantResponseDto, { status: HttpStatus.CREATED })
  @ApiErrors(HttpStatus.CONFLICT)
  @ResponseMessage(SUCCESS.TENANT_CREATED)
  create(@Body() dto: CreateTenantDto) {
    return this.tenantService.create(dto);
  }

  /** Lists all tenants, newest first. */
  @Get()
  @ApiOperation({ summary: 'List tenants' })
  @ApiEnvelope(TenantResponseDto, { isArray: true })
  @ResponseMessage(SUCCESS.TENANT_LISTING)
  findAll() {
    return this.tenantService.findAll();
  }

  /** Gets one tenant. */
  @Get(':id')
  @ApiOperation({ summary: 'Get a tenant' })
  @ApiEnvelope(TenantResponseDto)
  @ApiErrors(HttpStatus.NOT_FOUND)
  @ResponseMessage(SUCCESS.TENANT_DETAILS)
  findOne(@Param() { id }: TenantIdDto) {
    return this.tenantService.findOne(id);
  }

  /** Updates a tenant. Takes effect immediately (cached keys are dropped). */
  @Patch(':id')
  @ApiOperation({ summary: 'Update name, settings or active status' })
  @ApiEnvelope(TenantResponseDto)
  @ApiErrors(HttpStatus.NOT_FOUND)
  @ResponseMessage(SUCCESS.TENANT_UPDATED)
  update(@Param() { id }: TenantIdDto, @Body() dto: UpdateTenantDto) {
    return this.tenantService.update(id, dto);
  }

  /** Issues an extra key, e.g. to rotate keys without downtime. */
  @Post(':id/api-keys')
  @ApiOperation({ summary: 'Issue an additional API key (for rotation)' })
  @ApiEnvelope(CreatedApiKeyResponseDto, { status: HttpStatus.CREATED })
  @ApiErrors(HttpStatus.NOT_FOUND)
  @ResponseMessage(SUCCESS.API_KEY_CREATED)
  createApiKey(@Param() { id }: TenantIdDto, @Body() dto: CreateApiKeyDto) {
    return this.tenantService.createApiKey(id, dto);
  }

  /** Lists key metadata. */
  @Get(':id/api-keys')
  @ApiOperation({ summary: "List a tenant's API keys (never returns the key itself)" })
  @ApiEnvelope(ApiKeyResponseDto, { isArray: true })
  @ApiErrors(HttpStatus.NOT_FOUND)
  @ResponseMessage(SUCCESS.API_KEY_LISTING)
  listApiKeys(@Param() { id }: TenantIdDto) {
    return this.tenantService.listApiKeys(id);
  }

  /** Revokes a key. Idempotent; requests with it fail immediately. */
  @Delete(':id/api-keys/:keyId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an API key (effective immediately)' })
  @ApiErrors(HttpStatus.NOT_FOUND)
  @ResponseMessage(SUCCESS.API_KEY_REVOKED)
  async revokeApiKey(@Param() { id, keyId }: ApiKeyParamsDto) {
    await this.tenantService.revokeApiKey(id, keyId);
    return {};
  }
}
