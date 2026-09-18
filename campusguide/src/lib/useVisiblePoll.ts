import * as React from "react";

/**
 * Poll `load` on an interval, but only while the tab is actually on screen.
 *
 * The admin dashboards refresh every 20-60 seconds so an incident shows up
 * without a manual reload. Left running in a background tab that nobody is
 * looking at, that is thousands of requests a day for a screen that is not
 * being read — so the timer stops on hide and the data is refreshed once on
 * return, which is what an admin coming back to the tab actually wants.
 *
 * `load` receives an AbortSignal that fires on unmount (and whenever `load`
 * itself changes), so an in-flight request is dropped rather than left to
 * resolve against a gone component. Callers must ignore AbortError: an aborted
 * poll is expected, not a failure worth showing.
 */
export function useVisiblePoll(
  load: (signal: AbortSignal) => void | Promise<void>,
  intervalMs: number
) {
  React.useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;

    const tick = () => {
      if (controller.signal.aborted) return;
      void load(controller.signal);
    };

    const start = () => {
      if (timer === undefined) timer = window.setInterval(tick, intervalMs);
    };

    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Catch up on whatever changed while the tab was hidden, then resume.
        tick();
        start();
      } else {
        stop();
      }
    };

    // The first load runs even on a hidden tab: the component has just mounted
    // and has nothing to render otherwise.
    tick();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      controller.abort();
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load, intervalMs]);
}

/**
 * True when a rejection is this hook aborting an in-flight poll.
 *
 * Browsers reject an aborted fetch with a DOMException, but the name check is
 * what actually matters and it also holds for the plain Error some runtimes
 * throw - so match on the name rather than the class.
 */
export function isAbortError(err: unknown) {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}
