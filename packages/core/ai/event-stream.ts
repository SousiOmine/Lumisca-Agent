/**
 * A pushable async-iterable of assistant-message stream events, mirroring
 * the small event-stream contract the agent runtime and the tests use.
 * The agent runtime consumes the stream (for-await); tests push events
 * synchronously and end() the stream with the final AssistantMessage.
 */
import type { AssistantMessage, StreamEvent } from "./types.ts";

export type AssistantMessageEventStream = AsyncIterable<StreamEvent> & {
  push(event: StreamEvent): void;
  end(message?: AssistantMessage): void;
};

/** Create an empty pushable assistant-message event stream. */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  const queue: StreamEvent[] = [];
  const waiters: Array<(value: IteratorResult<StreamEvent>) => void> = [];
  let ended = false;

  const next = async (): Promise<IteratorResult<StreamEvent>> => {
    while (queue.length === 0) {
      if (ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => {
        waiters.push(() => resolve());
      });
    }
    return { done: false, value: queue.shift()! };
  };

  const iterator = {
    next,
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return {
    push(event: StreamEvent): void {
      queue.push(event);
      const waiter = waiters.shift();
      waiter?.({ done: false, value: event });
    },
    end(_message?: AssistantMessage): void {
      // The agent reads the final message from the `done` event; an empty
      // end() simply closes the stream (aux callers only need deltas).
      ended = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter({ done: true, value: undefined });
      }
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}
