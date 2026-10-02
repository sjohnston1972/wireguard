import { describe, expectTypeOf, it } from "vitest";
import type { ApiError, SessionResponse } from "@shared/api";

// Proves the "@shared/*" alias resolves in the app's typecheck (npm run
// typecheck fails if it does not). Types only: nothing here runs in the Worker.
describe("@shared alias", () => {
  it("imports the API types", () => {
    expectTypeOf<ApiError>().toBeObject();
    expectTypeOf<SessionResponse>().toBeObject();
  });
});
