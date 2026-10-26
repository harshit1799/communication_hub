/**
 * Conversions between protobuf wire shapes (as @grpc/proto-loader hands
 * them over: enums as names, Timestamp as {seconds, nanos}, Struct as
 * {fields}) and the domain values used everywhere else. Controllers are
 * the only callers: services never see proto types.
 */

import {
  DevicePlatform,
  NotificationChannel,
  NotificationPriority,
  NotificationStatus,
  SenderRuleMatch,
} from '../constant/index.js';

/**
 * Two-way mapping between a domain enum and a proto enum whose values are
 * PREFIX_<NAME>. The *_UNSPECIFIED value (and anything unknown) decodes to
 * undefined, so "not set" and "invalid" both surface as validation errors
 * where a value is required.
 */
function protoEnum<T extends string>(prefix: string, values: Record<string, T>) {
  const toProto = new Map<T, string>();
  const fromProto = new Map<string, T>();
  for (const value of Object.values(values)) {
    const name = `${prefix}_${value.toUpperCase()}`;
    toProto.set(value, name);
    fromProto.set(name, value);
  }
  return {
    decode: (name: string | undefined | null): T | undefined => (name ? fromProto.get(name) : undefined),
    encode: (value: T | null | undefined): string => (value ? (toProto.get(value) ?? `${prefix}_UNSPECIFIED`) : `${prefix}_UNSPECIFIED`),
  };
}

export const ChannelCodec = protoEnum('CHANNEL', NotificationChannel);
export const StatusCodec = protoEnum('NOTIFICATION_STATUS', NotificationStatus);
export const PriorityCodec = protoEnum('PRIORITY', NotificationPriority);
export const PlatformCodec = protoEnum('DEVICE_PLATFORM', DevicePlatform);
export const SenderMatchCodec = protoEnum('SENDER_RULE_MATCH', SenderRuleMatch);

/** google.protobuf.Timestamp as proto-loader represents it (longs: String). */
export interface ProtoTimestamp {
  seconds: string | number;
  nanos?: number;
}

export const Timestamp = {
  encode(date: Date | null | undefined): ProtoTimestamp | undefined {
    if (!date) return undefined;
    const ms = date.getTime();
    return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
  },
  decode(ts: ProtoTimestamp | null | undefined): Date | undefined {
    if (!ts) return undefined;
    return new Date(Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000));
  },
};

/** google.protobuf.Value / Struct as proto-loader represents them (oneofs: true). */
interface ProtoValue {
  nullValue?: string;
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  structValue?: ProtoStruct;
  listValue?: { values?: ProtoValue[] };
  kind?: string;
}
export interface ProtoStruct {
  fields?: Record<string, ProtoValue>;
}

function decodeValue(v: ProtoValue): unknown {
  switch (v.kind) {
    case 'numberValue':
      return v.numberValue;
    case 'stringValue':
      return v.stringValue;
    case 'boolValue':
      return v.boolValue;
    case 'structValue':
      return Struct.decode(v.structValue);
    case 'listValue':
      return (v.listValue?.values ?? []).map(decodeValue);
    default:
      return null;
  }
}

function encodeValue(v: unknown): ProtoValue {
  if (v === null || v === undefined) return { nullValue: 'NULL_VALUE' };
  if (typeof v === 'number') return { numberValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (v instanceof Date) return { stringValue: v.toISOString() };
  if (Array.isArray(v)) return { listValue: { values: v.map(encodeValue) } };
  return { structValue: Struct.encode(v as Record<string, unknown>) };
}

export const Struct = {
  encode(obj: Record<string, unknown> | null | undefined): ProtoStruct | undefined {
    if (!obj) return undefined;
    return { fields: Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, encodeValue(v)])) };
  },
  /** Undefined when the field was not sent at all. */
  decode(struct: ProtoStruct | null | undefined): Record<string, unknown> | undefined {
    if (!struct) return undefined;
    return Object.fromEntries(Object.entries(struct.fields ?? {}).map(([k, v]) => [k, decodeValue(v)]));
  },
};

/** proto3 maps arrive as {} when empty: treat that as "not given". */
export function nonEmptyMap(map: Record<string, string> | null | undefined): Record<string, string> | undefined {
  return map && Object.keys(map).length > 0 ? map : undefined;
}

/** Omits undefined/null fields, so optional proto fields stay unset on the wire. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)) as T;
}
