import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { XmlOutbox } from '../entities';
import { xmlExportConfig } from '../env';
import { XmlOutboxService } from './xml-outbox.service';
import { XmlBuilderService } from './xml-builder.service';
import { S3StorageService } from './s3-storage.service';
import { LocalXmlStorageService } from './local-xml-storage.service';
import { XML_STORAGE, XmlStorage } from './xml-storage';
import { XmlExportWorker } from './xml-export.worker';
import { XmlExportController } from './xml-export.controller';

//global like AuditModule and for the same reason: the two services that write a status inject XmlOutboxService and the
//row rides on their transaction. the worker and the storage stay inside, nobody else uploads. both backends are
//registered and XML_EXPORT_STORAGE picks the one the worker gets, once, when the module is built: the e2e override
//of S3StorageService still reaches the worker through the factory
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([XmlOutbox])],
  controllers: [XmlExportController],
  providers: [
    XmlOutboxService,
    XmlBuilderService,
    S3StorageService,
    LocalXmlStorageService,
    { provide: XML_STORAGE, useFactory: (s3: XmlStorage, local: XmlStorage) => (xmlExportConfig().storage === 'local' ? local : s3), inject: [S3StorageService, LocalXmlStorageService] },
    XmlExportWorker,
  ],
  exports: [XmlOutboxService],
})
export class XmlExportModule {}
