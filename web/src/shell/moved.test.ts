import { describe, expect, it } from "vitest";
import { newAddress } from "./moved";

// The move to cloudlabs.clydeford.net (#126): a page on the old address goes on to the same page at the new one.
const at = (hostname: string, pathname = "/", search = "", hash = "") => ({ hostname, pathname, search, hash });

describe("newAddress", () => {
  it("sends the old address on, keeping the page, query and anchor", () => {
    expect(newAddress(at("wg-admin.clydeford.net", "/labs/az104-13", "?tab=guide", "#step-2"))).toBe("https://cloudlabs.clydeford.net/labs/az104-13?tab=guide#step-2");
  });

  it("stays put on the new address and on this PC", () => {
    expect(newAddress(at("cloudlabs.clydeford.net"))).toBeNull();
    expect(newAddress(at("localhost"))).toBeNull();
  });
});
