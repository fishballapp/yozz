import { createApp } from './app.ts';
import type { RuntimeEnv } from './env.ts';

const app = createApp();

export default {
  fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<RuntimeEnv>;
