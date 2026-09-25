# trace

Multimodal agentic RAG over your own documents. Upload PDFs (scanned ones too),
text, images, audio and video; ask questions; get answers where every claim
carries a citation that resolves to a page and character span, an image, or a
timestamp. When the corpus does not support an answer, the system says so
instead of guessing.

## Requirements

- Docker with Compose v2 (`docker compose version` must print v2 or later)
- 16 GB RAM recommended, 8 GB workable
- Roughly 8 GB of free disk: model weights are about 700 MB, the ML image is
  the bulk of the rest
- A Google AI Studio API key, free tier: https://aistudio.google.com/apikey

No GPU. No paid API. Everything else runs locally.

## Setup

```bash
cp .env.example .env
# Set the two values that have no default:
#   JWT_SECRET      -> openssl rand -hex 32
#   GEMINI_API_KEY  -> from the link above
docker compose up
```

First run downloads model weights on demand and builds the Python image with
CPU-only PyTorch, so expect ten to twenty minutes. Subsequent runs reuse the
`ml-models` and image caches and come up in under a minute.

When it is up:

| Service | URL |
|---|---|
| Web | http://localhost:5174 |
| API | http://localhost:8080 |
| ML | http://localhost:8000 |
| Qdrant dashboard | http://localhost:6333/dashboard |

## Verifying the stack

```bash
curl -s localhost:8080/healthz              # api liveness
curl -s localhost:8080/readyz               # postgres, qdrant, ml
curl -s localhost:8000/healthz              # ml, with per-model warm-up state

# Register, keeping the session cookie
curl -s -c /tmp/trace.jar -X POST localhost:8080/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery"}'

# Create a knowledge base with that session
curl -s -b /tmp/trace.jar -X POST localhost:8080/kb \
  -H 'content-type: application/json' \
  -d '{"name":"Coursework","description":"Lecture notes and recordings"}'
```

`/healthz` is liveness only and touches no dependency, so a slow Qdrant cannot
get a healthy API killed. `/readyz` is the one that reports the dependency
graph. A `cold` model on `/healthz` is normal: weights load on first use.

## Using it

```bash
# Ingest the sample corpus: one document per modality, about two minutes
docker compose exec api pnpm --filter @trace/api seed

# Inspect retrieval on its own, with no agent and no LLM in the way
docker compose exec api pnpm --filter @trace/api retrieve "how does chunking preserve page numbers"

# Watch ingestion progress
docker compose logs -f worker
```

The seed creates `demo@trace.local` with password `trace-demo-password`.

Asking a question is two calls: one to record it, one to stream the answer.

```bash
curl -s -c /tmp/t.jar -X POST localhost:8080/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"demo@trace.local","password":"trace-demo-password"}'

CONV=$(curl -s -b /tmp/t.jar -X POST localhost:8080/kb/$KB/conversations \
  -H 'content-type: application/json' -d '{}' | jq -r .id)

MSG=$(curl -s -b /tmp/t.jar -X POST localhost:8080/chat/$CONV/messages \
  -H 'content-type: application/json' \
  -d '{"query":"How does chunking handle page boundaries?","mode":"agentic"}' | jq -r .messageId)

curl -N -b /tmp/t.jar localhost:8080/chat/stream/$MSG
```

Append `?mode=naive` to the message call for the single-pass baseline. Both
modes share the synthesis prompt and the citation resolver, so a comparison
measures the retrieval strategy rather than two different prompts.

`done.answer` is authoritative. Streamed tokens are provisional: an answer
whose citations all fail verification is replaced by an abstention, and tokens
already sent cannot be withdrawn.

## The interface

Open http://localhost:5174. The seed script creates `demo@trace.local` with
password `trace-demo-password`.

Real routes, not one page with modes. A document, a mailbox view and an answer
are different places to be, and each survives a reload.

```
/                          what the system is
/signin                    sign in or register
/app                       knowledge bases
/app/kb/:id                overview: what is in the corpus, and what was asked
/app/kb/:id/library        the corpus, grouped by source
/app/kb/:id/ask            the reading room
/app/kb/:id/threads        every conversation in this corpus
/app/kb/:id/evaluation     the harness's runs, agentic against naive
/app/kb/:id/mailboxes      connected mailboxes and their sync state
/app/kb/:id/map            the embedding map
```

**Overview.** Where a knowledge base opens: how many documents and chunks it
holds, what modalities it is made of, which mailboxes feed it, and the threads
and documents most recently touched. A corpus is a thing you return to, and
these are the questions you return with.

