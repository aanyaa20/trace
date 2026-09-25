# Prior art

Everything here was read before any of `trace` was designed. The source is
`github.com/Shubhamsaboo/awesome-llm-apps`, cloned to a scratch directory
outside this repository at commit `HEAD` on 2026-09-15. No code was copied
verbatim. This document exists because the closest reference is the top search
result for our project title, in a repository with tens of thousands of stars,
and an examiner deserves to know exactly where the line between their work and
ours falls.

## What we read

| Directory | Read for | Verdict |
|---|---|---|
| `rag_tutorials/multimodal_agentic_rag` | Closest prior art: React+Vite+FastAPI, Gemini Embedding 2, ADK, 3D PCA view, citation panel | Two ideas adopted, architecture rejected |
| `rag_tutorials/corrective_rag` | The CRAG loop: grading, query transformation, web fallback | Shape adopted, implementation rejected |
| `rag_tutorials/agentic_typed_rag_pydanticai` | Typed citations, explicit refusal | Strongest reference in the set; two mechanisms adopted |
| `rag_tutorials/hybrid_search_rag`, `local_hybrid_search_rag` | Dense + keyword fusion | Rejected: fusion is delegated to `raglite` and unobservable |
| `rag_tutorials/vision_rag` | QA over images and PDF pages | Rejected: Cohere Embed-4 is a paid API |
| `rag_tutorials/knowledge_graph_rag_citations` | Verifiable source attribution | Citation dataclass shape informed ours |
| `rag_tutorials/gemini_agentic_rag` | Query rewriting and web fallback on Gemini | Threshold-as-config idea adopted |
| `voice_ai_agents/insurance_claim_live_agent_team` | UI pattern: conversation left, live structured panel right; threadpool discipline | Layout adopted, transport rejected |

## What we took

**Verified citations, from `agentic_typed_rag_pydanticai`.** Its
`_valid_citations` checks that the model's quoted span actually occurs in the
chunk it claims to cite, drops citations that fail, and refuses the whole
answer when none survive. This is the single best idea in the repository and
the one most directly aligned with our core claim. Our `agent/citations.ts`
does the same, against the chunk text that was actually in the graded context.

**The answer/citation invariant, same source.** Answered implies at least one
citation; refused implies exactly zero. Encoded in our Zod schemas rather than
in a Pydantic validator, so the frontend cannot render an uncited claim either.

**SSRF hardening, from the same file.** Its `validate_public_url` plus
`_PublicRedirectHandler` validates every redirect hop, not just the first URL,
rejects anything not globally routable, bounds the body, and pins the content
type. We reimplemented this in `apps/api/src/services/ssrf.ts` and
`urlFetch.ts`.

**Threadpool discipline, from `multimodal_agentic_rag/backend/server.py`.**
Every blocking call goes through `run_in_threadpool`. Our `services/ml/app/pool.py`
does the same with a bounded executor, so a whisper decode cannot stall the
healthcheck.

**Sufficiency threshold as configuration, from `gemini_agentic_rag`.** It
exposes `similarity_threshold` as a slider. We expose
`SUFFICIENCY_MIN_SCORE` and `SUFFICIENCY_MIN_RELEVANT_CHUNKS` as environment
variables specifically so the evaluation chapter can sweep them.

**Gemini File API as a fallback, from `multimodal_agentic_rag`.** It is that
project's only ingestion path; for us it is the escape hatch for formats the
local pipeline cannot parse, in `services/ml/app/extractors/fileapi.py`, and it
can be disabled entirely.

**The 3D embedding view and the separate citations panel**, both from
`multimodal_agentic_rag`. Good ideas, kept.

## What we changed, and why

### Against `multimodal_agentic_rag`

Its store is three Python lists behind a mutex, with cosine similarity computed
in a list comprehension and a hand-rolled power iteration for PCA. Restarting
the process discards the corpus. We use Qdrant with named vectors and
server-side RRF fusion, and Postgres for everything relational.

**Chunking destroys the metadata that citation requires.** `_clean_text` runs
`re.sub(r"\s+", " ")` over the whole document before `_chunk_text` splits on a
170-word window. Page boundaries do not survive that, so the finest citation it
can offer is a source id and a chunk index. Our chunker splits on sentence
boundaries and carries page, character offset and timestamp through every
stage.

**Media files get exactly one chunk.** `add_file_source` embeds an entire audio
or video file into a single vector, blended with an annotation vector at 0.32
weight. A one-hour lecture is one point in the index, and no timestamp exists
to cite. We emit one block per whisper segment with word timestamps on.

**The trace is fabricated.** The three-entry `trace` array in `/ask` is
constructed after the answer is already computed, with hardcoded strings. There
is no event bus and nothing is observed. Since the live timeline is our demo
centrepiece, ours is an append-only bus written during execution, with real
per-stage start, finish and duration, streamed over SSE as it happens.

**Retrieval is one pass.** `/ask` embeds the query, takes the best chunk per
source, and hands a fixed packet to an ADK agent whose `retrieve_relevant_context`
tool ignores its arguments and returns that same packet. The agent cannot
re-retrieve even in principle. Ours is a real loop with grading, a sufficiency
decision, re-retrieval, and a hard cap of three iterations.

**Its SSRF check does not cover redirects.** `_validate_fetch_url` resolves the
hostname and rejects private addresses, then hands the URL to
`httpx.AsyncClient(follow_redirects=True)`, which follows any `Location` header
without revalidation. A public host that 302s to `169.254.169.254` passes. We
validate every hop.

### Against `corrective_rag`

Grading is binary `{"score": "yes"|"no"}` with no confidence and no
explanation, one sequential LLM call per document. We return
`{chunkId, relevant, score, reason}`, batched and run in parallel, because the
reason string is rendered in the UI.

Its exception handler appends the document to `filtered_docs` on any grading
error, "to be safe". That silently biases the system toward answering on the
exact inputs where grading is least reliable. We drop the chunk and record the
failure in the trace.

The graph never loops. `grade_documents` routes to `transform_query`, which
routes to `web_search`, which routes to `generate`, terminal. It never
re-queries the corpus with the improved question, and there is no abstention
path: `generate` always produces prose. We re-retrieve from the corpus first,
fall back to the web second, and abstain third.

### Against the hybrid search tutorials

Both call `raglite.hybrid_search` and print the results. The fusion is real but
invisible, and neither can be tuned or reported on. We issue an explicit
`query_points` with `prefetch` over the dense and BM25 branches and RRF fusion
in Qdrant, so the candidate counts per branch appear in the trace.

### Against `vision_rag`

It embeds whole page images with Cohere Embed-4, a paid API, and runs no OCR,
so text inside a page is only reachable through a vision model at query time.
We keep a free-tier-only constraint: open_clip locally for image vectors,
RapidOCR for text baked into pages, captions from Gemini Flash.

## Honest assessment of the delta

Two ideas in the references are better than anything we invented: verified
citation spans and per-hop redirect validation. Both are adopted with
attribution above.

Our contribution is not the loop shape, which is CRAG, nor the multimodal
framing, which is the reference. It is that citations resolve to a page and
character span or a timestamp rather than to a document, that the retrieval
loop is genuinely observable rather than narrated after the fact, and that
there is a controlled agentic-versus-naive evaluation behind both claims.
