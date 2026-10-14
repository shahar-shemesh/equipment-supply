//the sdk's client class is the one thing mocked at module level: the construction spec below lets the service build it
//and reads the options it was given. the commands stay real, the other specs inspect their inputs
jest.mock('@aws-sdk/client-s3', () => ({ ...jest.requireActual('@aws-sdk/client-s3'), S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn(async () => ({})) })) }));

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { S3StorageService, StorageError, categorize } from './s3-storage.service';

//the two calls against a fake client: what goes on the wire, and which failure becomes which category. no aws anywhere,
//the client is handed in through the constructor

const ENV = ['XML_EXPORT_BUCKET', 'AWS_REGION', 'XML_EXPORT_KMS_KEY_ID', 'XML_EXPORT_ENABLED', 'XML_EXPORT_S3_ENDPOINT'];
const previous = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeEach(() => {
    process.env.XML_EXPORT_BUCKET = 'issuance-exports';
    process.env.AWS_REGION = 'il-central-1';
    delete process.env.XML_EXPORT_KMS_KEY_ID;
    delete process.env.XML_EXPORT_ENABLED;
    delete process.env.XML_EXPORT_S3_ENDPOINT;
});

afterAll(() => {
    for (const k of ENV) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
    }
});

function sdkError(name: string, status?: number) {
    const e: any = new Error(`${name} happened`);
    e.name = name;
    if (status != null) e.$metadata = { httpStatusCode: status };
    return e;
}

function setup(send: (command: any) => Promise<any>) {
    const client: any = { send: jest.fn(send) };
    return { client, svc: new S3StorageService(client) };
}

const META = { 'event-id': 'e1', 'issuance-id': '12', sequence: '2', 'content-sha256': 'abc' };

/*──────────────────────────────────────────────────────────────────────────*/

describe('putIfAbsent', () => {
    it('sends a conditional put with the content type, the length, the metadata and AES256 by default', async () => {
        const { client, svc } = setup(async () => ({}));
        await svc.putIfAbsent('p/2026/10/14/issuance_12_e1.xml', Buffer.from('<x/>'), META);
        expect(client.send).toHaveBeenCalledTimes(1);
        const command = client.send.mock.calls[0][0];
        expect(command).toBeInstanceOf(PutObjectCommand);
        expect(command.input).toEqual({ Bucket: 'issuance-exports', Key: 'p/2026/10/14/issuance_12_e1.xml', Body: Buffer.from('<x/>'), ContentType: 'application/xml; charset=utf-8', ContentLength: 4, IfNoneMatch: '*', Metadata: META, ServerSideEncryption: 'AES256' });
    });

    it('uses the kms key when one is set', async () => {
        process.env.XML_EXPORT_KMS_KEY_ID = 'arn:aws:kms:il-central-1:1:key/k';
        const { client, svc } = setup(async () => ({}));
        await svc.putIfAbsent('k', Buffer.from(''), META);
        expect(client.send.mock.calls[0][0].input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'arn:aws:kms:il-central-1:1:key/k' });
    });

    it('a 412 is a precondition error, the rest is transient, the 400 / 403 / 404 family and kms flagged as config', async () => {
        const cases: [any, string, boolean][] = [
            [sdkError('PreconditionFailed', 412), 'precondition', false],
            [sdkError('InternalError', 500), 'transient', false],
            [sdkError('SlowDown', 503), 'transient', false],
            [sdkError('TooManyRequests', 429), 'transient', false],
            [sdkError('TimeoutError'), 'transient', false],
            [sdkError('ECONNRESET'), 'transient', false],
            [sdkError('AccessDenied', 403), 'transient', true],
            [sdkError('NoSuchBucket', 404), 'transient', true],
            [sdkError('KMS.NotFoundException', 400), 'transient', true],
            [sdkError('InvalidRequest', 400), 'transient', true],
        ];
        for (const [error, category, config] of cases) {
            const { svc } = setup(async () => {
                throw error;
            });
            const thrown = await svc.putIfAbsent('k', Buffer.from(''), META).then(() => null, (e) => e);
            expect([error.name, thrown]).toEqual([error.name, expect.any(StorageError)]);
            expect([error.name, thrown.category, thrown.config]).toEqual([error.name, category, config]);
            expect(thrown.message).toContain(error.name);
            expect(thrown.cause).toBe(error);
        }
        expect(categorize(new StorageError('permanent', 'x')).category).toBe('permanent'); //already categorized, passed through
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('head', () => {
    it('answers the metadata of the object, null for a missing one, and throws a categorized error for the rest', async () => {
        const found = setup(async () => ({ Metadata: META }));
        expect(await found.svc.head('k')).toEqual({ metadata: META });
        expect(found.client.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
        expect(found.client.send.mock.calls[0][0].input).toEqual({ Bucket: 'issuance-exports', Key: 'k' });

        const bare = setup(async () => ({}));
        expect(await bare.svc.head('k')).toEqual({ metadata: {} });

        for (const missing of [sdkError('NotFound', 404), sdkError('NoSuchKey')]) {
            const { svc } = setup(async () => {
                throw missing;
            });
            expect(await svc.head('k')).toBeNull();
        }

        const denied = setup(async () => {
            throw sdkError('AccessDenied', 403);
        });
        await expect(denied.svc.head('k')).rejects.toMatchObject({ category: 'transient', config: true });
    });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe('the client the service builds itself', () => {
    beforeEach(() => (S3Client as unknown as jest.Mock).mockClear());

    it('is built once, from the env, with the request timeout and two attempts that keep one put inside the lease', async () => {
        const svc = new S3StorageService();
        expect(S3Client).not.toHaveBeenCalled();
        await svc.putIfAbsent('k', Buffer.from('<x/>'), META);
        await svc.head('k');
        expect(S3Client).toHaveBeenCalledTimes(1);
        expect(S3Client).toHaveBeenCalledWith({ region: 'il-central-1', requestHandler: { requestTimeout: 15000, connectionTimeout: 5000, throwOnRequestTimeout: true }, maxAttempts: 2 });
    });

    it('with XML_EXPORT_S3_ENDPOINT it points at that endpoint in path style, for MinIO or LocalStack', async () => {
        process.env.XML_EXPORT_S3_ENDPOINT = 'http://localhost:9000';
        await new S3StorageService().head('k');
        expect(S3Client).toHaveBeenCalledWith(expect.objectContaining({ region: 'il-central-1', endpoint: 'http://localhost:9000', forcePathStyle: true }));
    });
});
