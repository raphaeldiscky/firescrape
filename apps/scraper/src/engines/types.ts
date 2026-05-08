import type { ScrapeRequest } from "../client.js";
import type { ScrapeResponseData } from "../formats/types.js";

export type EngineName = "api" | "cdp";

export interface Engine {
  readonly name: EngineName;
  scrape(req: ScrapeRequest): Promise<ScrapeResponseData>;
  close?(): Promise<void>;
}
