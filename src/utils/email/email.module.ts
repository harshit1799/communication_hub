/**
 * Email module. Only the selected vendor SDK is loaded (dynamic import), so
 * a deployment using SES never pulls SendGrid into memory and vice versa.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { EmailProviderName, NotificationChannel } from '../../constant/index.js';
import { EmailProvider } from '../channel/channel.types.js';
import { ConsoleProvider } from '../channel/console.provider.js';
import { EMAIL_PROVIDER, EmailService } from './email.service.js';

/** Creates the provider selected by EMAIL_PROVIDER, importing only its SDK. */
async function createEmailProvider(app: AppConfig): Promise<EmailProvider> {
  switch (app.mail.provider) {
    case EmailProviderName.Smtp: {
      const { SmtpEmailProvider } = await import('./providers/smtp.provider.js');
      return new SmtpEmailProvider(app.mail, app.queue.workers.email.concurrency);
    }
    case EmailProviderName.Ses: {
      const { SesEmailProvider } = await import('./providers/ses.provider.js');
      return new SesEmailProvider(app.aws);
    }
    case EmailProviderName.Sendgrid: {
      const { SendgridEmailProvider } = await import('./providers/sendgrid.provider.js');
      return new SendgridEmailProvider(app.mail.sendgridApiKey!);
    }
    default:
      return new ConsoleProvider(NotificationChannel.Email);
  }
}

/** Provides the channel service with the configured provider injected. */
@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createEmailProvider(config.getOrThrow<AppConfig>('app')),
    },
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}
