---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-29
scope_description: "Upload de vídeos grandes, fila de processamento em segundo plano, worker de vídeo (FFmpeg/ffprobe), organização de object storage, URL única e streaming/download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — dono de todas as decisões desta fase: fila de processamento, estratégia de upload de 10GB, worker de vídeo, organização do object storage, URL única e streaming/download. Fase é backend-only (o enunciado exclui a interface de vídeo do frontend deste escopo).

---

## TD-01: Tecnologia de Fila de Processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` já modela um componente `Message Queue` com tecnologia `TBD` entre a API e o Video Worker. O upload de um vídeo precisa disparar um job assíncrono (extração de metadados + thumbnail) sem bloquear a resposta HTTP do upload. A escolha da fila define como o job é entregue, re-tentado em falha e observado.

**Options:**

### Option A: BullMQ + Redis
- Fila baseada em Redis, com integração oficial `@nestjs/bullmq` (decorators `@Processor`/`WorkerHost`, `BullModule.registerQueue`). Suporta retry com backoff configurável, concorrência por worker, e um dashboard de observação (Bull Board) opcional.
- **Pros:** integração NestJS de primeira classe (mesmo padrão de módulo/DI já usado em `MailModule`/`AuthModule`); retry/backoff/concorrência prontos, sem código customizado; ecossistema maduro e amplamente documentado para jobs de processamento de mídia.
- **Cons:** introduz um novo serviço de infraestrutura (Redis) no Compose; Redis roda em memória — precisa de persistência (AOF/RDB) configurada para não perder jobs em restart, ainda que aceitável para o escopo local do curso.

### Option B: RabbitMQ + `@nestjs/microservices` (transporte RMQ)
- Broker AMQP dedicado, com o transporter RMQ nativo do NestJS. Modela exchanges/filas explicitamente, forte em roteamento complexo.
- **Pros:** transporter oficial do NestJS; AMQP é um padrão maduro e amplamente adotado fora do ecossistema Node.
- **Cons:** `@nestjs/microservices` é orientado a padrões de mensageria genéricos (request/response, event), não a "job queue" — retry com backoff, concorrência por worker e status do job precisam ser implementados manualmente; operação de um broker AMQP (vhosts, exchanges, filas) é mais pesada do que o necessário para um único tipo de job (processar vídeo).

### Option C: pg-boss (fila sobre PostgreSQL)
- Fila implementada como tabelas + `LISTEN/NOTIFY`/polling no PostgreSQL já usado pelo projeto — nenhum serviço novo de infraestrutura.
- **Pros:** zero infraestrutura nova; reaproveita o Postgres já presente no Compose.
- **Cons:** adiciona carga de polling/lock no banco principal da aplicação, que também atende as consultas OLTP da API, sob uma carga de trabalho (transcodificação de vídeo) que é longa e pesada em I/O; comunidade e tooling bem menores que BullMQ para este tipo de workload; o enunciado exige fila e worker "reais" observáveis no Compose — uma fila sobre o Postgres existente reduz a nitidez desse componente na arquitetura em vez de reforçá-la.

**Recommendation:** **Opção A (BullMQ + Redis)** — é a integração de fila com melhor suporte de primeira classe no ecossistema NestJS (`@nestjs/bullmq`), com retry/backoff/concorrência prontos sem código extra, o que reduz superfície de bugs no worker. O custo de adicionar Redis ao Compose é baixo e o diagrama de arquitetura já reserva um container dedicado para a fila.

**Decision:** A (BullMQ + Redis)

---

## TD-02: Estratégia de Upload de Vídeos de até 10GB

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de armazenamento de arquivos (vídeos e thumbnails), Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance, Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** Um arquivo de até 10GB não pode passar pelo processo Node da API — isso travaria o event loop e a conexão HTTP por potencialmente horas em uma rede lenta, além de impactar todos os outros usuários da API durante o upload. O object storage já está definido (S3/MinIO); a decisão aqui é o protocolo de transporte do arquivo e a organização de buckets/chaves.

**Options:**

