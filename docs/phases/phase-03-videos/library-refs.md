---
libs:
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "unavailable — context7 MCP not connected in this session; fetched_at documents were sourced via WebSearch against npm registry + docs.bullmq.io instead. Cross-referenced against the installed NestJS 11 major to confirm compatibility (see recommendation below)."
    fetched_at: "2026-07-29T23:00:00-03:00"
  "bullmq":
    version: "^5.81.3"
    context7_id: "unavailable — see note above"
    fetched_at: "2026-07-29T23:00:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1098.0"
    context7_id: "unavailable — see note above"
    fetched_at: "2026-07-29T23:00:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1098.0"
    context7_id: "unavailable — see note above"
    fetched_at: "2026-07-29T23:00:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-video-upload-processing.md: "2026-07-30T08:20:06-03:00"
---

# library-refs — phase-03-videos

> **Note on sourcing:** `.mcp.json` in this repo only configures the `postgres` MCP server; `context7` was not connected in this session (`ToolSearch` found no `context7` tool). Per `research/SKILL.md`'s instruction to prioritize primary sources when Context7 is unavailable, the entries below were sourced via `WebSearch`/`WebFetch` directly against each library's official docs/npm registry page (URLs cited per entry) instead of Context7's cache. Versions were cross-checked against `nestjs-project/package.json`'s installed NestJS 11 major (`@nestjs/common@^11.0.1`, `@nestjs/core@^11.0.1`) for compatibility.

## @nestjs/bullmq

**Version:** `^11.0.4` (latest on npm as of research date; NestJS 11-compatible).

**Usage in this phase:**
- `BullModule.forRoot({ connection: { host: 'redis', port: 6379 } })` in the API's root module (host `redis` — Compose service name, never `localhost`, per `CLAUDE.md` → Docker Networking).
- `BullModule.registerQueue({ name: 'video-processing' })` in `VideosModule` to inject a `Queue` producer.
- Worker side: `@Processor('video-processing')` class extending `WorkerHost`, registered as a provider in the worker's standalone Nest context (per TD-03).

**Source:** [@nestjs/bullmq — npm](https://www.npmjs.com/package/@nestjs/bullmq), [BullMQ NestJS guide](https://docs.bullmq.io/guide/nestjs)

## bullmq

**Version:** `^5.81.3` (peer/transitive dependency of `@nestjs/bullmq`; requires Node >=12.22.0 — satisfied by the project's `node:25.6.0-slim` base image).

**Usage in this phase:**
- `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }` job options on the enqueue call (per TD-05's resolved parameters), so transient worker/storage failures retry automatically before the video is marked `ERROR`.
- Depends on `ioredis` internally (`5.11.1` per the fetched registry metadata) — no direct project dependency needed, `@nestjs/bullmq`/`bullmq` bring it transitively.

**Source:** [bullmq — npm registry](https://registry.npmjs.org/bullmq/latest)

## @aws-sdk/client-s3

**Version:** `^3.1098.0`.

**Usage in this phase:**
- `S3Client` configured with `endpoint` pointing at the MinIO Compose service (`http://minio:9000`), `forcePathStyle: true` (required for MinIO/path-style buckets), and static credentials from env vars.
- `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand` for the upload flow (TD-02).
- `GetObjectCommand` (with `Range` passed through) for the streaming/download proxy (TD-04).

**Source:** [@aws-sdk/client-s3 — npm registry](https://registry.npmjs.org/@aws-sdk/client-s3/latest)

## @aws-sdk/s3-request-presigner

**Version:** `^3.1098.0` (kept in lockstep with `@aws-sdk/client-s3` — both are part of the same AWS SDK v3 modular release train).

**Usage in this phase:**
- `getSignedUrl(client, command, { expiresIn: 3600 })` to presign each `UploadPartCommand` during the multipart upload flow (TD-02's resolved 60-minute expiry parameter).

**Source:** [AWS SDK — presigned URL example](https://docs.aws.amazon.com/AmazonS3/latest/API/s3_example_s3_Scenario_PresignedUrl_section.html)

---

**FFmpeg/ffprobe (TD-03):** no npm library — binaries installed via `apt-get install -y ffmpeg` in the worker's Dockerfile (Debian package, matching the `node:25.6.0-slim` base already used by `nestjs-project/Dockerfile.dev`), invoked via Node's built-in `child_process.execFile`. No Context7/npm entry applies.

**Unique slug generation (TD-04):** Node's built-in `crypto.randomBytes` — already a project dependency (Node core), no new library, no Context7 entry needed (mirrors `src/channels/nickname.util.ts`).
