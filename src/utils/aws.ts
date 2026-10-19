/**
 * Shared AWS SDK client settings (SES, SNS).
 */

import { AwsConfig } from '../config/configuration.js';

/** Region, optional static credentials and SDK-level retries. */
export function awsClientConfig(aws: AwsConfig) {
  return {
    region: aws.region,
    // Explicit keys only when configured; otherwise the default provider
    // chain (IAM role, IRSA, instance profile) is used, which is preferred.
    credentials:
      aws.accessKeyId && aws.secretAccessKey
        ? { accessKeyId: aws.accessKeyId, secretAccessKey: aws.secretAccessKey }
        : undefined,
    // The SDK retries throttling/5xx itself before the queue retries.
    maxAttempts: 3,
  };
}
