import { compileAnchors, ROOT_BUNDLE, type TrustAnchorSource } from '@yozz.app/x509';

let cachedAnchors: TrustAnchorSource | null = null;

/** Memoised at module level; a failed compile is not cached. */
export const trustAnchors = async (): Promise<TrustAnchorSource> => {
  if (cachedAnchors !== null) {
    return cachedAnchors;
  }

  // ponytail: 121 roots parsed synchronously on the main thread, once per page load, inside the
  // first sync. It is the pause between Connect and the first WebSocket. Upgrade: a Worker.
  const source = compileAnchors(ROOT_BUNDLE).source;
  cachedAnchors = source;
  return source;
};
