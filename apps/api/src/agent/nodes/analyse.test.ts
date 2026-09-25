import test from 'node:test';
import assert from 'node:assert/strict';
import type { QueryAnalysis } from '@trace/contracts';
import { searchQuery } from './analyse.js';
import { initialState, type AgentState } from '../state.js';

function state(query: string, analysis: QueryAnalysis | null = null): AgentState {
  return { ...initialState({ kbId: KB, userQuery: query, mode: 'agentic' }), analysis };
}

const KB = '00000000-0000-4000-8000-000000000000';

const ANALYSIS = (standaloneQuery?: string): QueryAnalysis => ({
  intent: 'find the thing',
  modalityHints: [],
  rewrites: ['a rewrite'],
  reasoning: 'because',
  ...(standaloneQuery === undefined ? {} : { standaloneQuery }),
});

test('falls back to the user wording when analysis failed', () => {
  assert.equal(searchQuery(state('what about the second one?')), 'what about the second one?');
});

test('falls back to the user wording on a first turn, where nothing is resolved', () => {
  assert.equal(searchQuery(state('how does chunking work?', ANALYSIS())), 'how does chunking work?');
});

test('prefers the resolved question on a follow-up', () => {
  const resolved = searchQuery(
    state('and the second one?', ANALYSIS('what does the second chunking rule do?')),
  );
  assert.equal(resolved, 'what does the second chunking rule do?');
});

// A model that answers the field but has nothing to say still returns a
// string. Retrieving on empty would return the corpus in arbitrary order,
// which reads as a retrieval bug rather than a analysis one.
test('ignores an empty or whitespace resolution', () => {
  assert.equal(searchQuery(state('why?', ANALYSIS(''))), 'why?');
  assert.equal(searchQuery(state('why?', ANALYSIS('   '))), 'why?');
});

test('trims a resolution rather than passing padding to the retriever', () => {
  assert.equal(searchQuery(state('why?', ANALYSIS('  what is the OCR threshold  '))), 'what is the OCR threshold');
});

test('an explicit analysis argument overrides the one on the state', () => {
  const current = state('and the second?', ANALYSIS('resolved from state'));
  assert.equal(searchQuery(current, ANALYSIS('resolved from argument')), 'resolved from argument');
});

test('history is carried on the state but never reaches the evidence path', () => {
  const withHistory = initialState({
    kbId: KB,
    userQuery: 'and the second one?',
    mode: 'agentic',
    history: [
      { role: 'user', content: 'what are the chunking rules?' },
      { role: 'assistant', content: 'Pages never merge [^1]. Transcript segments always merge [^2].' },
    ],
  });

  assert.equal(withHistory.history.length, 2);
  // The synthesiser cites from relevant and external only. If history ever
  // leaks into either, an earlier answer becomes a source for the next one.
  assert.deepEqual(withHistory.relevant, []);
  assert.deepEqual(withHistory.external, []);
});