### Option A: Upload multipart direto ao storage via URL pré-assinada
- A API cria o registro do vídeo como rascunho e inicia um `CreateMultipartUploadCommand` no storage, retornando `uploadId` + URLs pré-assinadas de `UploadPartCommand` por parte (ex.: partes de 100MB — até ~100 partes para 10GB). O cliente faz upload de cada parte diretamente ao MinIO/S3, sem passar pela API. Ao final, o cliente chama um endpoint da API com a lista de ETags, que executa `CompleteMultipartUploadCommand`.
- **Pros:** bytes nunca atravessam o processo Node — zero impacto de performance na API independente do tamanho do arquivo; nativamente resumível (só as partes que falharem precisam ser reenviadas); partes podem ser enviadas em paralelo; MinIO implementa a API S3 multipart integralmente.
- **Cons:** handshake em múltiplas etapas (iniciar → pré-assinar partes → completar); qualquer cliente de upload (inclusive ferramentas de teste/avaliação como curl/Postman) precisa implementar o particionamento do arquivo.

### Option B: Streaming proxy através da API
- A API recebe o upload via `multipart/form-data` e repassa o stream diretamente ao storage (ex.: `@aws-sdk/lib-storage` `Upload` consumindo o stream da requisição), sem bufferizar o arquivo inteiro em memória.
- **Pros:** contrato simples para o cliente — um único POST com o arquivo, sem lógica de particionamento.
- **Cons:** o processo da API permanece no caminho crítico pelo tempo/bytes inteiros do upload (uma conexão HTTP de longa duração por vídeo); uma queda de conexão reinicia o upload de 10GB do zero; dificulta escalar horizontalmente (conexões long-lived); contraria a orientação explícita do enunciado de não passar o arquivo pela API.

### Option C: Protocolo resumível tus (`@tus/server` + `@tus/s3-store`)
- Protocolo aberto de upload resumível com checkpoint em nível de chunk.
- **Pros:** resumabilidade é o objetivo central do protocolo (não apenas retry de partes, mas retomada exata do offset após queda de rede); possui SDKs de cliente prontos (`tus-js-client`).
- **Cons:** exige que qualquer cliente (inclusive quem for avaliar/testar a API) fale o protocolo tus — não é drivable com curl/Postman puro como um PUT pré-assinado; maturidade de `@tus/s3-store` com MinIO precisa ser validada; adiciona uma dependência de protocolo específica para um ganho (resumabilidade fina) que o multipart de S3 já cobre em grão de parte.

**Recommendation:** **Opção A (multipart direto ao storage via URL pré-assinada)** — é exatamente a orientação do enunciado, mantém a API sem estado para o fluxo de bytes, é resumível por parte, e é testável com qualquer cliente HTTP simples (sem exigir uma lib de protocolo específica), o que facilita a avaliação da entrega.

**Organização de buckets/chaves (uso do storage já definido):** bucket único `videos` com prefixos por recurso — `channels/{channelId}/videos/{videoId}/original.<ext>` para o arquivo original e `channels/{channelId}/videos/{videoId}/thumbnail.jpg` para a thumbnail gerada pelo worker. Um único bucket com prefixos evita a necessidade de política de CORS/lifecycle duplicada entre buckets e mantém o agrupamento por canal/vídeo navegável.

**Decision:** A (Upload multipart direto ao storage via URL pré-assinada)

**Parâmetros (resolvidos em `/plan-resolve`, issues MD-1/AMB-1/MD-3 de `validation.md`):**
- **Payload de `POST /videos/uploads` (inicia o rascunho + multipart):** `title` (string, obrigatório, 3–120 caracteres), `originalFilename` (string, obrigatório), `sizeBytes` (integer, obrigatório, `1 <= sizeBytes <= 10737418240` — 10GB), `contentType` (string, obrigatório, deve pertencer à allowlist abaixo).
- **Allowlist de `contentType` aceito:** `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`. Qualquer outro valor rejeita a requisição antes de criar o rascunho ou o multipart upload.
- **Tamanho de parte multipart:** 100MB fixos (última parte pode ser menor) — para 10GB isso resulta em no máximo 103 partes, bem abaixo do limite de 10.000 partes da API S3, e dentro do mínimo de 5MB por parte (exceto a última) exigido pelo S3/MinIO.
- **Expiração das URLs pré-assinadas:** 60 minutos por parte (`UploadPartCommand`) e 60 minutos para o `CompleteMultipartUploadCommand` — suficiente para uma parte de 100MB mesmo em conexões lentas, sem manter URLs válidas por tempo excessivo.

---

## TD-03: Execução do Worker de Vídeo e Extração de Metadados/Thumbnail

**Scope:** Backend

**Capability:** Transversal — covers: Processamento automático do vídeo após upload (extração de duração e metadados), Geração automática de thumbnail a partir de um frame do vídeo

