/**
 * Notifications feature module. Registers the controller, service, the
 * notifications table repository and the set of channel providers.
 */

// Module decorator.
import { Module } from '@nestjs/common';
// Reads the typed configuration.
import { ConfigService } from '@nestjs/config';
// Registers the entity's repository for injection.
import { TypeOrmModule } from '@nestjs/typeorm';
// Typed config shape.
import { AppConfig } from '../../config/configuration.js';
// Email template rendering.
import { TemplatesModule } from '../templates/templates.module.js';
// Provider token, the log-only provider and the SMTP email provider.
import {
  CHANNEL_PROVIDERS,
  ChannelProvider,
} from './channels/channel-provider.interface.js';
import { ConsoleChannelProvider } from './channels/console-channel.provider.js';
import { SmtpEmailProvider } from './channels/smtp-email.provider.js';
// Table mapping.
import { Notification } from './entities/notification.entity.js';
// Channel enum, used to create one provider per channel.
import { NotificationChannel } from './enums/notification-channel.enum.js';
// Module's controller and service.
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Notification]), TemplatesModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    {
      // One provider per channel. Replace console providers with real
      // integrations (Twilio, FCM, ...) here.
      provide: CHANNEL_PROVIDERS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ChannelProvider[] => {
        const { mail } = config.getOrThrow<AppConfig>('app');
        return Object.values(NotificationChannel).map((channel) =>
          // Real SMTP for email when SMTP_HOST is set, console otherwise.
          channel === NotificationChannel.Email && mail.smtp.host
            ? new SmtpEmailProvider(mail)
            : new ConsoleChannelProvider(channel),
        );
      },
    },
  ],
  // Let other modules inject NotificationsService (e.g. a future queue worker).
  exports: [NotificationsService],
})
export class NotificationsModule {}
