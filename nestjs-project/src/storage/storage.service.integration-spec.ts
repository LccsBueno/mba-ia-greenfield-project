import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    storageService = module.get(StorageService);
  });

  it('bucket bootstrap is idempotent', async () => {
    await expect(storageService.ensureBucketExists()).resolves.not.toThrow();
    await expect(storageService.ensureBucketExists()).resolves.not.toThrow();
  });

  it('completes a full multipart upload cycle and retrieves matching bytes', async () => {
    const key = `test/${randomUUID()}.bin`;
    const payload = Buffer.from('a'.repeat(1024));

    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    const url = await storageService.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(url, { method: 'PUT', body: payload });
    expect(putResponse.status).toBe(200);
    const eTag = putResponse.headers.get('etag') as string;

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);

    const result = await storageService.getObject(key);
    const body = await streamToBuffer(result.body);
    expect(body.equals(payload)).toBe(true);
    expect(result.contentLength).toBe(payload.length);
  });

  it('returns partial content and a content range for a Range request', async () => {
    const key = `test/${randomUUID()}.bin`;
    const payload = Buffer.from('0123456789'.repeat(20)); // 200 bytes

    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const url = await storageService.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(url, { method: 'PUT', body: payload });
    const eTag = putResponse.headers.get('etag') as string;
    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, eTag },
    ]);

    const result = await storageService.getObject(key, 'bytes=0-99');
    const body = await streamToBuffer(result.body);

    expect(body.length).toBe(100);
    expect(body.equals(payload.subarray(0, 100))).toBe(true);
    expect(result.contentRange).toBe(`bytes 0-99/${payload.length}`);
    expect(result.statusCode).toBe(206);
  });

  it('makes a subsequent complete fail after aborting a multipart upload', async () => {
    const key = `test/${randomUUID()}.bin`;
    const { uploadId } = await storageService.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await storageService.abortMultipartUpload(key, uploadId);

    await expect(
      storageService.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, eTag: '"deadbeef"' },
      ]),
    ).rejects.toThrow();
  });
});
