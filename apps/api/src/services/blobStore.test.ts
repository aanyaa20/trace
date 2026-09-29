import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { env } from '../env.js';
import { derivedDir, remotePath } from './blobStore.js';

// A file's path in the storage dataset is its path under UPLOAD_DIR, so it
// comes back to exactly where the ml service and the previews look for it.
test('files under the upload directory map to the same relative path', () => {
  const file = path.join(env.UPLOAD_DIR, 'kb-1', 'doc-1-invoice.pdf');
  assert.equal(remotePath(file), 'kb-1/doc-1-invoice.pdf');
  assert.equal(remotePath(path.join(derivedDir('doc-1'), 'page-0001.png')), 'derived/doc-1/page-0001.png');
});

test('nothing outside the upload directory is ever stored', () => {
  assert.equal(remotePath('/etc/passwd'), null);
  assert.equal(remotePath(path.join(env.UPLOAD_DIR, '..', 'secret')), null);
  assert.equal(remotePath(env.UPLOAD_DIR), null);
});
