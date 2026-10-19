/**
 * Application-wide constants shared across modules.
 */

// Name of the HTTP header that identifies the white-label tenant (client).
// Express lower-cases header names, so it's stored in lower case.
export const TENANT_HEADER = 'x-tenant-id';
