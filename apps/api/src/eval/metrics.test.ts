import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  abstentionRates,
  hitAtK,
  isRelevant,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  scoreAnswer,
} from './metrics.js';

const ranked = [
  { filename: 'handbook.pdf', page: 1 },
  { filename: 'lecture.mp4', page: null },
  { filename: 'handbook.pdf', page: 2 },
  { filename: 'protocol.txt', page: null },
];

test('page labels narrow relevance within a labelled document', () => {
  const label = { relevantDocuments: ['handbook.pdf'], relevantPages: [2] };
  assert.equal(isRelevant({ filename: 'handbook.pdf', page: 2 }, label), true);
  assert.equal(isRelevant({ filename: 'handbook.pdf', page: 1 }, label), false);
  assert.equal(isRelevant({ filename: 'protocol.txt', page: null }, label), false);
});

test('precision counts relevant chunks among the top k', () => {
  const label = { relevantDocuments: ['handbook.pdf'], relevantPages: [] };
  assert.equal(precisionAtK(ranked, label, 4), 0.5);
  assert.equal(precisionAtK(ranked, label, 1), 1);
  assert.equal(precisionAtK([], label, 4), 0);
});

test('recall is over labelled documents, so two chunks of one document are not two hits', () => {
  const oneDocument = { relevantDocuments: ['handbook.pdf'], relevantPages: [] };
  assert.equal(recallAtK(ranked, oneDocument, 4), 1);

  const twoDocuments = { relevantDocuments: ['handbook.pdf', 'briefing.mp3'], relevantPages: [] };
  // handbook is found twice and briefing not at all: half, not one.
  assert.equal(recallAtK(ranked, twoDocuments, 4), 0.5);
});

test('reciprocal rank reports the first relevant position, or zero', () => {
  assert.equal(reciprocalRank(ranked, { relevantDocuments: ['lecture.mp4'], relevantPages: [] }), 0.5);
  assert.equal(reciprocalRank(ranked, { relevantDocuments: ['missing.pdf'], relevantPages: [] }), 0);
  assert.equal(hitAtK(ranked, { relevantDocuments: ['protocol.txt'], relevantPages: [] }, 3), 0);
});

test('abstaining on an answerable question does not earn citation precision', () => {
  const scores = scoreAnswer(
    {
      abstained: true,
      answer: '',
      citedDocuments: [],
      unresolvedCitations: 0,
      totalCitations: 0,
    },
    { relevantDocuments: ['handbook.pdf'], expectAnswerContains: [], unanswerable: false },
  );
  assert.equal(scores.abstentionCorrect, 0);
  assert.equal(scores.citationPrecision, 0);
  assert.equal(scores.answerContains, 0);
});

test('abstaining on an unanswerable question is fully correct', () => {
  const scores = scoreAnswer(
    { abstained: true, answer: '', citedDocuments: [], unresolvedCitations: 0, totalCitations: 0 },
    { relevantDocuments: [], expectAnswerContains: [], unanswerable: true },
  );
  assert.deepEqual(scores, {
    abstentionCorrect: 1,
    citationPrecision: 1,
    citationsResolve: 1,
    answerContains: 1,
  });
});

test('answering an unanswerable question is the failure that scores zero', () => {
  const scores = scoreAnswer(
    {
      abstained: false,
      answer: 'The deadline is Tuesday.',
      citedDocuments: ['handbook.pdf'],
      unresolvedCitations: 0,
      totalCitations: 1,
    },
    { relevantDocuments: [], expectAnswerContains: [], unanswerable: true },
  );
  assert.equal(scores.abstentionCorrect, 0);
  assert.equal(scores.citationPrecision, 0);
});

test('citation precision is the share of citations landing on labelled documents', () => {
  const scores = scoreAnswer(
    {
      abstained: false,
      answer: 'Chunks target eight hundred characters.',
      citedDocuments: ['handbook.pdf', 'lecture.mp4'],
      unresolvedCitations: 0,
      totalCitations: 2,
    },
    {
      relevantDocuments: ['handbook.pdf'],
      expectAnswerContains: ['eight hundred'],
      unanswerable: false,
    },
  );
  assert.equal(scores.citationPrecision, 0.5);
  assert.equal(scores.answerContains, 1);
  assert.equal(scores.citationsResolve, 1);
});

test('an unresolvable citation fails the resolve check', () => {
  const scores = scoreAnswer(
    {
      abstained: false,
      answer: 'text',
      citedDocuments: ['handbook.pdf'],
      unresolvedCitations: 1,
      totalCitations: 2,
    },
    { relevantDocuments: ['handbook.pdf'], expectAnswerContains: [], unanswerable: false },
  );
  assert.equal(scores.citationsResolve, 0);
});

test('the two error rates are measured over their own denominators', () => {
  const rates = abstentionRates([
    { unanswerable: true, abstained: false }, // a false answer
    { unanswerable: true, abstained: true },
    { unanswerable: false, abstained: true }, // over-abstention
    { unanswerable: false, abstained: false },
    { unanswerable: false, abstained: false },
  ]);
  assert.equal(rates.falseAnswerRate, 0.5);
  assert.equal(Number(rates.overAbstentionRate.toFixed(4)), 0.3333);
});

test('rates are zero rather than NaN when a class is absent', () => {
  const rates = abstentionRates([{ unanswerable: false, abstained: false }]);
  assert.equal(rates.falseAnswerRate, 0);
  assert.equal(rates.overAbstentionRate, 0);
});
