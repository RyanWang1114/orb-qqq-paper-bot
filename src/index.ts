// CLI entrypoint: `npm run scan` | `npm run replay:raw` | `npm run replay:memory` | `npm run memory:reset`

import { scan } from "./bot.js";
import { replayRaw, replayMemory } from "./replay.js";
import { resetMemory } from "./memory.js";

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "scan":
      await scan();
      break;
    case "replay:raw":
      await replayRaw();
      break;
    case "replay:memory":
      await replayMemory();
      break;
    case "memory:reset":
      resetMemory();
      console.log("Memory reset: data/ledger.csv cleared to header-only, data/learnings.md removed.");
      break;
    default:
      console.log("Usage: npm run scan | npm run replay:raw | npm run replay:memory | npm run memory:reset");
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
