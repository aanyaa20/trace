import { useState } from 'react';
import type { AgentEvent } from '@trace/contracts';

interface Verdict {
  grounded: number;
  discarded: number;
  rejectedMarkers: number[];
}

/**
 * The citations stage already reports which markers it threw away — see
 * resolveCitations in apps/api/src/agent/citations.ts, which strips any marker
 * pointing at a source it was never given and abstains when none survive. The
 * interface used to drop that number on the floor, which meant the one
 * guarantee this system actually enforces was invisible.
 *
 * A claim here is one citation marker. A sentence carrying two markers makes
 * two claims, because each one is separately verifiable.
 */
function verdictOf(events: AgentEvent[]): Verdict | null {
  let verdict: Verdict | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (payload?.stage !== 'citations') continue;
    verdict = {
      grounded: payload.citations.length,
      discarded: payload.rejectedMarkers.length,
      rejectedMarkers: payload.rejectedMarkers,
    };
  }
  return verdict;
}

export function Groundedness({
  events,
  abstained,
}: {
  events: AgentEvent[];
  abstained: boolean;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const verdict = verdictOf(events);
  if (!verdict) return null;

  const claims = verdict.grounded + verdict.discarded;
  const segments = [
    ...Array.from({ length: verdict.grounded }, () => 'moss' as const),
    ...Array.from({ length: verdict.discarded }, () => 'ochre' as const),
  ];

  return (
    <section className="animate-lift">
      <p className="font-mono text-[12px] tabular-nums text-ink-faint">
        <span className="text-ink">{claims}</span> claims
        <span className="mx-1.5">·</span>
        <span style={{ color: 'var(--moss)' }}>{verdict.grounded} grounded</span>
        <span className="mx-1.5">·</span>
        {verdict.discarded > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="underline decoration-dotted underline-offset-2"
            style={{ color: 'var(--ochre)' }}
            aria-expanded={open}
          >
            {verdict.discarded} discarded
          </button>
        ) : (
          <span>0 discarded</span>
        )}
      </p>

      {/* One segment per claim. A bar of proportions would hide that four
          grounded claims and one discarded is a different thing from eighty
          and twenty. */}
      {claims > 0 && (
        <div className="mt-2 flex h-[3px] gap-[3px]">
          {segments.map((tone, index) => (
            <span
              key={index}
              className="flex-1 rounded-[1px]"
              style={{
                backgroundColor: tone === 'moss' ? 'var(--moss)' : 'var(--ochre)',
                transition: `background-color var(--dur) var(--ease-out)`,
              }}
            />
          ))}
        </div>
      )}

      {open && verdict.discarded > 0 && (
        <div className="mt-3 rounded-sm bg-paper-sunk p-4 animate-lift">
          {verdict.rejectedMarkers.map((marker) => (
            <div key={marker} className="mb-3 last:mb-0">
              <p className="eyebrow" style={{ color: 'var(--ochre)' }}>
                discarded · marker ^{marker} did not resolve
              </p>

              {/*
                The stripped sentence itself is not available here. The resolver
                removes it server-side and the API sends only the marker number,
                so rendering the text would mean inventing it. The slot is left
                explicit rather than filled with a plausible sentence.
              */}
              <p
                className="mt-2 font-display text-[16px] leading-snug text-ink-muted underline decoration-dotted underline-offset-4"
                style={{ textDecorationColor: 'var(--ochre)' }}
              >
                (the text of this claim was removed before the answer was sent)
              </p>
            </div>
          ))}

          <p className="mt-3 text-[13px] leading-relaxed text-ink-muted">
            {verdict.discarded === 1 ? 'This claim was' : 'These claims were'} deleted from the
            answer because {verdict.discarded === 1 ? 'its citation' : 'their citations'} pointed at
            a source that was never retrieved. You are reading what survived verification.
          </p>
        </div>
      )}

      {abstained && (
        <p className="eyebrow mt-2" style={{ color: 'var(--ochre)' }}>
          abstained · the corpus does not support an answer
        </p>
      )}
    </section>
  );
}
