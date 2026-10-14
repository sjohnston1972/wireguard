// Signed AWS calls: the request shape and the error mapping.
import { describe, it, expect, afterEach, vi } from "vitest";
import { ec2, awsJson, filters, xmlFirst, xmlAll, xmlRecords, AwsError } from "../src/cloud/awsApi";
import { canAws, config, type Env } from "../src/env";

afterEach(() => vi.unstubAllGlobals());
const env = { AWS_WORKER_ACCESS_KEY_ID: "AKIDTEST", AWS_WORKER_SECRET_ACCESS_KEY: "secret" } as unknown as Env;

describe("config", () => {
  it("defaults AWS to London, t4g.micro, hidden", () => {
    expect(config({} as Env).aws).toEqual({ enabled: false, region: "eu-west-2", instanceType: "t4g.micro", hourlyRateGbp: 0.011, standbyRateGbp: 0.005, usdToGbp: 0.75, workflow: "wg-aws.yml" });
  });
  it("canAws needs both worker keys, not placeholders", () => {
    expect(canAws(env)).toBe(true);
    expect(canAws({ AWS_WORKER_ACCESS_KEY_ID: "AKID" } as Env)).toBe(false);
    expect(canAws({ AWS_WORKER_ACCESS_KEY_ID: "REPLACE_ME", AWS_WORKER_SECRET_ACCESS_KEY: "x" } as Env)).toBe(false);
  });
});

describe("Query API helpers", () => {
  it("flattens filters", () => {
    expect(filters([["tag:wg-admin", ["vpn"]], ["instance-state-name", ["running", "stopped"]]])).toEqual({
      "Filter.1.Name": "tag:wg-admin", "Filter.1.Value.1": "vpn",
      "Filter.2.Name": "instance-state-name", "Filter.2.Value.1": "running", "Filter.2.Value.2": "stopped",
    });
  });
  it("reads XML fields and decodes entities", () => {
    const x = "<a><name>one &amp; two</name><name>three</name></a>";
    expect(xmlFirst(x, "name")).toBe("one & two");
    expect(xmlAll(x, "name")).toEqual(["one & two", "three"]);
    expect(xmlFirst(x, "missing")).toBeNull();
  });
  it("cuts a list into records at each first field", () => {
    const x = "<set><item><id>a</id><v>1</v></item><item><id>b</id><v>2</v></item></set>";
    expect(xmlRecords(x, "id").map((r) => xmlFirst(r, "v"))).toEqual(["1", "2"]);
  });
});

describe("ec2", () => {
  it("signs a POST to the regional endpoint with the Query API body", async () => {
    let seen: Request | null = null;
    vi.stubGlobal("fetch", async (input: Request) => {
      seen = input;
      return new Response("<DescribeVpcsResponse><vpcSet/></DescribeVpcsResponse>", { status: 200 });
    });
    const xml = await ec2(env, "DescribeVpcs", filters([["tag:wg-admin", ["vpn"]]]));
    expect(xml).toContain("DescribeVpcsResponse");
    expect(seen!.url).toBe("https://ec2.eu-west-2.amazonaws.com/");
    expect(seen!.method).toBe("POST");
    expect(seen!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/eu-west-2\/ec2\/aws4_request/);
    const body = new URLSearchParams(await seen!.text());
    expect(body.get("Action")).toBe("DescribeVpcs");
    expect(body.get("Version")).toBe("2016-11-15");
    expect(body.get("Filter.1.Name")).toBe("tag:wg-admin");
  });
  it("turns an EC2 error document into AwsError", async () => {
    vi.stubGlobal("fetch", async () => new Response("<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>You are not authorized</Message></Error></Errors></Response>", { status: 403 }));
    await expect(ec2(env, "StopInstances", { "InstanceId.1": "i-1" })).rejects.toMatchObject({ code: "UnauthorizedOperation", status: 403 });
  });
});

describe("awsJson", () => {
  it("sends the target header and maps __type errors", async () => {
    vi.stubGlobal("fetch", async (input: Request) => {
      expect(input.headers.get("x-amz-target")).toBe("ResourceGroupsTaggingAPI_20170126.GetResources");
      return new Response(JSON.stringify({ __type: "com.amazon#ThrottlingException", message: "Rate exceeded" }), { status: 400 });
    });
    const p = awsJson(env, { service: "tagging", region: "eu-west-2", host: "tagging.eu-west-2.amazonaws.com", target: "ResourceGroupsTaggingAPI_20170126.GetResources", body: {} });
    await expect(p).rejects.toBeInstanceOf(AwsError);
    await expect(p).rejects.toMatchObject({ code: "ThrottlingException", message: "Rate exceeded" });
  });
});

describe("retries", () => {
  it("retries a 503 once, then succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => (++calls === 1 ? new Response("<Response/>", { status: 503 }) : new Response("<OkResponse/>", { status: 200 })));
    await expect(ec2(env, "DescribeVpcs")).resolves.toContain("OkResponse");
    expect(calls).toBe(2);
  });
  it("gives up after one retry and surfaces the error", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return new Response("<Response><Errors><Error><Code>ServiceUnavailable</Code><Message>busy</Message></Error></Errors></Response>", { status: 503 });
    });
    await expect(ec2(env, "DescribeVpcs")).rejects.toMatchObject({ name: "Error", code: "ServiceUnavailable", status: 503 });
    expect(calls).toBe(2);
  });
});