**Context:** `docs/diagrams/software-arch.mermaid` modela o Video Worker como um container próprio, separado da API, consumindo a fila (TD-01) e usando FFmpeg. É preciso decidir como esse processo roda e como ele fala com FFmpeg/ffprobe.

**Options:**

### Option A: Script Node standalone (sem NestJS) em container próprio
- Um `Worker` do BullMQ instanciado diretamente, chamando `child_process` para FFmpeg/ffprobe, com acesso ao Postgres via um `pg.Pool`/`DataSource` TypeORM criado ad hoc, fora do módulo Nest da API.
- **Pros:** menor overhead de runtime (sem bootstrap de DI do Nest); imagem/inicialização mínimas.
- **Cons:** duplica o acesso a dados em vez de reaproveitar as entidades/repositórios TypeORM já existentes (`Video`, `Channel`); duas fontes paralelas de verdade sobre como uma linha de vídeo é lida/gravada; perde a validação de config (`@nestjs/config` + Joi) e as `DomainException`s já convencionadas no projeto.

### Option B: Contexto standalone do NestJS (`NestFactory.createApplicationContext`) em container próprio
- Um entrypoint `worker.main.ts` separado do `main.ts` da API, que sobe apenas o `VideosModule` (sem HTTP) em modo standalone, registrando um `@Processor`/`WorkerHost` do `@nestjs/bullmq` para consumir a fila.
- **Pros:** reaproveita as mesmas entidades, repositórios, DTOs e `DomainException`s já usados pela API — nenhuma lógica de acesso a dados duplicada; `@Processor` é a contraparte natural do `BullModule.registerQueue` decidido em TD-01; o mesmo `VideosModule` é importado tanto pela aplicação HTTP quanto pelo worker.
- **Cons:** bootstrap de DI um pouco mais pesado que um script puro — irrelevante para um processo de longa duração; controllers do módulo simplesmente não são usados no contexto do worker (sem necessidade de split de módulo para o tamanho atual do projeto).

### Option C: Worker no mesmo processo da API (sem container separado)
- O consumidor da fila roda dentro do próprio processo HTTP da API.
- **Pros:** mais simples de rodar (um único container).
- **Cons:** transcodificação de vídeo é CPU-intensiva e competiria pelo mesmo event loop/processo que atende requisições HTTP; contraria o diagrama de arquitetura, que modela o Video Worker como container próprio; não atende o critério explícito do enunciado de ter um worker real subindo separadamente no Compose.

**Recommendation:** **Opção B (contexto standalone do NestJS em container próprio)** — reaproveita entidades/repositórios/config do `VideosModule` (continuidade em vez de retrabalho) e materializa o Video Worker como o container isolado que a arquitetura já prevê.

**Invocação de FFmpeg/ffprobe:**

### Option A: `fluent-ffmpeg`
- Wrapper com API fluente sobre o binário `ffmpeg`.
- **Pros:** API encadeável popular, muitos exemplos históricos.
- **Cons:** o repositório (`fluent-ffmpeg/node-fluent-ffmpeg`) está arquivado desde 22/05/2025 — não aceita mais issues/PRs e, segundo o próprio README, não há garantia de funcionamento com versões recentes do FFmpeg.

### Option B: `child_process.execFile` direto sobre `ffmpeg`/`ffprobe`
- Chamada direta: `ffprobe -print_format json -show_format -show_streams <arquivo>` para metadados (duração, codecs) — saída já é JSON parseável; `ffmpeg -ss <t> -i <arquivo> -vframes 1 <saida.jpg>` para o frame de thumbnail.
- **Pros:** nenhuma dependência npm nova nem risco de manutenção; controle total sobre argumentos/timeouts; a saída JSON do `ffprobe` remove praticamente todo o valor que o wrapper agregaria para as duas operações necessárias nesta fase.
- **Cons:** sem abstração de alto nível — os comandos e o parsing do JSON de `ffprobe` ficam no código do worker (baixo risco dado o escopo estreito: duração + geração de 1 frame).

### Option C: Fork mantido de `fluent-ffmpeg` (ex.: pacotes de terceiros que republicam a mesma API)
- **Pros:** mantém a API fluente conhecida.
- **Cons:** troca uma dependência confirmadamente arquivada por uma dependência de terceiro não auditada e com histórico de manutenção incerto — não resolve o problema de fundo, apenas o adia.

