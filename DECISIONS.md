# Decisions

Every non-obvious choice made while building `trace`, and why. Written as the
choices were made, not reconstructed afterwards.

## Repository and tooling

**The repository root is `trace`.** The brief drew the tree with a `trace/`
directory at the top; this checkout is that directory. There is no nested
`trace/trace`.

**pnpm workspaces plus Turborepo.** pnpm's content-addressed store means the
three packages share one copy of TypeScript. Turbo is configured but
deliberately thin: `build`, `typecheck`, `dev`. It earns its place when the
web app starts depending on contracts builds, not before.

**pnpm 12.4.2, not 9.x.** The first pin was 9.12.3, chosen from memory, and it
cost an hour. Vite 8 bundles rolldown, whose platform binary ships as an
optional dependency; pnpm 9 resolved the lockfile entry but never installed
`@rolldown/binding-linux-arm64-gnu` inside the container, so the web service
crash-looped on a missing native module while the same lockfile worked on the
host. pnpm 12 installs it correctly. Pin the package manager to something
current, and verify it inside the target platform rather than on the host.

**`allowBuilds` in `pnpm-workspace.yaml`.** pnpm 10 and later refuse to run
dependency install scripts unless approved. esbuild fetches its platform binary
and argon2 resolves a native prebuild, so neither is optional. The setting lives
in `pnpm-workspace.yaml`, not the `pnpm` key of `package.json`, which pnpm 12
ignores with a warning that is easy to miss.

**Node base image 22.23.2, not 22.11.** Corepack in the older image carries
stale signing keys and rejects any recently published pnpm with
`Cannot find matching keyid`. The base image and the package manager have to be
upgraded together.

**Every workspace manifest is copied into every image.** Each Dockerfile copies
all three `package.json` files even though it installs one subtree, because
`--frozen-lockfile` compares the lockfile against the manifests it can see and
rejects the tree as outdated when one is missing. The first version papered over
this with `|| pnpm install`, which silently produced a different dependency tree
than the lockfile describes. The fallback is gone; drift now fails the build.

**`packages/contracts/dist` is an anonymous volume.** The bind mount that gives
the api hot reload also shadows the compiled contracts the image built, so
without this a fresh clone would have to run `pnpm build` on the host before
`docker compose up` could work. That is exactly the path a new teammate takes.

**TypeScript 5.9.3, not 7.0.2.** TS 7 is published, but `drizzle-kit` and the
Fastify type plugins have not been validated against the native port. A
final-year project is the wrong place to debug someone else's compiler
migration. Revisit after the ecosystem catches up.

**Zod 3.25.76, not 4.x.** Zod 4 moves `z.string().datetime()` to
`z.iso.datetime()` among other renames. Nothing in the brief needs Zod 4, and
3.25 is the settled end of the v3 line.

**`noUncheckedIndexedAccess` and `noUnusedLocals` on.** The first turns every
`array[0]` into `T | undefined`, which is the honest type and catches the
class of bug where a grader result array is shorter than its input. It costs
a few non-null assertions in code where the length is provably right.

## Service boundaries

**Python is a model server with no state.** It holds no database handle, makes
no retrieval decision and stores nothing. `/extract` receives a path and
returns blocks; `/embed/*` receives text or paths and returns vectors. Every
decision about what to do with that output is in Node. This is what makes the
"agentic loop lives in TypeScript" claim structural rather than stylistic.

**Files move by shared volume, not by HTTP body.** Both containers mount
`uploads` at `/data/uploads`, and `/extract` takes a path. Sending a 500 MB
video over HTTP to the extractor would mean buffering it twice for no reason.
The cost is that the two services must share a filesystem, which rules out
putting them on different hosts without a shared mount. Acceptable for a
project that ships as one compose file.

**The ML service validates that the path is inside the upload root.** Both
sides are ours, but a path traversal on an internal service is still a path
traversal. `_resolve_within_uploads` rejects anything that escapes.

**The worker is a separate container from the api.** Same image, different
command. A ten-minute whisper decode in the same process as the HTTP server
would compete with request handling for the event loop and the heap.

## Data and retrieval

**Qdrant named vectors, one collection.** `dense` (384, cosine) and `clip`
(512, cosine) as named vectors plus a `bm25` sparse vector, all on the same
point. One collection keeps a chunk's text and image representations together,
so a modality filter is a payload filter rather than a second query to a
second collection.

**`modifier: 'idf'` on the sparse vector.** fastembed's `Qdrant/bm25` emits
raw term frequencies. Without the modifier, Qdrant would score them as plain
dot products and the BM25 branch would silently favour long documents.

