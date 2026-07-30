---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-29T23:24:36-03:00"
  docs/decisions/technical-decisions-video-upload-processing.md: "2026-07-30T08:20:06-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-29T23:26:38-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-07-29T23:26:38-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-29T23:26:38-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-29T23:24:36-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-30T08:20:59-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, rascunho→publicação, visibilidade pública/unlisted, painel de gerenciamento, página pública de canal (Fase 04); player de vídeo, sugestões, contagem de visualizações, acesso anônimo à página de visualização (Fase 05); qualquer UI de vídeo no `next-frontend/` (o enunciado do desafio exclui explicitamente a interface de vídeo do frontend desta fase).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — nenhuma tela de vídeo é implementada nesta fase (fora do escopo do desafio); a UI de upload/player fica para fases futuras do projeto geral.

**Sequencing notes:** Depende da Fase 01 (config base) e Fase 02 (auth — usuário autenticado e canal 1:1 já existem e são donos dos vídeos).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| video-upload-processing/TD-01 | technical-decisions-video-upload-processing.md | Backend | Tecnologia de Fila de Processamento | decided | A (BullMQ + Redis) | `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.x` |
| video-upload-processing/TD-02 | technical-decisions-video-upload-processing.md | Backend | Estratégia de Upload de 10GB | decided | A (Multipart direto ao storage via URL pré-assinada) | `@aws-sdk/client-s3@^3.1098.x`, `@aws-sdk/s3-request-presigner@^3.1098.x` |
| video-upload-processing/TD-03 | technical-decisions-video-upload-processing.md | Backend | Execução do Worker + FFmpeg/ffprobe | decided | B (contexto standalone NestJS) + B (`child_process.execFile`) | — (nenhuma lib nova; `ffmpeg` via apt no Dockerfile do worker) |
| video-upload-processing/TD-04 | technical-decisions-video-upload-processing.md | Backend | URL única + Streaming/Download | decided | B (slug dedicado) + A (proxy da API com Range/206) | — (reaproveita `crypto` nativo) |
| video-upload-processing/TD-05 | technical-decisions-video-upload-processing.md | Backend | Ciclo de Status e Falha | decided | B (4 estados + retry/backoff BullMQ) | — |

_Source files:_

