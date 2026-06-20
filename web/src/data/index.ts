// web/src/data/index.ts
// Single entry point the app uses to obtain its injected MarketDataSource.
//
//   createDataSource('mock')  → the self-driving MockDataSource (default).
//   createDataSource('ws')    → WsDataSource from ./ws (Agent B). The import is a
//                               GUARDED lazy import so the build NEVER breaks if
//                               web/src/data/ws.ts does not exist yet; on any
//                               failure we transparently fall back to mock.

import { MockDataSource } from "./mock";
import type { MarketDataSource } from "./types";

export type DataSourceKind = "mock" | "ws";

export async function createDataSource(
  kind: DataSourceKind = "mock",
): Promise<MarketDataSource> {
  if (kind === "ws") {
    try {
      // @vite-ignore — ws.ts is owned by Agent B and may not exist yet.
      const mod: any = await import(/* @vite-ignore */ "./ws");
      const Ctor =
        mod?.WsDataSource ?? mod?.default ?? mod?.createWsDataSource ?? null;
      if (Ctor) {
        const url =
          (import.meta.env?.VITE_WS_URL as string | undefined) ??
          "ws://127.0.0.1:8787";
        const src: MarketDataSource =
          typeof Ctor === "function" && Ctor.prototype?.connect
            ? new Ctor(url)
            : Ctor(url);
        return src;
      }
      // module present but no recognizable export — fall through to mock.
      console.warn("[gix] ws data module has no WsDataSource export; using mock.");
    } catch (err) {
      console.warn(
        "[gix] ws data source unavailable (ws.ts not present yet?), falling back to mock.",
        err,
      );
    }
  }
  return new MockDataSource();
}

export { MockDataSource };
export * from "./types";
