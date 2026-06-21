/**
 * Ollama HTTP client — real inference on the GB10.
 *
 * Talks to Ollama's native HTTP API at GIX_OLLAMA_URL (default
 * http://127.0.0.1:11434). We use /api/generate (non-streaming) which returns the
 * full completion plus token accounting (`eval_count` = output tokens), so the node
 * can fill `output_token_count` for the §2 message without re-tokenizing.
 *
 * All failure modes (Ollama down, model missing) raise clear errors so the serve
 * loop can surface them instead of submitting a bogus attestation.
 */

export interface OllamaGenerateResult {
  /** The model's completion text. */
  completion: string;
  /** Ollama's eval_count = number of tokens generated in the response. */
  outputTokenCount: number;
  /** Number of prompt tokens (prompt_eval_count), for diagnostics. */
  promptTokenCount: number;
  /** Wall-clock start (ms since epoch) captured by the node around the call. */
  tStart: number;
  /** Wall-clock end (ms since epoch). */
  tEnd: number;
}

export class OllamaError extends Error {}

export class OllamaClient {
  /**
   * @param maxTokens generation cap sent to Ollama as `num_predict`. When > 0 the
   *   `options.num_predict` field is included so the model stops early (bounds
   *   latency / keeps inside the SLA). <= 0 means "uncapped" — the field is omitted.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly maxTokens = 0,
  ) {}

  /** GET /api/tags — also our reachability probe. Throws OllamaError if unreachable. */
  async listModels(): Promise<string[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/tags`);
    } catch (e) {
      throw new OllamaError(
        `Ollama is not reachable at ${this.baseUrl} (${(e as Error).message}). ` +
          `Start it with \`ollama serve\` and set GIX_OLLAMA_URL.`,
      );
    }
    if (!res.ok) throw new OllamaError(`Ollama /api/tags returned ${res.status}`);
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name);
  }

  /** True if `this.model` (or its untagged form) is present locally. */
  async hasModel(): Promise<boolean> {
    const tags = await this.listModels();
    return tags.some((t) => t === this.model || t.split(":")[0] === this.model.split(":")[0]);
  }

  /**
   * Ensure the model is present, pulling it via POST /api/pull if not. The pull can
   * be large; we stream the progress lines and resolve when done. Returns true if a
   * pull happened, false if it was already present.
   */
  async ensureModel(onProgress?: (status: string) => void): Promise<boolean> {
    if (await this.hasModel()) return false;
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new OllamaError(`Ollama /api/pull returned ${res.status} for ${this.model}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { status?: string; error?: string };
          if (obj.error) throw new OllamaError(`Ollama pull error: ${obj.error}`);
          if (obj.status && onProgress) onProgress(obj.status);
        } catch (e) {
          if (e instanceof OllamaError) throw e;
          // ignore non-JSON keepalive lines
        }
      }
    }
    return true;
  }

  /**
   * Run a non-streaming completion. Captures t_start/t_end (ms) around the call and
   * reads eval_count for output_token_count.
   */
  async generate(prompt: string): Promise<OllamaGenerateResult> {
    const tStart = Date.now();
    // Bound the generation length via Ollama's `num_predict` option so qwen answers
    // stay short (faster inference, comfortably inside the SLA). Only sent when a
    // positive cap is configured; <= 0 leaves Ollama uncapped (its own default).
    const options = this.maxTokens > 0 ? { num_predict: this.maxTokens } : undefined;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // think:false disables qwen3.x's hidden reasoning phase, so `.response` is the
        // direct answer. (With thinking on, a num_predict cap is spent "thinking" and
        // `.response` comes back empty — the reasoning-model gotcha.)
        body: JSON.stringify({ model: this.model, prompt, stream: false, think: false, options }),
      });
    } catch (e) {
      throw new OllamaError(
        `Ollama generate failed to connect at ${this.baseUrl} (${(e as Error).message})`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OllamaError(
        `Ollama /api/generate returned ${res.status} for model ${this.model}: ${text}`,
      );
    }
    const body = (await res.json()) as {
      response?: string;
      eval_count?: number;
      prompt_eval_count?: number;
      done?: boolean;
    };
    const tEnd = Date.now();
    const completion = body.response ?? "";
    if (completion.length === 0) {
      throw new OllamaError(`Ollama returned an empty completion for model ${this.model}`);
    }
    return {
      completion,
      outputTokenCount: body.eval_count ?? 0,
      promptTokenCount: body.prompt_eval_count ?? 0,
      tStart,
      tEnd,
    };
  }
}
