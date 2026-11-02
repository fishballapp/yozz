import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { createApp } from '../src/app.ts';

/** Through the handler with the execution context a deployed Worker has, its `waitUntil` work done. */
export const settledRequest = async (
  url: string,
  init: RequestInit,
  bindings: typeof env = env,
): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await createApp().request(url, init, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};