**Evaluation.** The harness writes its runs to Postgres; this reads them. Two
runs of one dataset in different modes sit side by side with the better value
marked, the thresholds the run used are printed underneath, and every scored
question is listed with its citation precision and whether it abstained. The
numbers here are the ones the report was written from, not a second measurement
taken a different way.

**Threads.** Every conversation in the corpus, searchable by the question that
started it. The switcher in the reading room is for moving between two or
three; this is for finding one from last month.

**Library.** A rail on the left lists where documents came from — one entry per
connected mailbox, plus `Uploaded` and `From a URL` — and selecting one filters
the list beside it. The selection is a query parameter, so a view of a single
mailbox is a link. Once a mailbox is importing on a timer, "did I add this or
did it arrive?" is the first question a reader asks about a document they do
not recognise, and grouping answers it without opening anything.

**Ask.** The conversation is the room. It sits in a centred column and holds
the full width until there is something to show beside it; a citation or a
document from the library opens the reader to its right, and closing the reader
gives the column its width back. The divider between them drags.

- **The conversation** is the main component: the thread above, the answer
  being written below it, the composer at the foot. Every claim carries a small
  numeral; hovering one fades the sentences it does not support, lifts the
  matching source card, and aims the reader at the page. Sources are parchment
  index cards, because anything that is a cited receipt is printed on parchment
  and the room is not.
- **The reader**, when open, is the document: continuously scrolling pages with
  a page rail, zoom, fit width and fit page; for audio and video a timeline with
  the cited span marked; for a text document — which is what every mail message
  is — its own words, with the cited span marked in place.
- **Above the answer** is the grounding strip: how many claims were made, how
  many were verified, and how many the resolver discarded for pointing at a
  source that was never retrieved. That count is the guarantee this system
  makes, so it is on screen rather than in a log.
- **Mode** selects `agentic`, `naive`, or `compare`, which runs both on one
  question, one after the other, and shows the traces side by side. **trace**
  opens the agent timeline in a drawer: one row per stage with its real
  duration.
- **Threads** run along the top of the answer column. A knowledge base keeps
  its conversations, returning to one resumes the most recent, and every
  earlier turn stays on screen above the question you are asking now — with
  its citations still live, because a stored answer renders through the same
  component as a streaming one. The first question names the thread.

The assistant has a name, **Vera**, and introduces herself on an empty thread:
what she will answer from, that every sentence carries a number, and that she
refuses rather than guesses. While the loop runs she reports the stage it is
actually in — working out the question, searching, weighing passages, deciding
whether that is enough — read off the same event bus the trace drawer uses, so
the wait explains itself rather than spinning.

Follow-ups work in agentic mode: "and what about those in a recording?" is
resolved against the previous turns into a question a retriever can match, and
the resolved wording appears in the trace as `standaloneQuery` beside the
rewrites. Only the search plan sees the history. Evidence is retrieved from the
corpus on every turn and citations are verified against that turn's own
sources, so an earlier answer can never become a source for a later one. Naive
mode has no analysis stage and therefore no follow-up resolution, which is
deliberate: it is the baseline, and moving part of the loop into it would
make `compare` measure something other than retrieval strategy.

Opening a citation shows the evidence in the form its modality calls for: the
rendered page for a PDF, a player seeked to the cited moment for audio and
video, the image itself for a figure.

Page-region highlighting is not implemented: PDF extraction does not yet keep
word geometry, so a citation is marked at the page and span level rather than
drawn as a box over the paragraph. The overlay component exists and takes
rects; nothing feeds it yet. See `HighlightLayer.tsx`.

## Connecting a mailbox

A knowledge base can keep reading an IMAP mailbox, so the corpus grows without
anyone uploading anything. Attachments become documents in their own right and
go through the same OCR, transcription and image pipeline as an upload, which
is the point: the PDFs and voice notes worth asking about usually arrive as
mail rather than as files on a disk.

For Gmail you need an **app password**, not your account password:

1. Turn on 2-Step Verification on the Google account.
2. Create an app password at https://myaccount.google.com/apppasswords
3. In the interface, open the library panel and choose **connect a mailbox**.

The credential is verified before the connector row is written, so a wrong
password fails while you are still looking at the form. It is then encrypted
with AES-256-GCM under a key derived from `JWT_SECRET` and never returned to
the browser. Rotating `JWT_SECRET` invalidates every stored credential, which
is deliberate.

```bash
# Watch the first import
docker compose logs -f worker | grep mailbox
```

