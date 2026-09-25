import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySmallTalk, smallTalkReply } from './smalltalk.js';

test('greetings are recognised however they are typed', () => {
  for (const input of ['hi', 'Hi!', 'hiii', 'hello', 'Hey there', 'good morning', 'yo']) {
    assert.equal(classifySmallTalk(input), 'greeting', input);
  }
});

test('the other conversational openings are recognised', () => {
  assert.equal(classifySmallTalk('how are you?'), 'how_are_you');
  assert.equal(classifySmallTalk('thanks!'), 'thanks');
  assert.equal(classifySmallTalk('bye'), 'farewell');
  assert.equal(classifySmallTalk('who are you'), 'identity');
  assert.equal(classifySmallTalk('what can you do?'), 'capability');
  assert.equal(classifySmallTalk("what's my name"), 'about_user');
});

test('asking how it is doing is recognised however it is spelled', () => {
  for (const input of ["what's up?", 'whats up', 'what sup', 'wassup', 'how are u', 'you good']) {
    assert.equal(classifySmallTalk(input), 'how_are_you', input);
  }
});

test('bare acknowledgements do not start a retrieval loop', () => {
  for (const input of ['oh', 'Oh.', 'ok', 'okay', 'hmm', 'right', 'cool', 'i see', 'got it', 'yeah']) {
    assert.equal(classifySmallTalk(input), 'acknowledgement', input);
  }
});

test('an acknowledgement that continues into a question is a question', () => {
  for (const input of [
    'right, what does the handbook say about chunking',
    'ok so how large are the chunks',
    'oh does the lecture mention that',
  ]) {
    assert.equal(classifySmallTalk(input), null, input);
  }
});

/**
 * The failure that matters. A classifier that swallowed a real question would
 * answer it without retrieving anything and without citing anything, which is
 * precisely the behaviour this system exists to prevent — and it would do it
 * silently, since the answer would still read fluently.
 */
test('real questions about the corpus are never treated as conversation', () => {
  const questions = [
    'What happens to a chunk that would span two pages?',
    'How large are chunks and how much do they overlap?',
    'Who is the invoice from and who is it addressed to?',
    'What did Priya say about the deadline?',
    'hello world in the handbook document',
    'What is this document about?',
    'help me find the payment terms in the invoice',
    'What are the stages of the trace pipeline in the architecture diagram?',
  ];

  for (const question of questions) {
    assert.equal(classifySmallTalk(question), null, question);
  }
});

test('a long message is not small talk even when it opens with a greeting', () => {
  assert.equal(
    classifySmallTalk('hi, can you tell me what the chunking policy says about page boundaries'),
    null,
  );
});

test('empty and whitespace input classify as nothing', () => {
  assert.equal(classifySmallTalk(''), null);
  assert.equal(classifySmallTalk('   '), null);
  assert.equal(classifySmallTalk('!!!'), null);
});

test('every kind has a reply, and none of them claims to have read anything', () => {
  const kinds = [
    'greeting',
    'how_are_you',
    'thanks',
    'farewell',
    'identity',
    'capability',
    'about_user',
  ] as const;

  for (const kind of kinds) {
    const reply = smallTalkReply(kind);
    assert.ok(reply.length > 0, kind);
    // A conversational reply carries no citation markers, because it makes no
    // claim drawn from a document.
    assert.doesNotMatch(reply, /\[\^?\d+\]/, kind);
  }
});

test('it does not pretend to know the reader', () => {
  assert.match(smallTalkReply('about_user'), /don't know anything about you/);
});
