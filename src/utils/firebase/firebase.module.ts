/**
 * Push module (Firebase Cloud Messaging). firebase-admin is only loaded
 * when PUSH_PROVIDER=fcm.
 */

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { NotificationChannel, PushProviderName } from '../../constant/index.js';
import { PushProvider } from '../channel/channel.types.js';
import { ConsoleProvider } from '../channel/console.provider.js';
import { PUSH_PROVIDER, PushService } from './push.service.js';

/** Creates the provider selected by PUSH_PROVIDER, importing only its SDK. */
async function createPushProvider(app: AppConfig): Promise<PushProvider> {
  if (app.push.provider === PushProviderName.Fcm) {
    const { FcmPushProvider } = await import('./fcm.provider.js');
    return new FcmPushProvider(app.push.firebaseServiceAccount);
  }
  return new ConsoleProvider(NotificationChannel.Push);
}

/** Provides the channel service with the configured provider injected. */
@Module({
  providers: [
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createPushProvider(config.getOrThrow<AppConfig>('app')),
    },
    PushService,
  ],
  exports: [PushService],
})
export class FirebaseModule {}
