/**
 * Lifecycle states of a notification.
 */
export enum NotificationStatus {
  // Saved, delivery not yet completed.
  Pending = 'pending',
  // The channel provider accepted the message.
  Sent = 'sent',
  // The channel provider threw an error; see the `error` field.
  Failed = 'failed',
}
