import type { Citation } from '@trace/contracts';
import { AgentTimeline } from './AgentTimeline.js';
import { Answer } from './Answer.js';
import { CitationsPanel } from './CitationsPanel.js';
import { Groundedness } from './Groundedness.js';
import type { AnswerState } from '../lib/useAnswer.js';

function Column({
  label,
  detail,
  state,
  onSelectCitation,
  selected,
}: {
  label: string;
  detail: string;
  state: AnswerState;
  onSelectCitation: (citation: Citation) => void;
  selected: string | null;
}): React.ReactElement {
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-y-auto scroll-slim">
      <header className="sticky top-0 z-10 rule-hair bg-paper px-4 py-2.5">
        <h3 className="text-[13px] font-medium text-ink">{label}</h3>
        <p className="mono-meta">{detail}</p>
      </header>

      <div className="space-y-5 px-4 py-4">
        <Groundedness events={state.events} abstained={state.abstained} />
        <Answer state={state} onSelectCitation={onSelectCitation} />

        {state.citations.length > 0 && (
          <div>
            
            <CitationsPanel
              citations={state.citations}
              onSelect={onSelectCitation}
              selected={selected}
            />
          </div>
        )}

        <div>
          <h4 className="eyebrow mb-1">trace</h4>
          <AgentTimeline events={state.events} />
        </div>
      </div>
    </section>
  );
}

/**
 * The evaluation chapter is agentic against naive, so the interface runs both
 * on the same question. Sharing the synthesis prompt and the citation resolver
 * means the difference on screen is the retrieval strategy and nothing else.
 */
export function Compare({
  agentic,
  naive,
  ran,
  onSelectCitation,
  selected,
}: {
  agentic: AnswerState;
  naive: AnswerState;
  /**
   * Whether the two states on screen came from a compare run. Without it the
   * view showed whatever the last single-mode answer happened to be, sitting
   * under the "agentic" heading — so a naive answer was labelled agentic and
   * the other column stood empty, which reads as a comparison rather than as
   * nothing having been compared.
   */
  ran: boolean;
  onSelectCitation: (citation: Citation) => void;
  selected: string | null;
}): React.ReactElement {
  if (!ran) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8">
        <div className="measure text-center">
          <p className="text-[14px] text-ink">Ask a question to compare the two strategies.</p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
            The same question runs twice over this corpus — once through the full agentic loop,
            once through a single-pass baseline — sharing the synthesis prompt and the citation
            resolver, so what differs below is the retrieval strategy and nothing else.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 divide-x divide-rule">
      <Column
        label="agentic"
        detail="analyse · grade · re-retrieve · fall back · abstain"
        state={agentic}
        onSelectCitation={onSelectCitation}
        selected={selected}
      />
      <Column
        label="naive"
        detail="one retrieval · same synthesis prompt"
        state={naive}
        onSelectCitation={onSelectCitation}
        selected={selected}
      />
    </div>
  );
}
