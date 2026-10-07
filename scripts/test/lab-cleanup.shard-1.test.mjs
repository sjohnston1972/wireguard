// One shard of lab-cleanup.cases.mjs: node --test runs the shards in parallel (fixtures/shard.mjs).
import { runShard } from "./fixtures/shard.mjs";

await runShard(import.meta.url);