**RRF fusion runs in Qdrant, not Node.** `query_points` with a `prefetch` per
branch. Hand-rolling fusion in Node would mean pulling both candidate lists
over the wire to re-sort them, and would put a scoring decision in a place
nobody would think to look for it.

**`chunks.kb_id` is denormalised from `documents`.** It is derivable by a join,
but every retrieval filter and every knowledge-base deletion needs it, and the
join is on the hot path.

**Chunk modality mirrors document modality.** A chunk from a PDF is `pdf`, not
`text`, so "search only the videos" is one payload filter. What the chunk
actually is gets recorded in `source` (`text`, `ocr`, `asr`, `caption`), which
is also what the UI renders as a provenance badge.

**Node owns chunking, Python owns extraction.** `/extract` returns pre-chunk
blocks: one PDF page, one whisper segment, one keyframe. Character offsets are
computed in exactly one place, in TypeScript, next to the code that writes them
to the citation. Splitting that logic across two languages is how page numbers
end up off by one.

## The agent loop

**Sufficiency thresholds are environment variables.** `SUFFICIENCY_MIN_SCORE`
and `SUFFICIENCY_MIN_RELEVANT_CHUNKS` are config because the evaluation chapter
sweeps them to plot false-answer rate against over-abstention rate. A constant
in `sufficiency.ts` would make that chapter impossible to write honestly.

**Thresholds are echoed into the sufficiency event.** A trace read months later
explains its own decision without anyone having to guess what the settings were
that day.

**Grading failures drop the chunk.** The `corrective_rag` reference keeps a
chunk when grading throws, "to be safe". That biases the system toward
answering precisely when its judgement is least reliable. We drop it and record
the failure in the trace, which biases toward abstention instead. Defensible in
both directions; ours is the one that matches the abstention claim.

**Citations are verified before they are returned.** A `[^n]` marker is
resolved against the chunks that were actually in the synthesis context, and a
marker that does not resolve is dropped and reported in `rejectedMarkers`. If
none survive, the answer becomes an abstention. Taken from
`agentic_typed_rag_pydanticai`; see `docs/PRIOR_ART.md`.

**Structured output is JSON mode plus Zod plus one repair attempt.** Rather
than converting Zod schemas to the provider's JSON-schema dialect, the prompt
carries a shape hint, the response is parsed and validated, and a failure is
sent back once with the validation errors attached. This keeps one schema
definition instead of two and works identically across providers. The cost is
an occasional extra call.

## LLM

**Model ids live in env.** `GEMINI_MODEL` defaults to `gemini-3.8-flash`. No
model string appears in any logic path.

**An OpenAI provider ships alongside Gemini.** Written against the REST API
rather than the `openai` SDK, so a path most installs never take does not add a
dependency. Its `stream()` yields one chunk rather than real tokens; that is
noted in the code rather than hidden, and the interface is honoured.

**Token bucket plus retry with full jitter.** The free tier rejects bursts, and
parallel chunk grading is exactly a burst. Callers queue rather than fail.
Jitter is full rather than partial so that a dozen graders released at once do
not resynchronise on the next attempt.

**Streaming is not retried after the first token.** Retrying mid-stream would
replay text the client already rendered. Only stream setup retries.

## Models

**RapidOCR over PaddleOCR and Tesseract.** Pure ONNX, roughly 15 MB of weights,
no system packages beyond what opencv needs. Tesseract needs a system install
and loses badly on document images; PaddleOCR drags in the Paddle runtime.

**Captions from Gemini Flash, not BLIP.** BLIP-base would add about 2 GB
resident for something that runs a handful of times per document. On an 8 GB
laptop that is the difference between working and swapping.

**faster-whisper `base` at `int8` with VAD.** Roughly realtime on a CPU core,
which is what keeps a ten-minute video inside the ingestion budget. VAD removes
silence before decoding, which is most of the saving on lecture recordings.
Word timestamps are on because a citation that points at a 30-second segment is
not precise enough to seek to.

**PyTorch from the CPU index.** The default PyPI wheel carries CUDA kernels
that cannot run here and would add several gigabytes to the image.

**opencv, and therefore `libgl1`, is in the image.** `rapidocr-onnxruntime`
depends on `opencv-python`, not the headless build, so the GUI shared libraries
have to be present even though nothing draws a window. Swapping to the headless
package would mean patching the dependency.

## Security

**argon2id with OWASP settings**, 19 MiB and two passes, which stays under
about 100 ms on a laptop core.

**Login verifies against a dummy hash when the account does not exist**, so a
missing account and a wrong password take the same time to reject.

**JWT in an httpOnly cookie**, not in local storage, so a script injection
cannot read the session. `sameSite: lax` and `secure` driven by `COOKIE_SECURE`.

