import { encode } from "gpt-tokenizer/encoding/o200k_base";
import type { TokenizerProvenance } from "./static-burden.js";

export const o200kEstimate: TokenizerProvenance = {
  name: "o200k_base",
  provenance:
    "gpt-tokenizer o200k_base estimate; not the active model tokenizer",
  accuracy: "estimate",
  count: (text) => encode(text).length,
};
