/**
 * SMS module. Only the selected vendor SDK is loaded (dynamic import).
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, SmsProviderName } from '../../constant/index.js';
import { SmsProvider } from '../channel/channel.types.js';
import { ConsoleProvider } from '../channel/console.provider.js';
import { SMS_PROVIDER, SmsService } from './sms.service.js';

/** Creates the provider selected by SMS_PROVIDER, importing only its SDK. */
async function createSmsProvider(app: AppConfig): Promise<SmsProvider> {
  switch (app.sms.provider) {
    case SmsProviderName.Twilio: {
      const { TwilioSmsProvider } = await import('./providers/twilio.provider.js');
      return new TwilioSmsProvider(app.sms.twilio);
    }
    case SmsProviderName.Sns: {
      const { SnsSmsProvider } = await import('./providers/sns.provider.js');
      return new SnsSmsProvider(app.aws, app.sms.snsSenderId);
    }
    default:
      return new ConsoleProvider(NotificationChannel.Sms);
  }
}

/** Provides the channel service with the configured provider injected. */
@Module({
  providers: [
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createSmsProvider(config.getOrThrow<AppConfig>('app')),
    },
    SmsService,
  ],
  exports: [SmsService],
})
export class SmsModule {}