**URL ingestion validates every redirect hop.** Node's `fetch` follows
redirects with no hook, so redirects are handled manually with
`redirect: 'manual'` and each `Location` is revalidated. A single up-front
check, which is what the reference does, is defeated by a public host that
redirects to link-local.

**The blocklist is the complement of "globally routable", not a list of
obviously private ranges.** Carrier-grade NAT (100.64/10), the broadcast
address, IPv4-mapped IPv6 and NAT64 are all covered.

**Known limitation: DNS rebinding is not fully closed.** `assertPublicUrl`
resolves and validates, then the socket resolves again, and a hostile resolver
can answer differently the second time. Closing it properly means connecting to
the validated address with the `Host` header preserved. Recorded rather than
papered over.

## Operational

**`/healthz` is liveness only; `/readyz` reports dependencies.** A slow Qdrant
must not cause an orchestrator to kill a healthy API. A cold ML service does
not fail readiness either, because models load on first use by design.

**The Qdrant healthcheck opens a raw TCP socket via bash.** The image ships
neither curl nor wget.

**Dev target with bind mounts, plus anonymous volumes for `node_modules`.**
Three people editing behind a rebuild-per-change loop would be miserable. The
anonymous volumes stop the host mounts from shadowing the dependencies
installed in the image.

**Compose fails loudly on a missing `JWT_SECRET`** via `${JWT_SECRET:?...}`
rather than booting with a blank signing key.

## Phase 1: ingestion and the loop

**Node chunks, Python extracts.** `/extract` returns pre-chunk blocks: one PDF
page, one whisper segment, one keyframe. All character arithmetic happens in
one language, next to the code that writes the citation.

**Pages never merge, transcript segments always do.** A chunk spanning two
pages has no single page number, and page attribution is the guarantee. A
whisper segment is a few seconds of speech and too small to retrieve against,
and merging only widens its timestamp span, which loses nothing. The rule is
one predicate, `canMerge`, and the tests assert both halves.

**Chunking is the most tested code in the repository.** Nineteen tests, and the
one that matters asserts a property rather than a value: every character span a
chunk reports must lie inside the page text it came from. That is the invariant
the whole citation feature rests on.

**Qdrant is written before Postgres.** A crash between the two leaves an orphan
vector, which retrieval drops when the chunk row is missing. The other order
would leave a chunk row pointing at a vector that does not exist, which
surfaces as a citation to something unretrievable.

**Ingestion progress crosses processes over Redis pub/sub.** The worker
produces the events and the api serves the SSE, and they are separate
containers. Delivery is fire-and-forget on purpose: document status is also
persisted, so a client that connects late has missed nothing that matters.

**The agent runs when the client opens the stream, not when the message is
posted.** POST reserves the assistant message; GET runs the loop. The work
happens exactly once and always has somewhere to send its output. The cost is
that a client which never connects never triggers the run.

**The sufficiency gate is authoritative over synthesis.** An earlier version
decided `abstain` and then synthesised an answer anyway, because synthesis only
abstained on empty evidence. That made the abstention path decorative and put
the trace in direct contradiction with the answer beneath it. Synthesis now
treats the decision as binding.

**Citations accept `[^n]` and `[n]`.** The prompt asks for `[^n]`; the model
drifts to the plain footnote form often enough that rejecting it discarded
correctly grounded answers over punctuation. Surviving markers are normalised
to one spelling before they reach the client.

**The done frame carries the authoritative answer.** Streamed tokens are
provisional: an answer whose citations all fail verification is replaced by an
abstention, and tokens already sent cannot be unsent. The client renders
`done.answer`, not the text it accumulated.

**A failed synthesis is not an abstention.** An abstention is a statement about
the corpus; a model outage is a statement about the service. Collapsing them
would tell a user their documents lack an answer when the model simply could
not be reached, so the two produce different text.

## Free-tier reality, measured rather than assumed

The quota turned out to be the binding constraint on the whole design, and none
of it was visible from the documentation alone.

**`gemini-3.8-flash` allows 20 requests per day on the free tier**, and 5 per
minute. One agentic pass costs three to five requests. Twenty per day is not
enough to develop against, let alone demonstrate. `GEMINI_MODEL` is therefore
set to `gemini-3.1-flash-lite` in the working `.env`, while `.env.example`
keeps `gemini-3.8-flash` as the documented intent for anyone with quota.

**Quotas are enforced per model, which is what makes the split work.**
`gemini-3.1-flash-lite` kept answering while `gemini-3.8-flash` was exhausted.
Query analysis and chunk grading therefore run on `GEMINI_FAST_MODEL` and
synthesis on `GEMINI_MODEL`: two budgets instead of one, and the structured
classification work is the part least sensitive to model strength anyway.