The first sync reaches back `sinceDays` (90 by default) and imports at most
`MAILBOX_BATCH_SIZE` messages; the rest arrives on the following polls, every
`MAILBOX_POLL_SECONDS`. After that, syncs are incremental: IMAP `UIDVALIDITY`
plus the highest UID seen is the watermark. Messages are deduplicated by
`Message-ID`, so a watermark reset re-reads the mailbox without duplicating it.

Each message is stored with its `From`, `To`, `Date` and `Subject` headers as
part of the indexed text. That is what makes "what did Priya say about the
deadline" retrievable at all, and it means a citation's snippet carries the
sender and the date rather than a disembodied sentence.

Point this at a mailbox you are willing to have indexed. Message bodies and
attachments land in Postgres, Qdrant and the uploads volume in plaintext.

**Why IMAP and not the Gmail API.** Gmail's API is free and its quota is
enormous, but `gmail.readonly` is a restricted scope. An unverified app is
capped at 100 test users and, more importantly, hands back refresh tokens that
expire after seven days — unusable for anything that syncs on a timer. Lifting
that requires OAuth verification plus an annual third-party security
assessment that is not free. An app password over IMAP has none of those
constraints and costs nothing.


## Choosing a provider

The daily request allowance is the constraint that shapes the most decisions
here, so it is worth stating plainly.

| Provider | Free requests/day | Notes |
|---|---|---|
| **Groq** (default) | ~1,000 per model | Free key, no card. `llama-3.3-70b-versatile` |
| Gemini | **20** on `gemini-3.8-flash` | Enough to demo, not enough to develop against |
| OpenAI | none | Paid from the first request |
| Ollama | unlimited | Local, free, slow on CPU. See below |

Groq is the default because of one number. The sample evaluation dataset is
twenty-one questions, and running it across both retrieval modes costs about a
hundred and thirty requests. That does not fit in a day of Gemini's free tier
and is a rounding error against Groq's — the difference between an evaluation
you can run and one you cannot.

```bash
# Free key, no card: https://console.groq.com/keys
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
```

An empty key for the selected provider is a hard validation failure rather than
a silent fallback, so a misconfiguration is visible at boot.

**Two models, not one.** Query analysis and chunk grading run on
`GROQ_FAST_MODEL`, synthesis on `GROQ_MODEL`. The classification work is
high-volume and far less sensitive to model strength than the answer a person
reads, and on a metered tier it would otherwise consume the budget before an
answer could be produced. The same split exists for every provider.

### Staying on Gemini

Still supported and still a good model:

```bash
LLM_PROVIDER=gemini
GEMINI_MODEL=gemini-3.1-flash-lite   # a usable daily allowance
```

`gemini-3.8-flash` is the better model if you have the quota for it. Quotas are
enforced per model, so the fast/synthesis split is two budgets rather than one.
A per-minute 429 is waited out, honouring the delay the API itself reports; a
per-day 429 fails immediately, because waiting cannot clear a daily allowance.


## Layout

```
apps/api         Node 22, Fastify. Auth, uploads, mailbox connectors,
                 orchestration, Qdrant queries, the agentic loop, SSE
                 streaming.
apps/web         React, Vite, Tailwind, React Router. A landing page, a
                 dashboard, and per-knowledge-base library, reading room,
                 mailboxes and embedding map.
services/ml      Python 3.11, FastAPI. Extraction and model inference only:
                 stateless, no database, no business logic.
packages/contracts  Zod schemas shared by api and web. The single source of
                 truth for every payload shape.
eval             Labelled datasets and generated reports. The harness itself
                 is apps/api/src/eval, because it runs the real retrieval
                 layer and the real agent loop.
docs/PRIOR_ART.md  What we read, took, and deliberately changed.
```

The two-backend split exists because PyMuPDF, RapidOCR, faster-whisper and
open_clip are Python-only, while the logic worth writing carefully is the agent
loop, which lives in TypeScript. Python never makes a decision; it extracts and
embeds.

## Working on it

Requires pnpm 12 or later on the host (`npm i -g pnpm@12.4.2`); pnpm 9 fails to
install Vite's native rolldown binary.

```bash
pnpm install                       # host-side, for editor support and typecheck
pnpm typecheck                     # all packages
pnpm --filter @trace/api test      # 48 unit tests; reads apps/api/.env.test,
                                   # so it needs nothing from your environment
pnpm --filter @trace/contracts build   # then see the stale-dist note below

# Evaluation. The retrieval stage costs no LLM quota; the answer stage does.
docker compose exec api pnpm --filter @trace/api eval retrieval
docker compose exec api pnpm --filter @trace/api eval answer --mode both

pnpm db:generate                   # after editing src/db/schema.ts
pnpm db:migrate                    # applied automatically on api boot
```

