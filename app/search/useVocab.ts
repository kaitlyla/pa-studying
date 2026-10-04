import { useEffect, useState } from "react";
import type { Vocab } from "../../lib/search/index.ts";
import { searchClient } from "./client.ts";

/** The abbreviation vocabulary once loaded (null until then, or while `enabled` is false). */
export function useVocab(enabled: boolean): Vocab | null {
  const [vocab, setVocab] = useState<Vocab | null>(null);
  useEffect(() => {
    if (!enabled || vocab) return;
    let live = true;
    searchClient()
      .vocab()
      .then(
        (v) => {
          if (live) setVocab(v);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [enabled, vocab]);
  return enabled ? vocab : null;
}
