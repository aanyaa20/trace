import type {
  AgentEvent,
  AgentStage,
  AgentStatus,
  AgentTrace,
  RetrievalMode,
} from '@trace/contracts';
import type { z } from 'zod';
import { agentEventPayloadSchema } from '@trace/contracts';

type AgentEventPayload = z.infer<typeof agentEventPayloadSchema>;

export type AgentEventListener = (event: AgentEvent) => void;

/**
 * Append-only record of what the loop did, emitted as it happens rather than
 * assembled afterwards. The closest reference implementation fabricates its
 * trace after the answer is computed; the whole point of this class is that
 * a stage cannot report a duration it did not take.
 */
export class AgentEventBus {
  private readonly events: AgentEvent[] = [];
  private readonly listeners = new Set<AgentEventListener>();
  private readonly startedAt = Date.now();

  constructor(private readonly mode: RetrievalMode) {}

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: AgentEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  /** Opens a stage and returns the handles that close it. Holding the start
   *  time here is what makes durations real. */
  begin(stage: AgentStage, iteration: number): StageHandle {
    const startedAt = new Date();
    this.publish({
      stage,
      status: 'started',
      iteration,
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      durationMs: null,
      payload: null,
      error: null,
    });

    const finish = (status: AgentStatus, payload: AgentEventPayload | null, error: string | null): void => {
      const finishedAt = new Date();
      this.publish({
        stage,
        status,
        iteration,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        payload,
        error,
      });
    };

    return {
      complete: (payload: AgentEventPayload) => finish('completed', payload, null),
      fail: (error: string) => finish('failed', null, error),
    };
  }

  trace(iterations: number): AgentTrace {
    return {
      mode: this.mode,
      iterations,
      events: [...this.events],
      totalMs: Date.now() - this.startedAt,
    };
  }
}

export interface StageHandle {
  complete(payload: AgentEventPayload): void;
  fail(error: string): void;
}
