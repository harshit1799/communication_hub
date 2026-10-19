/**
 * Delivery channels supported by the notification service.
 * The string values are what clients send in the `channel` field.
 */
export enum NotificationChannel {
  // Email message (recipient = email address).
  Email = 'email',
  // Text message (recipient = phone number).
  Sms = 'sms',
  // Mobile/web push notification (recipient = device token).
  Push = 'push',
  // HTTP callback (recipient = URL).
  Webhook = 'webhook',
}