- video-upload-processing — `docs/decisions/technical-decisions-video-upload-processing.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | video-upload-processing/TD-02 |
| Serviço de processamento em segundo plano (filas) | video-upload-processing/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | video-upload-processing/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | video-upload-processing/TD-02, video-upload-processing/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | video-upload-processing/TD-03, video-upload-processing/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | video-upload-processing/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | video-upload-processing/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | video-upload-processing/TD-04 |
| Download do vídeo pelo usuário | video-upload-processing/TD-04 |

## Decisions Detail

### video-upload-processing/TD-01

**Recommendation:** BullMQ + Redis — é a integração de fila com melhor suporte de primeira classe no ecossistema NestJS (`@nestjs/bullmq`), com retry/backoff/concorrência prontos sem código extra, o que reduz superfície de bugs no worker. O custo de adicionar Redis ao Compose é baixo e o diagrama de arquitetura já reserva um container dedicado para a fila.

**Libraries:** `@nestjs/bullmq@^11.0.4`, `bullmq@^5.81.x`

### video-upload-processing/TD-02

**Recommendation:** Multipart direto ao storage via URL pré-assinada — mantém a API sem estado para o fluxo de bytes, é resumível por parte, e é testável com qualquer cliente HTTP simples. Organização: bucket único `videos` com prefixos `channels/{channelId}/videos/{videoId}/original.<ext>` e `.../thumbnail.jpg`. **Parâmetros:** payload de início (`title`, `originalFilename`, `sizeBytes` ≤10GB, `contentType` na allowlist `video/mp4|quicktime|webm|x-matroska`); parte multipart fixa em 100MB; URLs pré-assinadas expiram em 60min.

**Libraries:** `@aws-sdk/client-s3@^3.1098.x`, `@aws-sdk/s3-request-presigner@^3.1098.x`

### video-upload-processing/TD-03

**Recommendation:** Contexto standalone do NestJS (`NestFactory.createApplicationContext`) em container próprio, reaproveitando entidades/repositórios/config do `VideosModule` via `@Processor`/`WorkerHost` do `@nestjs/bullmq`. FFmpeg/ffprobe invocados via `child_process.execFile` direto (não `fluent-ffmpeg`, confirmadamente arquivado desde 2025-05-22); binários instalados via `apt-get install -y ffmpeg` no Dockerfile do worker. **Parâmetros:** thumbnail capturada em 1s (ou `duração/2` se o vídeo tiver menos de 2s).

**Libraries:** — (nenhuma lib npm nova; `ffmpeg` binário via apt)

### video-upload-processing/TD-04

**Recommendation:** Slug dedicado gerado com `crypto.randomBytes` (mesmo padrão de `channels/nickname.util.ts`), único-indexado com retry em colisão, usado nas rotas públicas de streaming/download. Entrega via proxy da API com suporte a `Range`/`206 Partial Content` (não redirect/presigned GET), mantendo a autorização centralizada na API.

**Libraries:** — (reaproveita `crypto` nativo do Node)

### video-upload-processing/TD-05

**Recommendation:** 4 estados (`DRAFT`, `PROCESSING`, `READY`, `ERROR`) com retry/backoff nativo do BullMQ (já decidido em TD-01) absorvendo falhas transitórias, e uma coluna `processing_error` (nullable) para diagnóstico. **Parâmetros:** `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Custom guards com `@nestjs/jwt` (`JwtAuthGuard` global + decorators `@Public()`/`@CurrentUser()`) — divergiu da recomendação original (`@nestjs/passport`) durante a implementação para manter a superfície de dependências menor.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — abordagem documentada do NestJS, já usada extensivamente no projeto; toda nova rota HTTP desta fase segue o mesmo padrão de DTO.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — erros de domínio (`DomainException` + subclasses) são mapeados para `{ statusCode, error, message }` por um filtro global; novos erros desta fase (ex.: vídeo não encontrado, upload inválido) seguem o mesmo padrão em vez de lançar `HttpException` diretamente dos services.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (`@nestjs/throttler`) — rate limiting nativo via `APP_GUARD`/`@SkipThrottle()`; disponível como padrão a reaproveitar caso esta fase precise limitar algum endpoint sensível (ex.: iniciar uploads).