**A 429 carries the delay the server actually wants.** Guessing an exponential
backoff when the service has already said "retry in 40s" burns the attempt
budget early and fails anyway. `withRetry` honours `RetryInfo.retryDelay`.

**A per-day quota is not a rate limit you can wait out.** The service still
returns a `retryDelay` for one, so honouring it blindly cost a minute per
attempt and failed regardless. Daily exhaustion is now terminal on the first
response, and the error says so.

**Each provider instance owns its bucket, and the bucket does not burst.**
Capacity is two rather than the full per-minute allowance, because a fresh
process cannot know how much of the current window has already been spent by an
earlier run.

## Bugs worth recording

Each of these was found by running the system, not by reading it.

- **ffmpeg emitted a keyframe past the end of a short clip**, producing a chunk
  whose `ts_end` preceded its `ts_start`. Frames at or beyond the duration are
  discarded with a warning.
- **The Python caption path had no retry** while the Node provider had one, so a
  single transient 503 silently cost a caption. The policies now match.
- **Chunking discarded `imagePath` for text chunks**, losing the rendered page
  image for scanned PDFs, which is exactly the case where a reader most wants to
  see the page. Two tests now pin it.
- **DuckDuckGo served a bot-check page under a non-browser user agent**, with a
  202 and no results, which is indistinguishable from "nothing matched". The
  client now sends a browser user agent and detects the block explicitly.
- **`sh` does not expand `**`**, so tests nested two directories deep never ran.
  The glob is quoted and handed to node.
- **Two pure functions were untestable** because they transitively imported the
  environment module, and a unit test of an IP predicate should not need a
  database URL. `ipRules.ts` and `searchParse.ts` are now config-free.
- **`tsx watch` never reloaded inside the container.** The bind mount is
  virtiofs, which delivers no inotify events, so edits appeared to have no
  effect and were debugged as logic errors. `CHOKIDAR_USEPOLLING` fixes it, and
  the reload was verified by touching a file rather than assumed.
- **CORS did not allow DELETE**, so removing a document, deleting a knowledge
  base and disconnecting a mailbox all failed in the browser at the preflight
  while succeeding from `curl`. The plugin was registered with `origin` and
  `credentials` only, and the default method list did not include it. The
  methods are now stated explicitly. This is the second bug in this file of the
  same shape as the SSE header one below: a browser-enforced rule that no
  server-side test can see.
- **An anonymous volume outlived the image that created it**, so the api ran a
  compiled `@trace/contracts` from before the connector schemas existed and died
  at boot on a missing export. The volume over `/app/packages/contracts/dist`
  exists to stop the host bind mount shadowing the build output, but it survives
  `docker compose build`, so rebuilding the image changed nothing. The visible
  symptom was the browser reporting "failed to fetch" on sign-in: with no server
  listening there is no error response to show, so an infrastructure failure
  presents as a network one and gets debugged as CORS or credentials. `worker`
  was also absent from `compose ps`, having waited for an `api` that never became
  healthy — the clearest signal, and the easiest to overlook.

  The general lesson: when every request fails at once, read the server's logs
  before forming any theory about the request. And a container health check is a
  better first question than a browser error, because it distinguishes "rejected"
  from "never answered".

## Phase 2: the interface

**Citations render in a panel, not inline.** Inline markers make an answer hard
to read and turn citation ids into noise. The markers in the prose are small
buttons that open the evidence; the panel lists the sources. Taken from the
reference implementation, which got this right.

**The done frame is authoritative, and the client obeys it.** Streamed tokens
are provisional. `useAnswer` replaces the accumulated text with `done.answer`,
because an answer whose citations all failed verification becomes an
abstention and the superseded text is already on screen.

**`ask` resolves when the stream ends, not when it opens.** The first version
returned as soon as the EventSource was created, so compare mode ran both modes
concurrently while a comment claimed it ran them sequentially. On a
per-minute-metered free tier that spends the budget twice as fast and makes
both loops fail. The promise now settles on `done` or `error`.

**The 3D embedding map is a 2D canvas.** A few thousand points is well inside
what canvas handles, and a WebGL scene graph would outweigh the feature on a
laptop build. Rotation is a yaw and pitch applied by hand, with mild
perspective so depth reads while dragging.

**The map scales from a high percentile, not the maximum.** PCA on a small
corpus leaves one or two outliers far from the rest, and scaling to them
squeezes every other point into the centre of the canvas.

**Every chunk is its own point.** The reference averages a document's chunks
into a single point, which hides how a document spreads across topics. That
spread is the interesting part.

