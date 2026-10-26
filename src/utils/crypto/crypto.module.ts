/**
 * Global crypto module: builds the FieldCipher from config once, registers
 * it for the column transformers and provides it for injection (blind
 * indexes, credential encryption).
 */

import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration.js';
import { FieldCipher, parseCipherKeys } from './field-cipher.js';

/** Builds and registers the process-wide cipher (also used by data-source.ts). */
export function configureFieldCipher(crypto: AppConfig['crypto']): FieldCipher {
  const cipher = new FieldCipher(parseCipherKeys(crypto));
  FieldCipher.configure(cipher);
  return cipher;
}

@Global()
@Module({
  providers: [
    {
      provide: FieldCipher,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => configureFieldCipher(config.getOrThrow<AppConfig>('app').crypto),
    },
  ],
  exports: [FieldCipher],
})
export class CryptoModule {}
