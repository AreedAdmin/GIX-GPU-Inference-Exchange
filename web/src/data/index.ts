// web/src/data/index.ts
// Single entry point the app uses to obtain its injected MarketDataSource.
//
//   createDataSource('mock')     → the self-driving MockDataSource (default).
//   createDataSource('ws')       → WsDataSource from ./ws (Agent B). The import is
//                                  a GUARDED lazy import so the build NEVER breaks
//                                  if web/src/data/ws.ts is absent; on any failure
//                                  we transparently fall back to mock.
//   createDataSource('deepbook') → DeepBookDataSource from ./deepbook (M2): a REAL
//                                  DeepBook order book (live bids/asks/depth +
//                                  indexer trades). Same guarded-lazy-import shape;
//                                  the source ITSELF degrades to an internal mock
//                                  when the pool/indexer is unavailable, so the UI
//                                  is never blank.

import { MockDataSource } from "./mock";
import type { MarketDataSource } from "./types";

export type DataSourceKind = "mock" | "ws" | "deepbook";

export async function createDataSource(
  kind: DataSourceKind = "mock",
): Promise<MarketDataSource> {
  if (kind === "deepbook") {
    try {
      const mod: any = await import(/* @vite-ignore */ "./deepbook");
      const Ctor =
        mod?.DeepBookDataSource ?? mod?.default ?? mod?.createDeepBookDataSource ?? null;
      if (Ctor) {
        const src: MarketDataSource =
          typeof Ctor === "function" && Ctor.prototype?.connect ? new Ctor() : Ctor();
        return src;
      }
      console.warn("[gix] deepbook data module has no DeepBookDataSource export; using mock.");
    } catch (err) {
      console.warn(
        "[gix] deepbook data source unavailable, falling back to mock.",
        err,
      );
    }
  }
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