Migrations are checked in. `RUN_MIGRATIONS_ON_BOOT=true` means the `api`
container applies them at startup; the `worker` container never does, so the
two cannot race the migration lock.

Source is bind-mounted into the `api`, `worker` and `web` containers with
`tsx watch` and Vite HMR, so edits take effect without a rebuild. A change to
`package.json` does need `docker compose build`.

### Module ownership

Three people, three lanes, minimal overlap:

- `apps/api/src/agent/**` plus `retrieval/**` — the loop
- `apps/api/src/{routes,queue,ingest}/**` plus `services/ml/**` — the pipeline
- `apps/web/**` plus `packages/contracts/**` — the interface

Contracts change by agreement, since both other lanes compile against them.

## Troubleshooting

**`JWT_SECRET must be set`** — compose refuses to start without it rather than
booting with a blank signing key. Set it in `.env`.

**ML container slow on first request** — models load lazily. `curl
localhost:8000/healthz` shows each one as `cold`, `loading`, `loaded` or
`error`. First transcription also downloads the whisper weights.

**Port already in use** — every host port is overridable in `.env`
(`API_PORT`, `WEB_PORT`, `POSTGRES_PORT`, and so on). Change `WEB_PORT` and you
must change `CORS_ORIGIN` to match, or the browser will block every API call.

**The web port opens someone else's app** — 5173 is the Vite default, so any
other Vite project you have ever run claims it too. This collision is silent:
a host dev server binding IPv6 loopback (`[::1]:5173`) and Docker's forward
binding IPv4 (`*:5173`) coexist without either failing, and macOS resolves
`localhost` to `::1` first, so the browser reaches the host process. `lsof -nP
-iTCP:5173 -sTCP:LISTEN` shows both. This repo ships `WEB_PORT=5174` in
`.env.example` for that reason. Confirm you have the right app with
`curl -s localhost:5174 | grep '<title>'`, which should print `trace`.

**A mailbox connects but imports nothing** — the first sync only reaches back
`sinceDays`. An older mailbox needs a larger value at connect time. `docker
compose logs worker | grep 'mailbox sync'` prints the counts per pass.

**`the mailbox rejected those credentials`** — Gmail refuses account passwords
over IMAP. It has to be an app password, and app passwords only exist once
2-Step Verification is on. A Workspace admin can also disable IMAP or app
passwords entirely for a managed account.

**Every request fails with "failed to fetch", and the api container is
restarting** — read `docker compose logs api` before anything else. If it says

```
SyntaxError: The requested module '@trace/contracts' does not
provide an export named '<something>'
```

the container is running a stale compiled copy of `packages/contracts`. The
compose file mounts an anonymous volume over `/app/packages/contracts/dist` so
the host bind mount cannot shadow what the image build produced — but that
volume outlives `docker compose build`, so a rebuilt image keeps using the old
`dist`. The api then dies at boot, answers nothing, and the browser reports a
network failure rather than an error, because there is no server to return one.
`worker` also never starts, since it waits for `api` to become healthy.

Rebuild the contracts inside the running container:

```bash
docker compose exec api pnpm --filter @trace/contracts build
docker compose restart api
docker compose up -d worker
```

Or throw the stale volumes away, which is the durable fix:

```bash
docker compose down
docker compose up --renew-anon-volumes
```

Anything that edits `packages/contracts` needs one of these. A change to
`apps/api` or `apps/web` alone does not: those reload through the bind mount.

**Out of memory during ingestion** — lower `INGEST_CONCURRENCY` to 1 and
`ML_THREADPOOL_WORKERS` to 1. Whisper and OCR are the expensive steps.

**Answers stop with a quota error** — see the free tier section above. `docker
compose logs api | grep RESOURCE_EXHAUSTED` distinguishes the per-minute limit,
which resolves itself, from the per-day one, which does not.

**Code edits appear to do nothing** — the containers bind-mount the source and
reload through a filesystem that delivers no inotify events, which is why
`CHOKIDAR_USEPOLLING` is set for `api` and `worker` and `usePolling` for Vite.
If a change still seems ignored, confirm it reached the container with
`docker compose exec api grep -c <something> /app/apps/api/src/<file>` before
debugging it as a logic error.