**Recommendation:** **Opção B (`child_process.execFile` direto)** — `fluent-ffmpeg` está confirmadamente arquivado (verificado: repositório read-only desde 2025-05-22); para o escopo estreito desta fase (probe de duração/metadados + 1 frame de thumbnail), o JSON nativo do `ffprobe` e uma chamada de `ffmpeg` cobrem a necessidade sem depender de um wrapper congelado.

**Provisionamento dos binários:** instalar `ffmpeg` via `apt-get install -y ffmpeg` no Dockerfile do worker (base Debian, consistente com o `node:25.6.0-slim` já usado pela API), em vez de pacotes npm com binários estáticos de terceiros (`ffmpeg-static`/`ffprobe-static`).

**Decision:** B (Contexto standalone do NestJS) + B (`child_process.execFile` direto sobre FFmpeg/ffprobe)

**Parâmetros (resolvidos em `/plan-resolve`, issue AMB-2 de `validation.md`):**
- **Ponto de captura da thumbnail:** frame no timestamp de 1 segundo (`-ss 00:00:01`); se a duração do vídeo (extraída via `ffprobe` antes da chamada de thumbnail) for menor que 2 segundos, usa `duração/2` como timestamp, para nunca posicionar o seek além do fim do arquivo.

---

## TD-04: URL Única por Vídeo e Entrega de Streaming/Download

**Scope:** Backend

**Capability:** Transversal — covers: URL única por vídeo, sem conflito com outros vídeos, Reprodução via streaming (sem necessidade de download completo), Download do vídeo pelo usuário

**Context:** Cada vídeo precisa de um identificador público estável e sem conflito, usado nas rotas de streaming/download; e a entrega precisa suportar `Range`/`206 Partial Content` para tocar sem baixar o arquivo inteiro.

**Options — identificador único:**

### Option A: Reaproveitar o `id` (UUID) do vídeo como identificador público
- **Pros:** zero coluna nova, zero lógica de colisão (mesmo raciocínio já aplicado a `users.id`/`channels.id`).
- **Cons:** UUID é longo e pouco amigável para um link público (não é bloqueante nesta fase, mas a Fase 05 constrói a página pública de visualização sobre este identificador).

### Option B: Coluna dedicada de slug curto (`crypto.randomBytes`, mesmo padrão de `channels/nickname.util.ts`)
- Slug curto (ex.: 10 caracteres hex), único-indexado, gerado na criação do rascunho com retry limitado em caso de colisão.
- **Pros:** reaproveita um padrão já revisado e presente no projeto (nenhuma dependência nova); identificador mais curto e desacoplado da chave interna do banco; a exigência "sem conflito com outros vídeos" é satisfeita por um mecanismo de unicidade explícito (constraint + retry), não implícito.
- **Cons:** uma coluna e um índice a mais; um loop de retry (raríssimo de disparar) na criação.

### Option C: Hash determinístico de `channelId` + timestamp
- **Pros:** sem loop de retry por construção.
- **Cons:** para ser curto e amigável como URL, o hash precisa ser truncado — o que reintroduz a mesma necessidade de índice único + retry como rede de segurança, anulando a vantagem; acopla a forma do identificador público a campos internos.

**Recommendation:** **Opção B** — segue o precedente já estabelecido em `nickname.util.ts` (mesma primitiva `crypto.randomBytes`, sem dependência nova) e satisfaz "sem conflito" com unicidade de banco + retry, em vez de depender apenas de baixa probabilidade estatística.

**Options — entrega de streaming/download:**

### Option A: API faz proxy dos bytes (Range/206)
- `GET /videos/:slug/stream` e `.../download` chamam `GetObjectCommand` no storage repassando o header `Range` recebido, e fazem pipe do stream de resposta para o cliente, traduzindo `206 Partial Content` + `Content-Range`/`Accept-Ranges`.
- **Pros:** único ponto de entrada para o cliente (sem expor o bucket publicamente nem configurar CORS nele); autorização/visibilidade (rascunho vs pronto, e futuramente público/unlisted) é verificada por requisição na própria API; funciona igual em MinIO local e em S3 real, sem mudança de ACL de bucket.
- **Cons:** o processo da API fica no caminho dos bytes (mitigado: é I/O em stream, não bufferiza o arquivo em memória).

