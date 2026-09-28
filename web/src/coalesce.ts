/**
 * Runs `load` as often as a burst of callers needs, and no more. A call made
 * while a run is under way is folded into one more run after it, and every
 * caller's promise settles once data at least as new as their call is in.
 *
 * The app refetches its state on every gateway event, and events come in
 * bursts: a busy task, or a reconnect catching up. One fetch per event was
 * enough to trip the gateway's rate limit and refuse the owner's next action.
 */
export function coalesce(load: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null, again = false;
  return () => {
    if (running) {again = true; return running;}
    running = (async () => {
      try {do {again = false; await load();} while (again);}
      finally {running = null;}
    })();
    return running;
  };
}