**Compare mode shares everything except retrieval.** Same synthesis prompt,
same citation resolver, same corpus, one question. The difference on screen is
the retrieval strategy and nothing else, which is what makes the evaluation
chapter a controlled comparison rather than two anecdotes.

**A session check costs a 401 on first load.** The cookie is httpOnly, so the
only way to know whether a session exists is to ask the server and let the
request fail. The console error is the price of not exposing the session to
JavaScript.

## Groq as the default provider

**Chosen on request allowance, not on model quality.** Groq's free tier permits
on the order of a thousand requests a day; Gemini's permits twenty on the
synthesis model. The evaluation dataset is twenty-one questions and costs about
a hundred and thirty requests across both retrieval modes, so the choice is
between an evaluation that can be run and one that cannot. Everything else was
secondary to that.

**It cost almost no code, which is the point of the provider interface.** Groq
serves the `/chat/completions` shape, so the existing OpenAI client became
`OpenAICompatibleProvider` with an injected base URL, key and rate, and both
concrete providers are now a constructor call. The agent loop did not change,
which is the claim the second provider existed to test in the first place.

**Real SSE streaming was implemented at the same time, because it had to be.**
The OpenAI provider had been yielding the whole completion in one chunk, which
was acceptable while it was a path almost nobody took. As the default provider
it would have turned a live answer into a long pause followed by a wall of
text, which is a visible regression from Gemini.

**The SSE scanner is a pure function with its own tests.** The failure it
guards against is invisible: an SSE frame can arrive split across two reads, and
parsing the half silently drops a token from the answer. That is the kind of bug
that never shows up in a demo and corrupts every long answer. Testing it needed
no network and no environment, for the same reason `ipRules.ts` and
`searchParse.ts` are config-free.

**An empty key for the selected provider fails validation rather than falling
back.** A silent downgrade to a different provider would make the system quietly
answer from a model nobody chose, and the whole design rests on being able to
say what produced an answer.

**The per-minute rate is set per provider.** `LLM_RPM` was tuned for Gemini's
free tier; Groq's per-minute allowance is much higher, and reusing the Gemini
number would have throttled the provider chosen specifically for its throughput.

## Degrading instead of failing

**Only a per-day quota exhaustion falls back to the local model.** The rate
limiter already distinguishes the two cases and the distinction is the whole
design: a per-minute 429 clears on its own and is waited out, because giving up
the better model over a few seconds of delay would be a bad trade. Falling back
on any 429 would do exactly that.

**The breaker is process-wide, not per provider pair.** A daily allowance
belongs to the API key, not to one model. Grading discovering the wall should
not leave synthesis to rediscover it a second later at the cost of another
request that is certain to fail.

**It half-opens rather than latching until restart.** A daily allowance does
come back. Which timezone it comes back in is a property of the vendor's
billing, not something worth encoding, so the breaker simply probes the hosted
provider again after a cooldown and re-trips if the wall is still there.

**Streaming chooses its provider before the first token and does not fall back
mid-flight.** Tokens already sent cannot be withdrawn, and replaying them from
a different model would contradict what the reader has already seen. A quota
failure during stream setup trips the breaker for the calls that follow instead
of rescuing that one.

**The local provider has no token bucket.** The constraint the limiter exists
to manage is a quota, and a local model does not have one — it has a queue.
Throttling the only unmetered path would be backwards.

**No guarantee is weakened by the switch.** Citation resolution and abstention
run after synthesis and do not care what produced the text, so a fallback
answer is verified by the same code and abstains under the same rules. The
degradation is in fluency, not in grounding, which is the right thing to trade.

**The local model is opt-in and off by default.** The image and weights are a
multi-gigabyte download, and the stack is fully functional without them, so it
sits behind a compose profile rather than in the default `up`.

**It is also what makes the evaluation's answer stage runnable.** Twenty-one
questions across two modes is far beyond a day of free-tier requests and
nothing at all to a local model. A feature added to survive a demo turned out
to unblock the measurement the project is judged on.

## Phase 3: the evaluation harness

**The harness lives in `apps/api/src/eval/`, not in a package of its own.**
`eval/` is not a workspace glob, and more importantly the harness needs the
real `hybridSearch` and the real `runAgent`. Evaluating a reimplementation of
either would measure the reimplementation. The directory keeps the datasets it
reads and the reports it writes.

**Retrieval and answering are separate stages because only one of them costs
quota.** Embedding a query goes to the local ML service and fusion happens in
Qdrant, so the retrieval stage is free and unlimited; the answer stage is three
to five Gemini requests per question per mode, which on the free tier is a
handful of questions a day. Splitting them means ranking work can be measured
continuously and the expensive stage is reserved for confirming that better
retrieval produced better answers.

