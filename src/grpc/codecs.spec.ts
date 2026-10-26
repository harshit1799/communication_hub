/**
 * Proto <-> domain conversions and error -> gRPC status mapping.
 */

import { HttpStatus } from '@nestjs/common';
import { status } from '@grpc/grpc-js';
import { NotificationChannel } from '../constant/index.js';
import { ERROR } from '../response/response.js';
import { ChannelCodec, compact, Struct, Timestamp } from './codecs.js';
import { grpcCode } from './rpc-exception.filter.js';

describe('codecs', () => {
  it('maps enums both ways; unspecified/unknown decode to undefined', () => {
    expect(ChannelCodec.decode('CHANNEL_EMAIL')).toBe(NotificationChannel.Email);
    expect(ChannelCodec.encode(NotificationChannel.Sms)).toBe('CHANNEL_SMS');
    expect(ChannelCodec.decode('CHANNEL_UNSPECIFIED')).toBeUndefined();
    expect(ChannelCodec.decode('CHANNEL_FAX')).toBeUndefined();
  });

  it('round-trips timestamps with millisecond precision', () => {
    const date = new Date('2026-10-25T12:34:56.789Z');
    expect(Timestamp.encode(date)).toEqual({ seconds: String(Math.floor(date.getTime() / 1000)), nanos: 789_000_000 });
    expect(Timestamp.decode(Timestamp.encode(date))).toEqual(date);
    expect(Timestamp.decode(undefined)).toBeUndefined();
  });

  it('round-trips nested Struct values', () => {
    const value = { name: 'Jane', n: 3, ok: true, nothing: null, list: [1, 'a'], nested: { deep: 'x' } };
    // proto-loader (oneofs: true) adds `kind`; simulate the decoded wire shape.
    const withKinds = JSON.parse(JSON.stringify(Struct.encode(value)), (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && !('fields' in v) && !('values' in v)) {
        const kind = Object.keys(v).find((k) => k.endsWith('Value'));
        if (kind) return { ...v, kind };
      }
      return v;
    });
    expect(Struct.decode(withKinds)).toEqual(value);
  });

  it('compact drops unset fields', () => {
    expect(compact({ a: 1, b: undefined, c: null, d: '' })).toEqual({ a: 1, d: '' });
  });
});

describe('grpcCode', () => {
  it.each([
    [ERROR.VALIDATION_ERROR, status.INVALID_ARGUMENT],
    [ERROR.API_KEY_INVALID, status.UNAUTHENTICATED],
    [ERROR.TENANT_INACTIVE, status.PERMISSION_DENIED],
    [ERROR.NOTIFICATION_NOT_FOUND, status.NOT_FOUND],
    [ERROR.TENANT_SLUG_TAKEN, status.ALREADY_EXISTS],
    [ERROR.NOTIFICATION_NOT_CANCELLABLE, status.FAILED_PRECONDITION],
    [ERROR.TOO_MANY_REQUESTS, status.RESOURCE_EXHAUSTED],
    [ERROR.SERVICE_UNAVAILABLE, status.UNAVAILABLE],
    [{ type: 'X', status: HttpStatus.INTERNAL_SERVER_ERROR }, status.INTERNAL],
  ])('%j -> %s', (error, code) => {
    expect(grpcCode(error.type, error.status)).toBe(code);
  });
});
