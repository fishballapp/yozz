import { compileAnchors, ROOT_BUNDLE, type TrustAnchorSource } from '@yozz.app/x509';

let cachedAnchors: TrustAnchorSource | null = null;

/**
 * Compiles the root CA trust anchors lazily off the critical path.
 *
 * Memoised at module level so it runs once across connections. A failed compile
 * is not cached and will be retried on the next call.
 */
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
