/**
 * The slice of WebMCP the app uses: `document.modelContext.registerTool()` and the tool it takes.
 * Written here rather than taken from `webmcp-types`, which lags a spec that moved monthly through
 * 2026 (docs/knowledge/webmcp.md). Only what `AgentTools` calls is declared; the testing surface
 * (`getTools`, `executeTool`) is faked in tests and not typed.
 *
 * `execute`'s second argument is absent before Chrome 153 and `{}` in ChatGPT's browser (both
 * measured), so it is optional and nothing in it is required. The input is whatever the agent sent;
 * the browser validates nothing against `inputSchema`.
 */
type ModelContextToolAnnotations = {
  readonly readOnlyHint?: boolean;
  readonly untrustedContentHint?: boolean;
  /** Chrome 154+; older builds ignore an unknown dictionary member. */
  readonly consequentialHint?: boolean;
};

type ModelContextTool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: ModelContextToolAnnotations;
  readonly execute: (
    input: unknown,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<unknown>;
};

type ModelContext = {
  registerTool: (tool: ModelContextTool, options?: { signal?: AbortSignal }) => Promise<undefined>;
};

interface Document {
  readonly modelContext?: ModelContext;
}