**Libraries:** `@nestjs/throttler@^6.x`

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger` + CLI plugin com `classValidatorShim: true`) — todo controller/DTO novo desta fase deve usar os decorators do `@nestjs/swagger` (ou reaproveitar a inferência automática via `class-validator`) para permanecer coberto pela documentação OpenAPI já publicada.

**Libraries:** `@nestjs/swagger@^11.x`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + `openapi.json` exportado via `npm run openapi:export`) — novos endpoints de vídeo aparecem automaticamente na Swagger UI e no spec exportado, sem passo manual adicional.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Swagger UI exposta apenas em dev/staging via env flag) — nenhuma mudança necessária nesta fase; a política já se aplica a qualquer novo endpoint.

**Libraries:** —

## Inherited Conventions

- Erros de domínio herdam de `DomainException` (`errorCode`, `httpStatus`, `message`) em `src/common/exceptions/domain.exception.ts`, mapeados para `{ statusCode, error, message }` por um filtro global — novas exceptions desta fase seguem o mesmo padrão, nunca lançando `HttpException` diretamente de services. _(from phase 02)_
- Validação de entrada usa DTOs com `class-validator`/`class-transformer`; nenhuma DTO desta fase deve validar campos manualmente no controller/service. _(from phase 02)_
- Autenticação usa `JwtAuthGuard` global (`@nestjs/jwt`) com decorators `@Public()` para rotas públicas e `@CurrentUser()` para extrair o usuário autenticado; endpoints de vídeo protegidos (upload, iniciar/completar multipart) seguem esse padrão em vez de reimplementar verificação de token. _(from phase 02)_
- Rate limiting, quando necessário, usa `@nestjs/throttler` via `APP_GUARD`/`@SkipThrottle()` — não introduzir uma segunda lib de rate limiting. _(from phase 02)_
- Config usa `@nestjs/config` com factories `registerAs(name, () => ({...}))` namespaced em `src/config/`, injetadas via `ConfigType<typeof xxxConfig>` — uma nova config de storage/fila/worker desta fase segue o mesmo arquivo-por-domínio. _(from phase 01)_
- Env vars são validadas por um schema Joi único em `src/config/env.validation.ts`, com `validationOptions: { allowUnknown: true, abortEarly: false }` — novas env vars (S3/MinIO, Redis) entram nesse mesmo schema. _(from phase 01)_
- Migrations são geradas via TypeORM CLI (`npm run migration:generate`), nunca escritas por `synchronize: true` em produção. _(from phase 01)_
- Toda entidade usa `@PrimaryGeneratedColumn('uuid')`, `@CreateDateColumn()`/`@UpdateDateColumn()`, e nome de tabela explícito em `@Entity('table_name')`. _(from phase 02)_
- Identificadores públicos únicos gerados por colisão-retry usam `crypto.randomBytes` (não uma lib de terceiros) — precedente em `src/channels/nickname.util.ts`. _(from phase 02)_
- Novos controllers/DTOs usam decorators do `@nestjs/swagger`, mantendo a Swagger UI e o `openapi.json` exportado (`npm run openapi:export`) sempre coerentes com o código. _(from openapi-docs-nestjs, ad-hoc)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities relevant to this phase's backend scope._ (A única capability diferida em fases anteriores — telas de auth no frontend — já foi endereçada em `phase-02-auth-frontend`, fora do escopo backend desta fase.)

## Non-UI / Deferred Capabilities

_None._ — todas as 9 capabilities da Fase 03 são cobertas por TDs backend nesta mesma fase (ver Capability Coverage).

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/` (Entity → Integration; Service with DB → Integration; Service with branching → Unit + Integration; Controller → E2E only; DTO → E2E validation wiring; Module → Unit compilation).

**Overrides to the guide's `references/external-systems.md` for this phase** (resolved here because the guide predates Phase 03's decisions and its object-storage suggestion conflicts with the assignment's explicit non-simulation requirement):

- **Object Storage** — the guide's existing text suggests a local-filesystem adapter for tests ("no mocking needed... S3 in production"). This phase overrides that: storage is MinIO (S3-compatible), already required as a real Compose service by the architecture diagram and by the assignment's explicit "não simule o que dá para rodar de verdade" rule. `StorageService` integration tests hit the real `minio` Compose service, not a local-filesystem fake.
- **Message Queue** — the guide already anticipated "likely BullMQ with Redis", confirmed by TD-01. Integration tests use the real `redis` Compose service and the real BullMQ `Queue`/`Worker`, per the guide's existing BullMQ example pattern.

No testing guide exists yet specifically for a "Worker" artifact type (BullMQ `@Processor`/`WorkerHost` classes) or for FFmpeg/ffprobe child-process invocations — `plan-build` resolves the test layer for these new artifact types explicitly in each SI's Tests section (integration tests against the real queue/real `ffmpeg` binary in the worker's own container, per the guide's "no mocking what can run for real" principle).

### nestjs-project

| Artifact type | Required layers |
|---|---|
| Entity (`video.entity.ts`) | Integration: constraints, defaults, unique slug index |
| Service with branching + DB (upload orchestration, status transitions) | Unit: branch logic (mock repo/queue/storage) + Integration: DB contract |
| Service with side-effect dep (`StorageService` — MinIO; `VideoQueueService` — BullMQ) | Integration: real MinIO / real Redis-backed queue |
| Module with configured imports (`VideosModule`, `WorkerModule`) | Unit: compilation test |
| Controller (`VideosController`) | E2E only |
| DTO (upload init/complete, video responses) | E2E: one validation wiring test per endpoint |
| Worker processor (`@Processor`/`WorkerHost`) | Integration: real queue + real `ffmpeg`/`ffprobe` binaries against a small fixture video |
| Exception Filter (reused, no new filter expected) | — (covered by phase 02; extend Error Catalog only) |
