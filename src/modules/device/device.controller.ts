/**
 * communication_hub.v1.DeviceService (tenant API key): push token registry.
 */

import { Controller } from '@nestjs/common';
import { GrpcMethod, Payload } from '@nestjs/microservices';
import { CurrentTenant, type TenantContext } from '../../decorator/index.js';
import { ListDevicesDto, RegisterDeviceDto, UnregisterDeviceDto } from '../../dto/index.js';
import { compact, PlatformCodec, Timestamp } from '../../grpc/codecs.js';
import { validateInput } from '../../grpc/validate.js';
import { DeviceToken } from '../../models/index.js';
import { DeviceService } from './device.service.js';

const SERVICE = 'DeviceService';

const toProtoDevice = (d: DeviceToken) => ({
  id: d.id,
  userId: d.userId,
  token: d.token,
  platform: PlatformCodec.encode(d.platform),
  active: d.isActive,
  lastSeenAt: Timestamp.encode(d.lastSeenAt),
  createdAt: Timestamp.encode(d.createdAt),
});

@Controller()
export class DeviceController {
  constructor(private readonly devices: DeviceService) {}

  /** Registers a token, or refreshes it (call on every app start/login). */
  @GrpcMethod(SERVICE, 'RegisterDevice')
  async register(@Payload() req: { userId?: string; token?: string; platform?: string }, @CurrentTenant() tenant: TenantContext) {
    const dto = validateInput(RegisterDeviceDto, compact({ ...req, platform: PlatformCodec.decode(req.platform) }));
    return toProtoDevice(await this.devices.register(tenant.tenantId, dto));
  }

  @GrpcMethod(SERVICE, 'ListDevices')
  async list(@Payload() req: { userId?: string }, @CurrentTenant() tenant: TenantContext) {
    const { userId } = validateInput(ListDevicesDto, req);
    return { devices: (await this.devices.list(tenant.tenantId, userId)).map(toProtoDevice) };
  }

  @GrpcMethod(SERVICE, 'UnregisterDevice')
  async unregister(@Payload() req: { token?: string }, @CurrentTenant() tenant: TenantContext) {
    await this.devices.unregister(tenant.tenantId, validateInput(UnregisterDeviceDto, req).token);
    return {};
  }
}
