---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-29T23:24:36-03:00"
  docs/phases/phase-03-videos/context.md: "2026-07-30T08:21:08-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-30T08:20:59-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-07-29T23:26:38-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver upload of videos up to 10GB without blocking the API (presigned multipart direct-to-storage), a background processing pipeline (BullMQ + Redis) that extracts metadata and generates a thumbnail via a dedicated FFmpeg worker container, a unique collision-free public slug per video, and Range-aware streaming/download — completing the video object storage → queue → worker pipeline the architecture diagram reserves for this phase.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure

**Description:** Install video-processing dependencies, create `storage` and `queue` config namespaces following the existing `registerAs` pattern, and add the MinIO, Redis, and video-worker services to Docker Compose.

**Technical actions:**

- Install production dependencies in nestjs-project: `@aws-sdk/client-s3@^3.1098.x`, `@aws-sdk/s3-request-presigner@^3.1098.x`, `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.x`
- Add `ffmpeg` to the `apt update && apt install -y` line in `Dockerfile.dev` (alongside the existing `procps curl`). This single dev image is reused by both the `nestjs-api` and `video-worker` Compose services (see below), so `ffmpeg`/`ffprobe` are available at worker runtime AND to `docker compose exec nestjs-api npm test` for SI-03.6's integration tests — avoiding a second, ffmpeg-less image where those tests couldn't run
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (string, default `'http://minio:9000'`), `S3_REGION` (string, default `'us-east-1'`), `S3_ACCESS_KEY_ID` (string, required), `S3_SECRET_ACCESS_KEY` (string, required), `S3_BUCKET` (string, default `'videos'`), `S3_FORCE_PATH_STYLE` (boolean, default `true`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add the new environment variables to the Joi schema (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` required, the rest with defaults); update `.env.example` with Docker Compose-compatible defaults
- Add `minio`, `redis`, and `video-worker` services to `nestjs-project/compose.yaml`: `minio` (image `minio/minio`, command `server /data --console-address ":9001"`, ports `9000`/`9001`, healthcheck via `mc ready local` — `curl`/`wget` are no longer bundled in recent `minio/minio` images, but `mc` is); `redis` (image `redis:7-alpine`, healthcheck via `redis-cli ping`); `video-worker` (**same** `build: { context: ., dockerfile: Dockerfile.dev }` as `nestjs-api` — no separate Dockerfile — with a placeholder `command: tail -f /dev/null` until SI-03.6 wires the real worker entrypoint, `depends_on` `db`, `redis`, and `minio` all `service_healthy`). Reusing `Dockerfile.dev` means `video-worker` builds successfully starting from this SI, before any worker application code exists in SI-03.6

**Tests:** _(infrastructure SI — no testable application code; exercised indirectly by SI-03.3/SI-03.4's integration tests against the real `minio`/`redis` services)_

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` brings up `minio`, `redis`, and `video-worker` alongside the existing services, all reporting healthy/running (`docker compose ps`)
- MinIO's web console is reachable at `localhost:9001` and its S3 API at `localhost:9000`
- Starting the application without `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` causes a Joi validation error at bootstrap — the app does not start
- `docker compose exec nestjs-api ffmpeg -version` and `docker compose exec nestjs-api ffprobe -version` both exit 0

---

### SI-03.2 — Video Entity, Migration, and Slug Generation

**Description:** Create the `Video` entity with its status enum, generate the migration, and implement the collision-retry slug generator reusing the project's existing `crypto.randomBytes` convention (`channels/nickname.util.ts`).

**Technical actions:**

- Create `src/videos/video-status.enum.ts` — `VideoStatus` enum: `DRAFT`, `PROCESSING`, `READY`, `ERROR`
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated), `channel_id` (uuid, FK → channels), `title` (varchar(120)), `slug` (varchar(16), unique), `status` (enum `VideoStatus`, default `DRAFT`), `original_key` (varchar), `thumbnail_key` (varchar, nullable), `upload_id` (varchar, nullable), `content_type` (varchar(100)), `size_bytes` (bigint), `duration_seconds` (int, nullable), `width` (int, nullable), `height` (int, nullable), `processing_error` (text, nullable), `created_at` (CreateDateColumn), `updated_at` (UpdateDateColumn). Define `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`
- Create `src/videos/slug.util.ts` — `generateVideoSlug()` returning a 10-character hex slug via `crypto.randomBytes`, mirroring `src/channels/nickname.util.ts`'s `randomHex` helper
- Create `src/videos/videos.module.ts` skeleton with `TypeOrmModule.forFeature([Video])` in imports, exporting `TypeOrmModule`
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the generated SQL; extend `src/database/migrations.integration-spec.ts`'s `MANAGED_TABLES` array (add `'videos'`) and its migrations array (add the new migration class) so the existing migration test continues to assert all tables together

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `slug` constraint, FK to `channels`, default `status = DRAFT`, nullable columns accept null |
| `src/videos/slug.util.spec.ts` | Unit | Generated slug has expected length and charset |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature` wiring |
| `src/database/migrations.integration-spec.ts` _(extended)_ | Integration | New migration creates the `videos` table alongside the four pre-existing tables |

**Dependencies:** None

**Acceptance criteria:**

- Inserting a video with a `slug` that already exists violates the DB unique constraint
- Running migrations creates a `videos` table with a `status` default of `draft` and all five managed tables present (four from Fase 02 + `videos`)
- Reverting the new migration drops the `videos` table without affecting the other four
- Inserting a video referencing a non-existent `channel_id` fails with a FK constraint violation

---

### SI-03.3 — Object Storage Service (MinIO/S3)

**Description:** Implement `StorageService`, wrapping the AWS SDK v3 S3 client (configured for MinIO) — multipart upload lifecycle, object retrieval with Range support, and bucket bootstrap.

**Technical actions:**

- Create `src/storage/storage.module.ts` — provides an `S3Client` via a factory injecting `storageConfig` (`endpoint`, `region`, `forcePathStyle`, static `credentials`), exports `StorageService`
- Create `src/storage/storage.service.ts` implementing: `ensureBucketExists()` (called from `onModuleInit`; `HeadBucketCommand`, falling back to `CreateBucketCommand` and swallowing the "bucket already owned by you" case), `createMultipartUpload(key, contentType)` → `{ uploadId }`, `presignUploadPart(key, uploadId, partNumber)` → presigned URL with `expiresIn: 3600` (60 min, per TD-02's resolved parameter), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)`, `putObject(key, body, contentType)` (used by the worker to upload the generated thumbnail), `getObject(key, range?)` → `{ body: Readable, contentLength, contentRange?, statusCode }` (translates the S3 SDK's Range response into values the controller forwards as HTTP headers)
- Create `src/storage/storage.constants.ts` — object key builders: `buildOriginalKey(channelId, videoId, ext)` → `channels/{channelId}/videos/{videoId}/original.{ext}`, `buildThumbnailKey(channelId, videoId)` → `channels/{channelId}/videos/{videoId}/thumbnail.jpg` (per TD-02's resolved bucket/key organization)
- Register `StorageModule` in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Real MinIO: bucket bootstrap is idempotent; full create→presign-part→PUT-bytes-via-`fetch`→complete cycle produces an object retrievable via `getObject` with matching bytes; a `Range` request returns partial content with a correct `Content-Range`; aborting a multipart upload makes a subsequent `completeMultipartUpload` for the same `uploadId` fail |
| `src/storage/storage.constants.spec.ts` | Unit | Key builders produce the expected paths |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- On module init, the configured bucket exists in MinIO (created if missing; no error raised if it already exists from a prior run)
- A full multipart cycle (create → presign each part → `PUT` bytes to the presigned URL → complete) against real MinIO results in an object whose bytes match what was uploaded
- `getObject` with a `Range: bytes=0-99` header returns exactly 100 bytes and a value describing the full object size (`Content-Range`-equivalent)
- Aborting a multipart upload removes it from MinIO's in-progress uploads

---

### SI-03.4 — Video Processing Queue

**Description:** Register the BullMQ queue backed by Redis and implement the producer-side enqueue helper with the retry/backoff parameters decided in TD-05.

**Technical actions:**

- Create `src/queue/queue.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing' as const`
- Register `BullModule.forRootAsync` in `AppModule`, `inject: [queueConfig.KEY]`, `useFactory` returning `{ connection: { host: queue.host, port: queue.port } }`
- Create `src/queue/video-queue.module.ts` — `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, providing and exporting `VideoQueueService`
- Create `src/queue/video-queue.service.ts` — `enqueueProcessing(videoId: string): Promise<void>` calling `queue.add('process', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } })` (per TD-05's resolved parameters)
- Register `VideoQueueModule` in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/video-queue.service.integration-spec.ts` | Integration | Real Redis-backed queue: `enqueueProcessing` creates a job with `data.videoId` matching and `opts.attempts === 3` / exponential backoff with `delay: 5000` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Calling `enqueueProcessing(videoId)` results in a job visible in the real BullMQ queue (`queue.getJobs(['waiting'])`) whose data and retry options match the resolved TD-05 parameters

---

### SI-03.5 — Upload Orchestration: Videos Module, Controller, and DTOs

**Description:** Implement the video upload lifecycle (initiate → complete/abort) and the owner-scoped metadata endpoint, wiring together the entity, storage, and queue built in the previous SIs.

**Technical actions:**

- Create `src/videos/video.constants.ts` — `ALLOWED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'] as const`, `MAX_VIDEO_SIZE_BYTES = 10_737_418_240` (10GB), `MULTIPART_PART_SIZE_BYTES = 104_857_600` (100MB, per TD-02's resolved parameter)
- Create DTOs: `src/videos/dto/initiate-upload.dto.ts` (`title`: string, `@Length(3, 120)`; `originalFilename`: string, `@IsNotEmpty()`; `sizeBytes`: number, `@Min(1)` `@Max(MAX_VIDEO_SIZE_BYTES)`; `contentType`: string, `@IsIn(ALLOWED_VIDEO_CONTENT_TYPES)`), `src/videos/dto/complete-upload.dto.ts` (`parts`: array of `{ partNumber: number, eTag: string }`, validated with `@ValidateNested({ each: true })` + `@Type(() => UploadPartDto)`), `src/videos/dto/video-response.dto.ts` (`id`, `slug`, `title`, `status`, `durationSeconds`, `sizeBytes`, `contentType`, `processingError`, `createdAt`)
- Extend `src/common/exceptions/domain.exception.ts` with `VideoNotFoundException` (404), `ForbiddenVideoAccessException` (403), `VideoNotInDraftException` (409), `UploadPartsMismatchException` (400), `VideoNotReadyException` (409)
- Implement `src/videos/videos.service.ts`: `initiateUpload(userId, dto)` (resolve the caller's channel; build a `Video` row with `status: DRAFT` and a `generateVideoSlug()`-produced slug, retrying on unique-constraint violation; build the storage key via `buildOriginalKey`; call `storageService.createMultipartUpload`; compute part count as `Math.ceil(sizeBytes / MULTIPART_PART_SIZE_BYTES)`; presign each part; persist `upload_id`); `completeUpload(userId, videoId, dto)` (ownership + `status === DRAFT` checks — else `ForbiddenVideoAccessException`/`VideoNotInDraftException`; validate `dto.parts` length matches the expected part count — else `UploadPartsMismatchException`; call `storageService.completeMultipartUpload`; set `status: PROCESSING`; call `videoQueueService.enqueueProcessing`); `abortUpload(userId, videoId)` (ownership + `status === DRAFT` checks; `storageService.abortMultipartUpload`; delete the video row); `getVideo(userId, videoId)` (ownership check — else `VideoNotFoundException`/`ForbiddenVideoAccessException`; map to `VideoResponseDto`)
- Implement `src/videos/videos.controller.ts` with `POST /videos/uploads`, `POST /videos/uploads/:id/complete`, `POST /videos/uploads/:id/abort`, `GET /videos/:id`, all behind the global `JwtAuthGuard` (no `@Public()`), using `@CurrentUser()` for the caller identity; annotate with `@nestjs/swagger` decorators per the inherited OpenAPI convention

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Branch logic: part-count computation, ownership checks, status-guard branches (mocked repo/storage/queue) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB: `initiateUpload` creates a `DRAFT` row with a unique slug; `completeUpload` flips status to `PROCESSING` and enqueues a real job; `abortUpload` deletes the row |
| `test/videos.e2e-spec.ts` | E2E | Full HTTP cycle for initiate/complete/abort/get, including 401 (no token), 403 (non-owner), 404, 409, 400 validation |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos/uploads` with a valid payload returns 201 with `{ id, slug, status: 'draft', uploadId, parts: [...] }`, `Location: /videos/:id`, and a `videos` row exists with `status = DRAFT`
- `POST /videos/uploads` with a `contentType` outside the allowlist returns 400 validation error
- `POST /videos/uploads/:id/complete` with a `parts` array whose length does not match the expected part count returns 400 with `UPLOAD_PARTS_MISMATCH`
- `POST /videos/uploads/:id/complete` with valid parts returns 200 with `status: 'processing'`, and a processing job is enqueued for that video id
- `POST /videos/uploads/:id/complete` or `.../abort` from a user who does not own the video's channel returns 403 with `FORBIDDEN_VIDEO_ACCESS`
- `POST /videos/uploads/:id/complete` on an already-completed (non-`DRAFT`) video returns 409 with `VIDEO_NOT_IN_DRAFT`
- `GET /videos/:id` without a valid access token returns 401
- `POST /videos/uploads/:id/abort` on a `DRAFT` video returns 204 and the video row no longer exists

---

### SI-03.6 — Video Processor Worker

**Description:** Implement the standalone-NestJS BullMQ worker process that consumes processing jobs, extracts metadata via `ffprobe`, generates a thumbnail via `ffmpeg`, uploads the thumbnail to storage, and finalizes the video's status.

**Technical actions:**

- Add `worker:dev` (`nest start --watch --entryFile worker/main`) and `worker:start` (`node dist/worker/main`) npm scripts to `package.json`; update `video-worker`'s `command` in `compose.yaml` from SI-03.1's `tail -f /dev/null` placeholder to `npm run worker:dev` — no separate Dockerfile needed, `video-worker` reuses the `Dockerfile.dev` image (with `ffmpeg`) built in SI-03.1
- Create `src/videos/processing/ffmpeg.util.ts` — `probeVideo(filePath)` (spawns `ffprobe -print_format json -show_format -show_streams <filePath>` via `child_process.execFile`, parses the JSON stdout for `duration`, `width`, `height`), `extractThumbnail(filePath, outputPath, atSeconds)` (spawns `ffmpeg -ss <atSeconds> -i <filePath> -vframes 1 <outputPath>` via `child_process.execFile`); both with a bounded timeout
- Create `src/videos/processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` extending `WorkerHost`; `process(job)`: load the video row; download the original object from storage to a temp file (`os.tmpdir()`); `probeVideo` for duration/dimensions (throws if duration is unreadable or zero); compute the thumbnail timestamp per TD-03's resolved parameter (`1s`, or `duration / 2` when duration `< 2s`); `extractThumbnail`; `storageService.putObject` the thumbnail at `buildThumbnailKey`; update the video row (`status: READY`, `duration_seconds`, `width`, `height`, `thumbnail_key`, `processing_error: null`); clean up temp files in a `finally` block. Register an `@OnWorkerEvent('failed')` handler that, once BullMQ's configured `attempts` are exhausted, sets `status: ERROR` and `processing_error` to the final error's message
- Create `src/videos/processing/video-processing.module.ts` — worker-only module: `TypeOrmModule.forFeature([Video])`, imports `StorageModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, provides `VideoProcessor`
- Create `src/worker/worker.module.ts` (root module for the worker process: `ConfigModule.forRoot` with the same `load`/`validationSchema` as `AppModule`, `TypeOrmModule.forRootAsync` identical to `AppModule`'s, `BullModule.forRootAsync` identical to `AppModule`'s, imports `VideoProcessingModule`) and `src/worker/main.ts` (`NestFactory.createApplicationContext(WorkerModule)` with graceful shutdown hooks — no HTTP listener)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing/ffmpeg.util.spec.ts` | Unit | Argument construction and JSON parsing of a mocked `ffprobe` stdout; thumbnail timestamp-selection branch (`1s` vs `duration/2`) |
| `src/videos/processing/video.processor.spec.ts` | Unit | Success and failure branches with mocked storage/repo/`ffmpeg.util` |
| `src/videos/processing/video.processor.integration-spec.ts` | Integration | Real queue + real `ffmpeg`/`ffprobe` binaries + real MinIO, against a small checked-in fixture video: job completes, video row ends `READY` with duration/dimensions/thumbnail populated and the thumbnail object present in MinIO |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Processing a valid fixture video ends with the video row `status = READY`, `duration_seconds` matching the fixture's known duration, and a thumbnail object present at the expected storage key
- Processing a job whose original object is missing from storage exhausts the configured 3 retry attempts and ends with `status = ERROR` and a non-null `processing_error`
- The worker process boots via `NestFactory.createApplicationContext` and does not expose an HTTP listener

---

### SI-03.7 — Streaming and Download Endpoints

**Description:** Expose the public-shaped, slug-addressed streaming and download endpoints, proxying bytes from storage through the API with `Range`/`206 Partial Content` support.

**Technical actions:**

- Extend `src/videos/videos.service.ts` with `streamVideo(userId, slug, range?)` and `downloadVideo(userId, slug)` — both resolve the video by `slug` (else `VideoNotFoundException`), enforce ownership (else `ForbiddenVideoAccessException`), enforce `status === READY` (else `VideoNotReadyException`), then call `storageService.getObject(original_key, range)`
- Extend `src/videos/videos.controller.ts` with `GET /videos/:slug/stream` (reads the incoming `Range` header, calls `streamVideo`, sets `Content-Type` from the video's `content_type`, `Accept-Ranges: bytes`, and either `200` + `Content-Length` (no `Range` requested) or `206` + `Content-Range` (Range requested), pipes the returned `Readable` into the Express response) and `GET /videos/:slug/download` (calls `downloadVideo`, sets `Content-Disposition: attachment; filename="<title>.<ext>"`, pipes the full body with `200`)
- Handle mid-stream storage errors by destroying the response connection rather than leaving the request hanging

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos-streaming.e2e-spec.ts` | E2E | `GET .../stream` without `Range` on a `READY` video (200, full body byte-identical to the fixture); `GET .../stream` with a `Range` header (206, correct `Content-Range`, partial bytes match); `GET .../download` (200, `Content-Disposition: attachment`); `GET .../stream` or `.../download` on a non-`READY` video (409 `VIDEO_NOT_READY`); by a non-owner (403); for an unknown slug (404) |

**Dependencies:** SI-03.5, SI-03.3

**Acceptance criteria:**

- `GET /videos/:slug/stream` on a `READY` video with no `Range` header returns 200 with the full file and `Accept-Ranges: bytes`
- `GET /videos/:slug/stream` with `Range: bytes=0-99` returns 206 with exactly 100 bytes and `Content-Range: bytes 0-99/{total}`
- `GET /videos/:slug/download` returns 200 with `Content-Disposition: attachment` and the full file body
- `GET /videos/:slug/stream` on a `DRAFT`/`PROCESSING`/`ERROR` video returns 409 with `VIDEO_NOT_READY`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| channel_id | uuid | FK → channels.id, not null | owner of the video |
| title | varchar(120) | not null | from `initiateUpload` payload |
| slug | varchar(16) | unique, not null | `crypto.randomBytes`-generated per TD-04; used in `/videos/:slug/stream` and `/videos/:slug/download` |
| status | enum(`draft`,`processing`,`ready`,`error`) | not null, default `draft` | per TD-05 |
| original_key | varchar | not null | storage key, `channels/{channelId}/videos/{videoId}/original.{ext}` |
| thumbnail_key | varchar | nullable | set by the worker on success |
| upload_id | varchar | nullable | S3 multipart upload id; null once completed or aborted |
| content_type | varchar(100) | not null | validated against the allowlist at initiate time |
| size_bytes | bigint | not null | client-declared at initiate time, ≤ 10GB |
| duration_seconds | integer | nullable | set by the worker from `ffprobe` |
| width | integer | nullable | set by the worker from `ffprobe` |
| height | integer | nullable | set by the worker from `ffprobe` |
| processing_error | text | nullable | set by the worker when processing ends in `ERROR` |
| created_at | timestamp | not null, default now() | |
| updated_at | timestamp | not null, default now() | |

**Relations:** Video → Channel (many-to-one, `channel_id`)
**Indexes:** `slug` — unique; `channel_id` — index (owner lookups)

---

### API Contracts

#### POST /videos/uploads (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, required — 3–120 characters
- originalFilename: string, required
- sizeBytes: number, required — 1 ≤ sizeBytes ≤ 10737418240 (10GB)
- contentType: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`

**Response 201:**
- id: string (uuid)
- slug: string
- status: `'draft'`
- uploadId: string
- parts: array of `{ partNumber: number, url: string }`

**Response headers:**
- Location: /videos/:id

**Error responses:**
- 400 validation error: `title`/`sizeBytes`/`contentType` fail DTO validation
- 401: missing/invalid access token

#### POST /videos/uploads/:id/complete (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>

**Request body:**
- parts: array of `{ partNumber: number, eTag: string }`, required

**Response 200:**
- id: string
- slug: string
- status: `'processing'`

**Error responses:**
- 400 UPLOAD_PARTS_MISMATCH: `parts` length does not match the expected part count
- 401: missing/invalid access token
- 403 FORBIDDEN_VIDEO_ACCESS: caller does not own the video's channel
- 404 VIDEO_NOT_FOUND: `:id` does not match any video
- 409 VIDEO_NOT_IN_DRAFT: video status is not `draft`

#### POST /videos/uploads/:id/abort (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** _(no body)_

**Error responses:**
- 401: missing/invalid access token
- 403 FORBIDDEN_VIDEO_ACCESS
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_IN_DRAFT

#### GET /videos/:id (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string
- slug: string
- title: string
- status: `'draft' | 'processing' | 'ready' | 'error'`
- durationSeconds: number | null
- sizeBytes: number
- contentType: string
- processingError: string | null
- createdAt: string (ISO-8601)

**Error responses:**
- 401: missing/invalid access token
- 403 FORBIDDEN_VIDEO_ACCESS
- 404 VIDEO_NOT_FOUND

#### GET /videos/:slug/stream (SI-03.7)

**Request headers:**
- Authorization: Bearer <access_token>
- Range: bytes=<start>-<end> (optional)

**Response 200** _(no Range requested)_ **or 206** _(Range requested):_
- Raw video bytes (`Content-Type` from the video's `content_type`)

**Response headers:**
- Accept-Ranges: bytes
- Content-Length _(200)_ or Content-Range: bytes <start>-<end>/<total> _(206)_

**Error responses:**
- 401: missing/invalid access token
- 403 FORBIDDEN_VIDEO_ACCESS
- 404 VIDEO_NOT_FOUND: unknown slug
- 409 VIDEO_NOT_READY: video status is not `ready`

#### GET /videos/:slug/download (SI-03.7)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- Raw video bytes (`Content-Type` from the video's `content_type`)

**Response headers:**
- Content-Disposition: attachment; filename="<title>.<ext>"

**Error responses:**
- 401: missing/invalid access token
- 403 FORBIDDEN_VIDEO_ACCESS
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Role |
|----------|--------|---------------|------|
| POST /videos/uploads | | ✓ | Owner (video's channel = caller) |
| POST /videos/uploads/:id/complete | | ✓ | Owner |
| POST /videos/uploads/:id/abort | | ✓ | Owner |
| GET /videos/:id | | ✓ | Owner |
| GET /videos/:slug/stream | | ✓ | Owner |
| GET /videos/:slug/download | | ✓ | Owner |

_No public/anonymous access to video endpoints in this phase — anonymous viewing and visibility (public/unlisted) are introduced in Fase 04/05._

---

### Error Catalog

_Error response format inherited from Fase 02 (`{ statusCode, error, message }`, established in `phase-02-auth/TD-07` — not redefined here)._

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | `:id`/`:slug` does not match any video, or matches a video owned by another channel (indistinguishable from non-existence to avoid enumeration — see note below) |
| FORBIDDEN_VIDEO_ACCESS | 403 | You do not have access to this video | Caller's channel does not own the video, used when the video exists but access must be explicitly denied (mutation endpoints) |
| VIDEO_NOT_IN_DRAFT | 409 | Video upload is not in a state that can be completed or aborted | `POST .../complete` or `.../abort` when `status != draft` |
| UPLOAD_PARTS_MISMATCH | 400 | Uploaded parts do not match the expected multipart upload | `POST .../complete` with a `parts` array whose length/order does not match the parts issued at `initiateUpload` |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | `GET .../stream` or `.../download` when `status != ready` |

_Note: read endpoints (`GET /videos/:id`, `.../stream`, `.../download`) return `VIDEO_NOT_FOUND` for both a non-existent id/slug and one owned by another channel — mutation endpoints (`complete`, `abort`) return the more specific `FORBIDDEN_VIDEO_ACCESS` since the id was already obtained from the owner's own `initiateUpload` response, so there is no enumeration concern there._

---

### Events/Messages

| Event | Payload | Publisher | Consumer | Delivery |
|-------|---------|-----------|----------|----------|
| `process` (queue `video-processing`) | `{ videoId: string }` | `VideoQueueService` (API, on `completeUpload`) | `VideoProcessor` (worker) | ack-required — BullMQ job with `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` (per TD-05); job is acked on successful `process()` return, retried on throw, and marked `failed` (triggering the `ERROR` status update) after attempts are exhausted |

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.3
└── SI-03.4

SI-03.2 (no deps)

SI-03.2 + SI-03.3 + SI-03.4
├── SI-03.5
└── SI-03.6

SI-03.5 + SI-03.3
└── SI-03.7
```

Linearized implementation order: SI-03.1, SI-03.2 (parallel — no shared files) → SI-03.3, SI-03.4 (parallel, both depend only on SI-03.1) → SI-03.5, SI-03.6 (parallel, both depend on SI-03.2 + SI-03.3 + SI-03.4) → SI-03.7 (depends on SI-03.5 + SI-03.3)

## Deliverables

- [x] Upload of videos up to 10GB via presigned multipart directly to MinIO/S3, without the file passing through the API process
- [x] Video pre-registered as `DRAFT` automatically when the upload is initiated
- [x] Automatic processing after upload completes: duration/dimensions extracted via `ffprobe`, thumbnail generated via `ffmpeg`
- [x] Unique, collision-free slug generated per video, used in streaming/download URLs
- [x] Streaming via `Range`/`206 Partial Content` — playback does not require downloading the full file
- [x] Download endpoint serving the full video file with `Content-Disposition: attachment`
- [x] Video status lifecycle (`DRAFT → PROCESSING → READY/ERROR`) reflected in the database, with automatic retry/backoff absorbing transient processing failures
- [x] MinIO (object storage), Redis (queue broker), and the video worker all running as real services in `docker compose up -d`, alongside the existing API/DB/Mailpit services
- [x] Migration creates the `videos` table linked to `channels`
- [x] All SI tests pass in nestjs-project (`docker compose exec nestjs-api npm test -- --runInBand --forceExit`) — 187/187
- [x] E2E tests pass in nestjs-project (`docker compose exec nestjs-api npm run test:e2e`) — 70/70
- [x] Type-check passes in nestjs-project (`docker compose exec nestjs-api npx tsc --noEmit`) — exit 0
- [x] Lint passes in nestjs-project (`docker compose exec nestjs-api npm run lint`) — 0 errors (105 pre-existing `no-unsafe-argument` warnings, project-wide rule already set to `warn`, do not fail the build)
- [x] Project builds successfully (`docker compose exec nestjs-api npm run build`) — exit 0