**The answer stage is built to be interrupted.** Each result is written to
`eval_results` the moment it completes, and an exhausted daily quota stops the
run and prints a resume command instead of burning the remaining questions on
certain failures. A run that stops early keeps its metrics but leaves
`finished_at` null, so resuming appends rather than opening a second run over
the same dataset.

**Relevance is labelled by filename, not chunk id.** Chunk ids are regenerated
on every re-ingest. A dataset keyed to them would score zero the first time the
corpus was rebuilt and read as a retrieval regression rather than a stale
label. Pages narrow it where the distinction matters.

**Recall is computed over labelled documents, not retrieved chunks.** How many
chunks of one document came back says nothing about coverage, and counting them
would let a single well-matched document score full recall on a question that
needs two sources.

**Abstaining on an answerable question scores zero on the citation metrics, not
one.** Treating "no citations" as vacuous perfection would make refusal the
optimal strategy for every metric the harness reports, which is precisely
backwards for a system whose selling point is knowing when to refuse.

**The dataset is rejected rather than scored when it is inconsistent.**
Duplicate ids make resume ambiguous; an unanswerable question that also labels
relevant documents is a contradiction that would score as both a hit and a
required abstention. The runner also refuses to start when the dataset names a
document that is not indexed, because a missing document otherwise scores as a
retrieval failure and sends you debugging the retriever.

**Scoring is pure and config-free.** `metrics.ts` imports nothing — no
environment, no database, no client — so its eleven tests run without a
`DATABASE_URL`. This is the same lesson already recorded for `ipRules.ts` and
`searchParse.ts`, applied at the point it was easiest to get wrong.

**First result: the sample corpus is too small to evaluate retrieval on.** The
correct chunk ranks first for all sixteen answerable questions, at every k, so
MRR is 1.000 and hit@k is 100%. At k=12 the retriever returns twelve of the
corpus's twenty chunks, which makes 100% recall close to meaningless, and each
question targets a distinct document so there is almost nothing confusable to
rank wrongly. A corpus this small cannot distinguish agentic from naive
retrieval, because one-shot retrieval already ranks the answer first every
time. The comparison needs genuine confusability — many documents on
overlapping topics — which is what the mailbox connector produces. Reported as
a ceiling, not as a result. The harness earning its place on its first run by
invalidating the corpus it was pointed at is the argument for having built it.

## Connected mailboxes

**IMAP with an app password, not the Gmail API.** Gmail's API is free and its
quota is far beyond anything this would use, but `gmail.readonly` is a
restricted scope. An app that has not been through OAuth verification is capped
at 100 test users and issues refresh tokens that expire after seven days, which
cannot support a service that syncs on a timer. Verification for a restricted
scope additionally requires an annual third-party security assessment that
costs money. An app password over IMAP has none of that, is free, and does not
expire. The cost is no push: IMAP IDLE would need a connection held open per
connector, so the connector polls instead.

**The credential is encrypted with a key derived from `JWT_SECRET`.** An app
password reads an entire mailbox, so storing it in plaintext beside the row
that uses it makes a database dump a set of working credentials. The key is
derived rather than configured separately because two secrets to rotate is
worse than one, and the coupling is correct: if the signing key leaked, a
credential sealed under a key derived from it is suspect too. Rotating
`JWT_SECRET` therefore invalidates every stored connector, and the error says
to reconnect rather than failing obscurely.

**UIDVALIDITY is stored with the UID watermark, not separately.** An IMAP UID
is meaningful only while UIDVALIDITY holds. When a server changes it, stored
UIDs are not stale but meaningless — they may now refer to different messages.
The cursor therefore restarts from the date window rather than resuming at a
number, and dedup by `Message-ID` is what stops that restart importing the
mailbox a second time.

**Dedup is a unique index on `(connector_id, external_id)`, not a lookup.**
Checking for an existing row before inserting is a race with the next poll.
Postgres treats NULLs as distinct, so uploaded documents, which have no
connector, never collide on it.

**The watermark is written before the ingestion jobs are enqueued.** A crash
between the two loses embeddings for messages that are already stored, which
re-ingesting fixes. The opposite order loses the cursor and re-downloads the
mailbox. Neither is free, but only one of them is recoverable without hitting
the mail server again.

**Headers are part of the indexed text.** A chunk reading "yes, approved, go
ahead" is worthless as evidence. With `From`, `Date` and `Subject` prepended,
the same chunk answers who approved it and when, and the sender becomes
retrievable — "what did Priya say about the deadline" matches on the header
line rather than needing metadata filtering the retriever does not have. It
also means a citation's snippet carries its own provenance without extending
the citation contract.

**Attachments become documents in their own right.** They are the reason to
connect a mailbox at all: the scans, invoices and voice notes worth asking
about arrive as mail, and they flow through the existing OCR, whisper and CLIP
pipeline with no new extraction code.

