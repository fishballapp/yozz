/**
 * The slice of WebMCP the app uses, written here because `webmcp-types` lags the spec
 * (docs/knowledge/webmcp.md). `execute`'s second argument is absent before Chrome 153 and `{}`
 * in ChatGPT's browser; the browser validates nothing against `inputSchema`.
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
