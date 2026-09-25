# Evaluation harness

The chapter this supports is the agentic-versus-naive comparison, so the
harness runs the same question set through both modes against the same corpus
and the same synthesis prompt, changing only the retrieval path.

The code lives in `apps/api/src/eval/` because it needs the real retrieval
layer and the real agent loop — evaluating a reimplementation of either would
measure the reimplementation. This directory holds the datasets it reads and
the reports it writes.

## Running it

```bash
# Costs no LLM quota. Run this as often as you like.
docker compose exec api pnpm --filter @trace/api eval retrieval

# Costs three to five requests per question per mode.
docker compose exec api pnpm --filter @trace/api eval answer --mode both

# Both, with a smaller k and a subset of the dataset
docker compose exec api pnpm --filter @trace/api eval all --k 5 --limit 8
```

Flags: `--dataset <path>`, `--kb <uuid|name>`, `--k <n>`, `--mode
agentic|naive|both`, `--limit <n>`, `--resume <runId>`, `--notes "..."`,
`--out <path>`.

## The two stages, and why they are separate

**Retrieval** embeds the query through the local ML service and fuses in
Qdrant. No Gemini request is made, so it is free and unlimited. Every ranking
or threshold change should be measured here first.

**Answers** runs the full loop, three to five requests per question per mode.
On the free tier that is a handful of questions a day, so it is built to be
interrupted: each result is written to `eval_results` the moment it finishes,
and an exhausted *daily* quota stops the run and prints the resume command
rather than discarding work already paid for.

```bash
docker compose exec api pnpm --filter @trace/api eval answer --resume <runId> --mode agentic
```

## The dataset

JSONL, one question per line, in `datasets/`. A dataset is appended to far more
often than rewritten, and one line per question gives a readable diff when a
label changes. `//` comment lines are ignored.

```json
{"id":"q01","question":"...","relevantDocuments":["handbook.pdf"],"relevantPages":[1],"expectAnswerContains":["BM25"],"unanswerable":false}
```

Relevance is labelled **by filename**, not by chunk id. Chunk ids are
regenerated on every re-ingest, so a dataset keyed to them would score zero the
first time the corpus is rebuilt and look like a retrieval regression.

The loader rejects a dataset rather than scoring a broken one: duplicate ids, an
unanswerable question that also labels relevant documents, an answerable one
that labels none. The runner additionally refuses to start if the dataset names
a document that is not indexed in the target knowledge base — otherwise a
missing document scores as a retrieval failure and sends you debugging the
retriever.

## Metrics

Retrieval, over answerable questions only:

- **precision@k, hit@k, MRR** over retrieved chunks
- **recall@k** over labelled *documents*, not chunks. How many chunks of one
  document came back says nothing about coverage, and counting them would let a
  single well-matched document score full recall on a question needing two.

Answers:

- **abstention accuracy**, split into **false answer rate** (answered something
  unanswerable) and **over-abstention rate** (refused something answerable).
  They are kept separate because they trade against each other: a threshold
  that eliminates false answers by refusing everything is not an improvement.
- **citation precision** — share of citations landing on a labelled document
- **citations resolve** — whether every emitted marker resolved, which is the
  guarantee the system makes
- **answer contains** — expected substrings present

Abstaining on an answerable question scores zero on the citation metrics rather
than a vacuous one: refusing to answer is not a way to achieve perfect
precision.

`eval_runs.config` records the thresholds a run used, which is what makes the
sweep reproducible.

## First result, and what it says about the corpus

On the seeded sample corpus (20 chunks, 16 answerable questions):

| k | precision@k | recall@k | hit@k | MRR |
|---|---|---|---|---|
| 1 | 100.0% | 89.6% | 100.0% | 1.000 |
| 3 | 45.8% | 100.0% | 100.0% | 1.000 |
| 5 | 28.7% | 100.0% | 100.0% | 1.000 |
| 12 | 13.0% | 100.0% | 100.0% | 1.000 |

The correct chunk is ranked first for every question, and precision falls with
k purely because there are only one or two relevant chunks to find.

**These numbers are saturated, not good.** At k=12 the retriever returns twelve
of the corpus's twenty chunks, so recall of 100% means little more than
"returned most of the corpus". Each question also targets a distinct document,
so there is almost nothing confusable to rank wrongly.

The consequence matters for the comparison this harness exists to make: a
corpus this small cannot distinguish agentic from naive retrieval, because
one-shot retrieval already ranks the answer first every time. The comparison
needs a corpus with genuine confusability — many documents on overlapping
topics, which is exactly what a connected mailbox produces. Until then the
answer stage measures abstention behaviour and citation discipline, which it
can still do honestly, and the retrieval numbers should be reported as a
ceiling rather than a result.

That conclusion is the harness doing its job. It was not visible before it was
measured.
