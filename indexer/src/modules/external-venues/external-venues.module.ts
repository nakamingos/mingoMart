import { Module } from '@nestjs/common';

import { AppConfigModule } from '@/config/config.module';
import { StorageModule } from '@/modules/storage/storage.module';

import { ExternalVenuesService } from './external-venues.service';

@Module({
  imports: [
    AppConfigModule,
    StorageModule,
  ],
  providers: [
    ExternalVenuesService,
  ],
  exports: [
    ExternalVenuesService,
  ],
})
export class ExternalVenuesModule {}
