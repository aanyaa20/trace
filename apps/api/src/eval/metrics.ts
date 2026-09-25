/**
 * Scoring, as pure functions over plain data.
 *
 * Nothing here imports the environment, the database or a client. DECISIONS.md
 * records why: a unit test of a ranking metric should not need a database URL,
 * and two earlier helpers had to be made config-free for exactly this reason.
 */

export interface RankedItem {
  /** Document the retrieved chunk belongs to. Relevance is labelled by name. */
  filename: string;
  page: number | null;
}

export interface RelevanceLabel {
  relevantDocuments: string[];
  relevantPages: number[];
}

/** A retrieved chunk counts as relevant when its document is labelled, and —
 *  where pages are labelled — when its page is among them. */
export function isRelevant(item: RankedItem, label: RelevanceLabel): boolean {
  if (!label.relevantDocuments.includes(item.filename)) return false;
  if (label.relevantPages.length === 0) return true;
  return item.page !== null && label.relevantPages.includes(item.page);
}

export function precisionAtK(ranked: RankedItem[], label: RelevanceLabel, k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((item) => isRelevant(item, label)).length / top.length;
}

/**
 * Recall is measured over labelled *documents*, not over chunks. The label says
 * which documents contain the answer; how many chunks of one document the
 * retriever happened to return says nothing about coverage, and counting them
 * would let a single well-matched document score full recall on a question that
 * needs two.
 */
export function recallAtK(ranked: RankedItem[], label: RelevanceLabel, k: number): number {
  if (label.relevantDocuments.length === 0) return 0;
  const found = new Set(
    ranked
      .slice(0, k)
      .filter((item) => isRelevant(item, label))
      .map((item) => item.filename),
  );
  return found.size / label.relevantDocuments.length;
}

export function hitAtK(ranked: RankedItem[], label: RelevanceLabel, k: number): number {
  return ranked.slice(0, k).some((item) => isRelevant(item, label)) ? 1 : 0;
}

/** Reciprocal rank of the first relevant chunk, 0 when none was retrieved. */
export function reciprocalRank(ranked: RankedItem[], label: RelevanceLabel): number {
  const index = ranked.findIndex((item) => isRelevant(item, label));
  return index < 0 ? 0 : 1 / (index + 1);
}

export interface AnswerObservation {
  abstained: boolean;
  answer: string;
  /** Filenames the surviving citations point at. */
  citedDocuments: string[];
  /** Citations whose chunk no longer resolves in the corpus. */
  unresolvedCitations: number;
  totalCitations: number;
}

export interface AnswerScores {
  /** 1 when the system did the right thing about answering at all. */
  abstentionCorrect: number;
  /** Fraction of citations pointing at a labelled-relevant document. */
  citationPrecision: number;
  /** 1 when every citation resolves to a chunk that still exists. */
  citationsResolve: number;
  /** Fraction of the expected substrings present in the answer. */
  answerContains: number;
}

/**
 * Scores one answer against its label.
 *
 * An abstention on an answerable question scores zero on the citation metrics
 * rather than a vacuous one: refusing to answer is not a way to achieve perfect
 * precision. On an unanswerable question the citation metrics are not
 * meaningful at all, so abstaining scores 1 and the rest are held at 1 so they
 * do not drag the mean down for behaving correctly.
 */
export function scoreAnswer(
  observation: AnswerObservation,
  label: { relevantDocuments: string[]; expectAnswerContains: string[]; unanswerable: boolean },
): AnswerScores {
  const abstentionCorrect = label.unanswerable === observation.abstained ? 1 : 0;

  if (label.unanswerable) {
    return {
      abstentionCorrect,
      citationPrecision: observation.abstained ? 1 : 0,
      citationsResolve: observation.unresolvedCitations === 0 ? 1 : 0,
      answerContains: 1,
    };
  }

  if (observation.abstained) {
    return { abstentionCorrect, citationPrecision: 0, citationsResolve: 1, answerContains: 0 };
  }

  const cited = observation.citedDocuments;
  const citationPrecision =
    cited.length === 0
      ? 0
      : cited.filter((filename) => label.relevantDocuments.includes(filename)).length / cited.length;

  const haystack = observation.answer.toLowerCase();
  const expectations = label.expectAnswerContains;
  const answerContains =
    expectations.length === 0
      ? 1
      : expectations.filter((needle) => haystack.includes(needle.toLowerCase())).length /
        expectations.length;

  return {
    abstentionCorrect,
    citationPrecision,
    citationsResolve: observation.unresolvedCitations === 0 ? 1 : 0,
    answerContains,
  };
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * The two error rates the abstention sweep is about, kept separate because they
 * trade against each other: a threshold that eliminates false answers by
 * refusing everything is not an improvement.
 */
export function abstentionRates(
  outcomes: Array<{ unanswerable: boolean; abstained: boolean }>,
): { falseAnswerRate: number; overAbstentionRate: number } {
  const unanswerable = outcomes.filter((outcome) => outcome.unanswerable);
  const answerable = outcomes.filter((outcome) => !outcome.unanswerable);

  return {
    falseAnswerRate:
      unanswerable.length === 0
        ? 0
        : unanswerable.filter((outcome) => !outcome.abstained).length / unanswerable.length,
    overAbstentionRate:
      answerable.length === 0
        ? 0
        : answerable.filter((outcome) => outcome.abstained).length / answerable.length,
  };
}
