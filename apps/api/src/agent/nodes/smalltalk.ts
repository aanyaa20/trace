/**
 * The conversational path.
 *
 * "hi" is not a question about the corpus, and answering it with "the
 * documents do not contain enough evidence" is technically true and completely
 * wrong: it reads as a broken system to anyone who has just arrived. These
 * openings are answered directly, without retrieval and without citations,
 * because there is no claim in them to ground.
 *
 * The grounding guarantee is untouched. A reply here asserts nothing about
 * what is in the corpus, so there is nothing to cite; anything that does make
 * a claim about the documents goes through the loop like everything else.
 *
 * Deterministic on purpose: a model call to classify "hi" would spend quota on
 * the cheapest question in the system, and a threshold that drifts would start
 * swallowing real questions. This module imports nothing, so its tests need no
 * environment — the same rule as ipRules.ts and metrics.ts.
 */

export type SmallTalkKind =
  | 'greeting'
  | 'how_are_you'
  | 'thanks'
  | 'farewell'
  | 'identity'
  | 'capability'
  | 'about_user'
  | 'acknowledgement';

/** Small talk is short. A long message containing "hi" is not a greeting, and
 *  this bound is what stops the classifier reaching into real questions. */
const MAX_WORDS = 7;

const PATTERNS: Array<{ kind: SmallTalkKind; test: RegExp }> = [
  {
    kind: 'how_are_you',
    // "what's up" and its spellings sit here rather than under greeting: the
    // reply that fits is the one about how the system is doing, not a second
    // hello. Apostrophes survive normalisation, so both forms are listed.
    test: /^(how (are|r) (you|u)|how'?s it going|how are things|you good|hows you|what'?s up|what ?sup|whats up|wassup|wazzup|sup man|how you doing|how r u doing)\b/,
  },
  {
    kind: 'greeting',
    test: /^(hi|hii+|hey+|hello+|yo|hiya|howdy|sup|namaste|good (morning|afternoon|evening|day))\b/,
  },
  { kind: 'thanks', test: /^(thanks|thank you|thankyou|ty|cheers|appreciate it|nice one)\b/ },
  { kind: 'farewell', test: /^(bye+|goodbye|see ya|see you|good ?night|later)\b/ },
  {
    kind: 'identity',
    test: /^(who are you|what are you|whats your name|what is your name|your name|are you (a )?(bot|human|ai|robot))\b/,
  },
  {
    kind: 'capability',
    test: /^(what can you do|what do you do|how do you work|what is this|whats this|how does this work|what can i ask|help( me)?)\b/,
  },
  { kind: 'about_user', test: /^(what('| i)?s my name|who am i|do you know me|my name)\b/ },
  /**
   * A bare acknowledgement. "oh" is not a question, and running the whole
   * retrieval loop over it spends fifteen seconds to conclude that the corpus
   * cannot answer something nobody asked.
   *
   * Anchored at both ends, unlike the patterns above: "right" on its own is an
   * acknowledgement, but "right, what does the handbook say" is a question,
   * and a prefix match would swallow it. Nothing here may match a message that
   * continues into one.
   */
  {
    kind: 'acknowledgement',
    test: /^(oh+|ah+|ok|okay|kk?|hm+|mhm|i see|got it|gotcha|right|cool|nice|great|awesome|alright|sure|fine|yeah|yep|yup|yes|lol|ha(ha)+|wow|oh ok(ay)?|ah ok(ay)?|oh i see|makes sense|fair enough)$/,
  },
];

/**
 * Strips the punctuation and repetition that a typed greeting arrives with,
 * so "Hiii!!" and "hi" classify the same.
 */
function normalise(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifySmallTalk(query: string): SmallTalkKind | null {
  const text = normalise(query);
  if (text.length === 0) return null;

  const words = text.split(' ');
  if (words.length > MAX_WORDS) return null;

  // A question mark on a short phrase is usually still small talk ("who are
  // you?"), but a phrase that names a document or a page is asking about the
  // corpus and must not be short-circuited.
  if (/\b(page|document|pdf|file|chunk|citation|invoice|corpus|mailbox|email)\b/.test(text)) {
    return null;
  }

  for (const { kind, test } of PATTERNS) {
    if (test.test(text)) return kind;
  }
  return null;
}

/**
 * Vera's own words. Each one answers the thing asked and then points at the
 * job, because the reason someone is typing into this box is the corpus.
 */
export function smallTalkReply(kind: SmallTalkKind): string {
  switch (kind) {
    case 'greeting':
      return "Hello. I'm Vera — ask me anything about the documents in this knowledge base and I'll answer with a citation on every claim, or tell you plainly when the corpus cannot support an answer.";
    case 'how_are_you':
      return "Working, thank you. Ask me something about your documents — I'll point at the page, span or timestamp each part of the answer came from.";
    case 'thanks':
      return "You're welcome. Ask me anything else about this corpus whenever you like.";
    case 'farewell':
      return 'Goodbye. This thread is saved, so you can pick it up where you left off.';
    case 'identity':
      return "I'm Vera, the assistant for this knowledge base. I read only the documents you have put here — the PDFs, scans, recordings, images and mail — and every sentence I write carries a number that opens the exact place it came from.";
    case 'capability':
      return 'Ask me a question about anything in this corpus. I search your documents, weigh what comes back, and answer only from passages I can cite — a page and character span for a document, a timestamp for a recording, the image itself for a figure. When nothing in your documents supports an answer, I say so instead of guessing.';
    case 'acknowledgement':
      // Short, because the message it answers was. Anything longer reads as
      // filling a silence that did not need filling.
      return "Ask me anything about this corpus whenever you're ready.";
    case 'about_user':
      // Honest rather than friendly: it knows the corpus, not the reader.
      return "I don't know anything about you — I only read the documents in this knowledge base, and I have no profile of who is asking. If your name appears in one of those documents, ask me and I'll cite where.";
  }
}