**Mailbox polling is a separate worker with concurrency 1.** Sharing the
ingestion worker would let a slow IMAP round trip hold a slot whisper needs,
and two syncs of one mailbox at once would race the same watermark.

**Schedules are reconciled from Postgres at api boot.** The repeatable jobs
live in Redis and the connector rows live in Postgres, and only one of those
can be authoritative. A Redis that comes up empty — a fresh deployment, a wiped
volume, a managed instance restarted without persistence — leaves the connector
rows intact and their polling silently gone: the interface keeps showing the
mailbox as idle with a last-synced time that never advances, and nothing
reports an error because nothing failed. Rebuilding the missing schedules on
boot makes that unrecoverable-by-inspection failure impossible.

**A mailbox host goes through the SSRF address guard.** The host is
user-supplied, so without the check "connect a mailbox" is a port scanner
pointed at the internal network. It reuses `isBlockedAddress`, the same rule
that guards URL ingestion.

**Ingesting mail costs no LLM quota.** Extraction and embedding are local, so a
mailbox can multiply the corpus without touching the Gemini budget that
constrains everything else here. Only answering costs requests.

## Conversation continuity

**History is read by the analyse node and by nothing else.** A follow-up like
"and what about those in a recording?" retrieves nothing, because the words
that say what it is about are in the previous turn. Resolving that is a
retrieval problem, so it belongs in the stage that builds the search plan. It
deliberately does not go to synthesis: prior turns in the synthesis context
would be quotable, an earlier sentence could be cited as a source, and an
answer grounded in a previous answer is the exact failure the citation
resolver exists to prevent. Evidence comes from the corpus on every turn, or
the turn abstains.

**The analyser returns the resolved question as a separate field.** `rewrites`
already existed and is a set of alternative phrasings; conflating the two would
lose the distinction between "the same question in document vocabulary" and
"what the question actually refers to". `standaloneQuery` is optional and
absent on a first turn, so the field itself records whether anything needed
resolving, and the trace shows the reader what the retriever was really asked.

**The resolved question leads the query list, and a retry reformulates from
it.** Keeping the user's own wording first, which is what the first turn does,
would send "and the second one?" to the index on every iteration.

**Naive mode ignores history.** It has no analyse stage, so there is nowhere
honest to put the resolution. Handing it the resolved question would move part
of the agentic loop into the control and make the evaluation's controlled
comparison a comparison of something else. The baseline is single-pass
retrieval on the words the user typed, and it stays that.

**The agent takes history as an argument rather than reading the database.**
The evaluation harness runs the same loop with no conversation at all, and a
scored run must not depend on the order its questions ran in. The route that
owns the conversation loads the turns; the loop keeps one input contract.

**Only complete messages become history.** A pending or failed assistant row
has no answer, and feeding a half-written one back would describe the thread as
the model never left it. The current question is excluded by id, not by
timestamp, because the question and its assistant placeholder are inserted in
one transaction and can share a timestamp — and a question resolved against
itself is circular.

**The first question titles the thread.** A switcher needs names, and this is
the only one available without spending a model call on it. A title the user
set is never overwritten, and the update is conditional on the row still
carrying the default, so two rapid first messages cannot race into two
different titles.

**Returning to a knowledge base resumes its most recent thread.** The previous
behaviour created a conversation on every mount, which is why a demo database
accumulates empty threads. Continuing what you were asking is the common case;
starting again is a button.

**A stored answer renders through the same component as a live one.** A
citation in a turn from yesterday has to behave exactly like one in the answer
still streaming — same marker, same hover, same page it opens. Two rendering
paths would drift, and the one that drifts is the one nobody is looking at.

## The reading room, reconsidered

**The conversation is the main component, not the margin.** The first layout
gave the document the dominant column and set the answer beside it as
marginalia, on the theory that the document is the subject. Using it disproved
that: a reader arrives with a question, not with a document, and for most of a
session there is nothing open to read — so the dominant column was empty while
the thing being used was squeezed beside it. The conversation now holds the
full width and the reader opens to its right on a citation, taking the width
back when it closes.

**A text document renders its own words.** The reader had a branch for pages,
one for media and one for images, and a text document matched none of them: it
has no rendered surface, so the pane was simply blank. This was invisible while
the corpus was uploads — a PDF, an image, an mp3 — and became the common case
the moment a mailbox was connected, because every mail message is text/plain.
The words are the surface, and the cited span is marked in place inside them.

