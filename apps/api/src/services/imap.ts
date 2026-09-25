import { lookup } from 'node:dns/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { env } from '../env.js';
import { badRequest, upstreamFailure } from '../errors.js';
import { isBlockedAddress } from './ipRules.js';

export interface MailboxConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
}

export interface FetchedMessage {
  uid: number;
  parsed: ParsedMail;
}

export interface FetchResult {
  /** The mailbox's UIDVALIDITY at the moment of this fetch, as a string. */
  uidValidity: string;
  messages: FetchedMessage[];
  /** Highest UID imported in this batch, or the caller's watermark if none. */
  lastUid: number;
  /** True when more messages were waiting than the batch allowed. */
  more: boolean;
}

/**
 * A mailbox host is user-supplied, so it gets the same treatment as a pasted
 * URL: resolve it and refuse anything that lands on a private range. Without
 * this, "connect a mailbox" is an open port scanner pointed at the internal
 * network.
 */
export async function assertMailboxHost(host: string): Promise<void> {
  if (env.ALLOW_PRIVATE_MAILBOX_HOSTS) return;

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw badRequest(`could not resolve mail host ${host}`);
  }

  if (addresses.length === 0) throw badRequest(`could not resolve mail host ${host}`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw badRequest(`mail host ${host} resolves to a blocked address`);
    }
  }
}

function connect(config: MailboxConfig): ImapFlow {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    // Gmail's IMAP endpoint is implicit TLS on 993. Plaintext is never offered.
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    emitLogs: false,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

/** Maps an IMAP failure to something a user can act on. */
function asUpstream(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(message)) {
    return badRequest(
      'the mailbox rejected those credentials. Gmail needs an app password, not the account password, and 2-Step Verification must be on.',
    );
  }
  if (/\[ALERT\].*IMAP.*disabled|IMAP access is disabled/i.test(message)) {
    return badRequest('IMAP is disabled on this account. Enable it in Gmail settings.');
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) {
    return badRequest(
      'that mail server could not be found. Check the host under server settings — Gmail is imap.gmail.com.',
    );
  }
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/i.test(message)) {
    return badRequest(
      'the mail server did not accept a connection. It may be blocking this network, or the host and port under server settings may be wrong.',
    );
  }
  if (/certificate|self.signed|DEPTH_ZERO/i.test(message)) {
    return badRequest(
      "the mail server's TLS certificate could not be verified, so the connection was refused rather than trusted blindly.",
    );
  }
  // imapflow reports a rejected login as a bare "Command failed" often enough
  // that letting it through unexplained is the most common dead end on this
  // form. It is nearly always the username: the address here is the mailbox
  // being read, not the account used to sign in to this app.
  if (/^command failed/i.test(message.trim())) {
    return badRequest(
      'the mail server rejected the login. Use the full address of the mailbox itself — you@gmail.com, not the address you sign in to trace with — and an app password created at myaccount.google.com/apppasswords, not your account password.',
    );
  }
  return upstreamFailure('imap', message);
}

/**
 * Connects, selects the mailbox and disconnects. Used before a connector row is
 * written, so a bad password fails at the point the user can still fix it
 * rather than silently inside a background job.
 */
export async function verifyMailbox(
  config: MailboxConfig,
): Promise<{ uidValidity: string; exists: number }> {
  await assertMailboxHost(config.host);
  const client = connect(config);

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      const box = client.mailbox;
      if (!box) throw upstreamFailure('imap', `mailbox ${config.mailbox} could not be opened`);
      return { uidValidity: String(box.uidValidity), exists: box.exists };
    } finally {
      lock.release();
    }
  } catch (cause) {
    throw asUpstream(cause);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/**
 * Fetches the next batch above the watermark.
 *
 * UIDs are only meaningful while UIDVALIDITY holds. When the server changes it,
 * every stored UID is void — not stale, meaningless — so the cursor restarts
 * from the date window instead of resuming at a number that now refers to some
 * other message. Dedup by Message-ID is what keeps that restart from importing
 * the mailbox twice.
 */
export async function fetchSince(
  config: MailboxConfig,
  cursor: { uidValidity: string | null; lastUid: number; sinceDays: number },
): Promise<FetchResult> {
  await assertMailboxHost(config.host);
  const client = connect(config);

  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.mailbox);

    try {
      const box = client.mailbox;
      if (!box) throw upstreamFailure('imap', `mailbox ${config.mailbox} could not be opened`);

      const uidValidity = String(box.uidValidity);
      const resumable = cursor.uidValidity === uidValidity && cursor.lastUid > 0;

      const since = new Date(Date.now() - cursor.sinceDays * 24 * 60 * 60 * 1000);
      const found = resumable
        ? await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true })
        : await client.search({ since }, { uid: true });

      // `n:*` always returns at least the highest UID even when nothing is
      // above the watermark, so anything at or below it is dropped here.
      const pending = (found || [])
        .filter((uid) => !resumable || uid > cursor.lastUid)
        .sort((a, b) => a - b);

      const batch = pending.slice(0, env.MAILBOX_BATCH_SIZE);
      if (batch.length === 0) {
        return { uidValidity, messages: [], lastUid: cursor.lastUid, more: false };
      }

      // Ascending, so the watermark only ever moves forward: a batch that dies
      // halfway leaves a cursor that resumes rather than one that skips.
      const messages: FetchedMessage[] = [];
      for await (const message of client.fetch(
        batch.join(','),
        { uid: true, source: true },
        { uid: true },
      )) {
        if (!message.source) continue;
        messages.push({ uid: message.uid, parsed: await simpleParser(message.source) });
      }

      messages.sort((a, b) => a.uid - b.uid);

      return {
        uidValidity,
        messages,
        lastUid: messages.length > 0 ? messages[messages.length - 1]!.uid : cursor.lastUid,
        more: pending.length > batch.length,
      };
    } finally {
      lock.release();
    }
  } catch (cause) {
    throw asUpstream(cause);
  } finally {
    await client.logout().catch(() => undefined);
  }
}
