import { describe, expect, it } from "vitest";
import { LIVE_LOG_STALL_MS, streamState } from "./liveStream";

describe("streamState: the word beside a live log", () => {
  const now = Date.parse("2026-10-03T09:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const live = (updatedAt: string | null) => ({ log: "x", source: "live" as const, active: true, updatedAt });

  it("Streaming while new lines keep arriving; Stalled once nothing new has come for over 30 s", () => {
    expect(LIVE_LOG_STALL_MS).toBe(30_000);
    expect(streamState(true, live(ago(1_000)), now)).toBe("Streaming");
    expect(streamState(true, live(ago(30_000)), now)).toBe("Streaming");
    expect(streamState(true, live(ago(30_001)), now)).toBe("Stalled");
    expect(streamState(true, live(ago(10 * 60_000)), now)).toBe("Stalled");
  });

  it("before the first lines (no updatedAt yet) it is still Streaming, which shows the waiting note", () => {
    expect(streamState(true, live(null), now)).toBe("Streaming");
  });

  it("Finished once the run is over or the log is GitHub's, however old; Waiting before the first answer", () => {
    expect(streamState(false, live(ago(60_000)), now)).toBe("Finished");
    expect(streamState(true, { log: "x", source: "github", active: false, updatedAt: null }, now)).toBe("Finished");
    expect(streamState(true, { ...live(ago(60_000)), active: false }, now)).toBe("Finished");
    expect(streamState(true, undefined, now)).toBe("Waiting");
  });
});