**One sans for prose, one mono for coordinates.** The display serif was doing
editorial work the interface does not need, and at small sizes it cost
legibility in exactly the places a reader is checking a claim. Inter carries
everything a person reads. What stays set apart is the mono: a page number, a
character range, a timestamp and a duration are machine-verified coordinates
rather than prose, and keeping them in a different voice is the typographic
half of the citation model.

## Giving the assistant a name and a face

**A blank composer explains nothing.** Someone who has not seen this before
cannot tell from an input box that the thing behind it reads their documents,
cites what it finds, and refuses when it cannot. Vera — from veritas, since
verification is the whole product — says that in one sentence on an empty
thread, and offers starter questions named after documents that are actually in
the corpus, because a generic "summarise everything" is the question this
system answers worst: there is no span to cite for it.

**The thinking state reports the real stage, not a fake sequence.** The wait
between asking and the first token is the agentic loop, and it is long enough
to need explaining. The label is read off the same event bus the trace drawer
renders, so "weighing each passage" means the grade node is running right now.
A timed animation would have been easier and would have started lying the first
time a retry made the loop take another pass.

**A spinner, not a progress bar.** The loop can decide to retry, so any bar
would have to go backwards, and a bar that goes backwards is worse than no bar.
The ring turns; the passage count beside it rises as evidence comes in, which is
the only honest measure of progress available.

**She leaves once the work starts.** A mascot that keeps introducing itself to
someone already working is noise, so the greeting shows only on an empty thread
and is dismissible; the thinking state appears only before the first token and
is replaced by the answer itself.

## More rooms

**The knowledge base has a front door.** The index route was the library, which
answered "what is in here" and nothing else. An overview answers the three
questions someone actually returns with — what is in the corpus, what has
arrived since, what was being asked when they left.

**The evaluation is a page, not just a markdown file.** The harness already
wrote its runs to Postgres; only the report read them. Serving those rows means
the comparison the project is judged on is in the product, and a route that
only reads them keeps one source of truth: a number on screen is the number the
report was generated from rather than a second measurement.

**A count is not a rate.** The metrics map mixes fractions with counts, and the
first render printed 21 questions as 2100%. Formatting is now per metric, since
one obviously wrong number on a page of numbers costs the reader's trust in all
of them.

## A bug only a browser could find

**SSE responses carried no CORS headers.** `SseStream` writes to the raw socket
to avoid Fastify buffering the stream, and that bypasses every header a plugin
attached to the reply, including `Access-Control-Allow-Origin`. `curl` does not
enforce CORS, so every backend test passed while the browser refused both the
chat stream and the ingestion stream outright. The constructor now copies the
access-control headers off the reply before writing its own.

The general lesson is recorded because it will recur: verifying a
browser-facing feature with `curl` verifies the server, not the feature.

## Verification

Phase 0 was verified on an Apple Silicon host with no container runtime
installed, so `colima` was installed to run the stack. `docker compose up` from
clean brings up all seven containers; both health endpoints, registration,
session verification and knowledge-base creation were exercised over HTTP, and
the Qdrant collection, payload indexes and all eight tables were inspected
directly. Hybrid dense plus BM25 retrieval with server-side RRF fusion was smoke
tested end to end against the live collection and ranked correctly.

One verification was initially wrong and is worth recording. The web service
was reported as working on the strength of `curl localhost:5173` returning 200
with a Vite react-refresh preamble. That response came from an unrelated Vite
dev server already running on the host: it had bound `[::1]:5173` while Docker's
forward bound `*:5173`, so neither failed to start and macOS resolved
`localhost` to the host process. A 200 from a dev server proves a dev server is
running, not that it is yours. Checking `<title>` would have caught it
immediately, and that is the check that now appears in the README. The web port
default is `5174` to avoid the collision entirely.

`GEMINI_API_KEY` in the local `.env` is a placeholder. Environment validation
only requires it to be non-empty, so the stack boots and every Phase 0 path
works, but no LLM call has been executed against a real key.

## Deferred

- Token-level streaming for the OpenAI provider
- Connecting to the validated IP to close the DNS rebinding window
- Re-ranking after fusion; RRF alone is the phase 1 baseline
- An LLM-judged faithfulness metric: whether a cited span entails the claim
  attached to it. Deferred because a judge costs the same quota as the answers
  it grades, which on the free tier would halve the questions per day
- A threshold sweep driver over `SUFFICIENCY_MIN_SCORE` and
  `SUFFICIENCY_MIN_RELEVANT_CHUNKS`; `eval_runs.config` already records what a
  run used, so the sweep is a loop around the existing stage
- IMAP IDLE for push delivery; the connector polls
- Grouping a mail thread into one document rather than one per message
- Word-level bounding boxes from PDF extraction, which is what
  `HighlightLayer` needs before it can draw a box over the cited paragraph
