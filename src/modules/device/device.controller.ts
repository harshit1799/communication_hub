/**
 * /v1/devices: register, list and remove push tokens.
 */

import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiEnvelope,
  ApiErrors,
  CurrentTenant,
  ResponseMessage,
  TenantAuth,
  type TenantContext,
} from '../../decorator/index.js';
import { DeviceResponseDto, ListDevicesDto, RegisterDeviceDto, UnregisterDeviceDto } from '../../dto/index.js';
import { SUCCESS } from '../../response/response.js';
import { DeviceService } from './device.service.js';

/** Tenant-authenticated push token endpoints. */
@ApiTags('Devices')
@TenantAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.TOO_MANY_REQUESTS)
@Controller({ path: 'devices', version: '1' })
export class DeviceController {
  constructor(private readonly deviceService: DeviceService) {}

  /** Registers a token, or refreshes it (call on every app start/login). */
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Register (or refresh) a push token for a user' })
  @ApiEnvelope(DeviceResponseDto)
  @ResponseMessage(SUCCESS.DEVICE_REGISTERED)
  register(@CurrentTenant() tenant: TenantContext, @Body() dto: RegisterDeviceDto) {
    return this.deviceService.register(tenant.tenantId, dto);
  }

  /** Lists the devices of one user, including deactivated ones. */
  @Get()
  @ApiOperation({ summary: "List a user's devices" })
  @ApiEnvelope(DeviceResponseDto, { isArray: true })
  @ResponseMessage(SUCCESS.DEVICE_LISTING)
  list(@CurrentTenant() tenant: TenantContext, @Query() { userId }: ListDevicesDto) {
    return this.deviceService.list(tenant.tenantId, userId);
  }

  /** Removes a token. 404 if this tenant doesn't have it. */
  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a push token (e.g. on logout)' })
  @ApiErrors(HttpStatus.NOT_FOUND)
  @ResponseMessage(SUCCESS.DEVICE_UNREGISTERED)
  async unregister(@CurrentTenant() tenant: TenantContext, @Body() { token }: UnregisterDeviceDto) {
    await this.deviceService.unregister(tenant.tenantId, token);
    return {};
  }
}
