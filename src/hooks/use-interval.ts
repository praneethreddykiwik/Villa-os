import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `delay` milliseconds, starting immediately
 * on mount. Cleans up on unmount or when delay changes.
 *
 * Passing `null` as delay pauses the interval.
 */
export function useInterval(callback: () => void, delay: number | null) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    // Fire once immediately so the UI is fresh on mount without waiting for the first tick.
    savedCallback.current();
    const id = setInterval(() => savedCallback.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}
