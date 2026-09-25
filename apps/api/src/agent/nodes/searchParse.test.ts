import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuckDuckGo } from './searchParse.js';

// Captured from the live endpoint. The attribute quoting here is the detail
// that broke the original parser: single quotes, href before class.
const SAMPLE = `
<table border="0">
  <tr>
    <td valign="top">1.&nbsp;</td>
    <td>
      <a rel="nofollow" href="https://example.org/chunking" class='result-link'>Advanced Chunking &amp; Retrieval ...</a>
    </td>
  </tr>
  <tr>
    <td>&nbsp;</td>
    <td class='result-snippet'>
      Chunking splits a document into <b>retrievable</b> passages before embedding.
    </td>
  </tr>
  <tr>
    <td>2.&nbsp;</td>
    <td><a rel="nofollow" href="https://example.net/rag" class='result-link'>RAG overview</a></td>
  </tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>A second snippet.</td></tr>
</table>`;

test('parses results despite single-quoted attributes and href before class', () => {
  const results = parseDuckDuckGo(SAMPLE);
  assert.equal(results.length, 2);
  assert.equal(results[0]!.url, 'https://example.org/chunking');
  assert.equal(results[0]!.title, 'Advanced Chunking & Retrieval ...');
  assert.match(results[0]!.snippet, /Chunking splits a document/);
  assert.ok(!results[0]!.snippet.includes('<b>'), 'tags are stripped from snippets');
  assert.equal(results[1]!.url, 'https://example.net/rag');
});

test('returns nothing for a page with no results rather than throwing', () => {
  assert.deepEqual(parseDuckDuckGo('<html><body>no results here</body></html>'), []);
});