### Option B: URL pré-assinada de leitura (redirect)
- A API emite uma URL pré-assinada de `GetObjectCommand` de curta duração; o cliente busca diretamente no MinIO/S3.
- **Pros:** zero bytes passando pela API; `Range` é resolvido nativamente pelo storage.
- **Cons:** exige que o bucket/URL pré-assinada seja alcançável diretamente pelo cliente final (um segundo caminho de rede além da API, CORS na bucket); como esta fase não tem UI de vídeo no frontend, não há cliente que precise consumir esse formato de resposta com vantagem clara sobre um endpoint de streaming direto; dificulta aplicar regras de visibilidade por requisição (rascunho, e futuramente unlisted na Fase 04), já que a URL, uma vez emitida, contorna a API para a leitura em si.

**Recommendation:** **Opção A (proxy da API com Range/206)** — mantém um único ponto de controle de autorização (necessário já nesta fase para o gate rascunho/pronto, e nas próximas para visibilidade), e o custo de "bytes passando pela API" é irrelevante em stream para o escopo do curso. Download reaproveita a mesma rota de proxy com `Content-Disposition: attachment`.

**Decision:** B (slug dedicado) + A (proxy da API com Range/206)

---

## TD-05: Ciclo de Status do Vídeo e Tratamento de Falha

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload, Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O enunciado descreve textualmente o ciclo "rascunho → processando → pronto/erro". É preciso decidir a granularidade dos estados e o que acontece quando o processamento falha.

**Options:**

### Option A: Máquina de estados mínima sem retry automático
- `DRAFT → PROCESSING → READY`, com `ERROR` como estado terminal sem nova tentativa automática (usuário reenviaria o vídeo para tentar de novo).
- **Pros:** mais simples de implementar/raciocinar; corresponde literalmente aos 4 estados citados no enunciado.
- **Cons:** qualquer falha transitória (worker reiniciado no meio do job, engasgo momentâneo do storage) falha permanentemente um vídeo que poderia ter sido processado com sucesso numa nova tentativa.

### Option B: Mesmos 4 estados + retry/backoff nativo do BullMQ
- Mesma máquina de 4 estados, mas o job de processamento usa `attempts` + `backoff` do BullMQ (já decidido em TD-01) para tentar novamente automaticamente antes de marcar `ERROR`; a entidade grava `processing_error` (mensagem, nullable) e `processed_at`.
- **Pros:** absorve falhas transitórias de infraestrutura sem nenhum código de retry customizado (recurso nativo da fila já escolhida); ainda converge para os mesmos 4 estados citados no enunciado; falha é diagnosticável (mensagem de erro armazenada) em vez de silenciosa.
- **Cons:** configuração adicional (tuning de `attempts`/`backoff`) e uma coluna nullable a mais.

### Option C: Sub-estados finos (`UPLOADING`, `QUEUED`, `EXTRACTING_METADATA`, `GENERATING_THUMBNAIL`, `READY`, `ERROR`)
- **Pros:** mais observável/depurável; habilitaria uma barra de progresso futura.
- **Cons:** nenhuma capability desta fase pede progresso granular em UI (isso é território de Fase 04/05); sobre-engenharia em relação ao que é testado/avaliado agora; mais estados significam mais transições para acertar no orçamento desta fase.

**Recommendation:** **Opção B** — os 4 estados citados literalmente no enunciado (`DRAFT`, `PROCESSING`, `READY`, `ERROR`), com retry/backoff automático do BullMQ absorvendo falhas transitórias e uma mensagem de erro armazenada para diagnóstico. É a menor máquina de estados que atende o requisito explícito sem deixar falhas transitórias irrecuperáveis.

**Decision:** B (4 estados + retry/backoff do BullMQ + `processing_error`)

**Parâmetros (resolvidos em `/plan-resolve`, issue MD-2 de `validation.md`):** `attempts: 3` (1 tentativa original + 2 retries), `backoff: { type: 'exponential', delay: 5000 }` (5s, 10s) antes de marcar `ERROR` definitivamente.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de fila | BullMQ + Redis | A |
| TD-02 | Backend | Estratégia de upload de 10GB | Multipart direto ao storage via URL pré-assinada | A |
| TD-03 | Backend | Execução do worker + FFmpeg/ffprobe | Contexto standalone NestJS + `child_process.execFile` | B + B |
| TD-04 | Backend | URL única + streaming/download | Slug dedicado (`crypto.randomBytes`) + proxy da API com Range/206 | B + A |
| TD-05 | Backend | Ciclo de status e falha | 4 estados (DRAFT/PROCESSING/READY/ERROR) + retry/backoff BullMQ | B |
