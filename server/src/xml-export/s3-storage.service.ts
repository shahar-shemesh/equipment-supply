import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { xmlExportConfig } from '../env';
import { StorageError } from './xml-storage';
import { ObjectMetadata, XmlStorage } from './xml-storage';

//the injection token of a prebuilt client. nothing registers it: the unit spec hands a fake through the constructor and
//the service builds the real one from the env on first use
export const S3_CLIENT = 'XML_EXPORT_S3_CLIENT';

//the categories here: precondition is the 412 of the conditional put, the worker compares the metadata. transient is
//worth another attempt after the backoff, network and 5xx and throttling, but also the 400 / 403 / 404 family (a
//bucket that does not exist yet, a policy that is not there yet, a kms key the role may not use): an operator fixes
//those in aws and the rows must flow without a manual retry per row, so they are retried too, flagged config so the
//log says where to look. permanent is never produced here, it is the worker's own verdict (the document could not be
//built, another object under the key). the error class and the metadata type live with the contract in
//xml-storage.ts, re-exported so the earlier importers keep working
export { StorageError } from './xml-storage';
export type { ObjectMetadata, StorageErrorCategory } from './xml-storage';

const CONFIG_ERRORS = new Set(['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'PermanentRedirect', 'AuthorizationHeaderMalformed']);

/*──────────────────────────────────────────────────────────────────────────*/

//one client, one bucket, two calls. the only file that imports the sdk. the credentials come from the sdk's default
//provider chain (env, profile, instance or task role), nothing here reads a key
@Injectable()
export class S3StorageService implements XmlStorage {
  private readonly logger = new Logger(S3StorageService.name);
  private client: S3Client | null;

  constructor(@Optional() @Inject(S3_CLIENT) client?: S3Client) {
    this.client = client || null;
  }

  //PutObject with If-None-Match: * so the same key is never written twice. the content type and the encryption are set
  //per object, the metadata is what a later head compares. a 412 arrives as a precondition error, everything else as
  //transient (see the categories above)
  async putIfAbsent(key: string, body: Buffer, metadata: ObjectMetadata) {
    const cfg = xmlExportConfig();
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: 'application/xml; charset=utf-8',
          ContentLength: body.length,
          IfNoneMatch: '*',
          Metadata: metadata,
          ...(cfg.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: cfg.kmsKeyId } : { ServerSideEncryption: 'AES256' }),
        }),
      );
    } catch (e) {
      throw categorize(e);
    }
  }

  //the metadata of the object under the key, or null when there is none. a 404 here is an answer, not a failure
  async head(key: string): Promise<{ metadata: Record<string, string> } | null> {
    const cfg = xmlExportConfig();
    try {
      const res = await this.s3().send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return { metadata: res.Metadata || {} };
    } catch (e) {
      if (statusOf(e) === 404 || e?.name === 'NotFound' || e?.name === 'NoSuchKey') return null;
      throw categorize(e);
    }
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  //built on first use and not in the constructor: the module boots on every box, the client only where the worker runs.
  //15s per request so a hung connection costs one attempt and not the whole tick, and two sdk attempts instead of its
  //default three: one put is then at most 2 x (5s + 15s) = 40s, inside the 60s lease, so a slow bucket does not get the
  //row reclaimed under a worker that is still trying. the outbox backoff is the real retry
  private s3() {
    if (this.client) return this.client;
    const cfg = xmlExportConfig();
    this.client = new S3Client({
      region: cfg.region,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
      requestHandler: { requestTimeout: 15000, connectionTimeout: 5000, throwOnRequestTimeout: true },
      maxAttempts: 2,
    });
    this.logger.log(`s3 client ready: region ${cfg.region}, bucket ${cfg.bucket}, endpoint ${cfg.endpoint || 'aws'}`);
    return this.client;
  }
}

/*──────────────────────────────────────────────────────────────────────────*/

function statusOf(e: any): number | undefined {
  return e?.$metadata?.httpStatusCode;
}

export function categorize(e: any): StorageError {
  if (e instanceof StorageError) return e;
  const status = statusOf(e);
  const name: string = e?.name || e?.code || e?.constructor?.name || 'Error';
  const message = `${name}${e?.message ? `: ${e.message}` : ''}`;
  if (status === 412 || name === 'PreconditionFailed') return new StorageError('precondition', message, false, e);
  const config = CONFIG_ERRORS.has(name) || name.startsWith('KMS') || (status != null && [400, 403, 404].includes(status));
  return new StorageError('transient', message, config, e);
}
