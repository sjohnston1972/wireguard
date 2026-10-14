// Signed AWS calls: the request shape and the error mapping.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ec2, awsJson, filters, xmlFirst, xmlAll, xmlItems, xmlOwn, AwsError } from "../src/cloud/awsApi";
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
});

describe("xmlItems", () => {
  const fixture = readFileSync(new URL("./fixtures/aws/describe-sg-rules.xml", import.meta.url), "utf8");
  const rule = (item: string) => {
    const r = xmlOwn(item);
    return { id: xmlFirst(r, "securityGroupRuleId"), description: xmlFirst(r, "description"), protocol: xmlFirst(r, "ipProtocol"), from: xmlFirst(r, "fromPort"), to: xmlFirst(r, "toPort"), cidr: xmlFirst(r, "cidrIpv4"), egress: xmlFirst(r, "isEgress") };
  };

  it("reads every rule of a real DescribeSecurityGroupRules answer with its own fields (EC2 lists them alphabetically)", () => {
    const rules = xmlItems(fixture, "securityGroupRuleSet").map(rule);
    expect(rules).toHaveLength(8);
    expect(rules.filter((r) => r.egress === "true")).toHaveLength(2);
    expect(rules.find((r) => r.description === "ssh-from-home")).toEqual({ id: "sgr-06731c55055802f63", description: "ssh-from-home", protocol: "tcp", from: "22", to: "22", cidr: "203.0.113.7/32", egress: "false" });
    expect(rules.find((r) => r.description === "published-tcp-2230")).toEqual({ id: "sgr-0ae2a0369b8bc1ce5", description: "published-tcp-2230", protocol: "tcp", from: "2230", to: "2230", cidr: "0.0.0.0/0", egress: "false" });
    expect(rules.find((r) => r.description === "published-tcp-8080")).toEqual({ id: "sgr-0148109b78d97895e", description: "published-tcp-8080", protocol: "tcp", from: "8080", to: "8080", cidr: "203.0.113.7/32", egress: "false" });
    // WireGuard has two rules: IPv6 (no cidrIpv4) and IPv4.
    expect(rules.filter((r) => r.description === "wireguard")).toEqual([
      { id: "sgr-01ff26f508f46d552", description: "wireguard", protocol: "udp", from: "51820", to: "51820", cidr: null, egress: "false" },
      { id: "sgr-016f6bfb58af353c4", description: "wireguard", protocol: "udp", from: "51820", to: "51820", cidr: "0.0.0.0/0", egress: "false" },
    ]);
    // A rule without a description does not borrow the next rule's.
    expect(rules.find((r) => r.id === "sgr-0f8f26832a5673ef5")).toMatchObject({ description: null, egress: "true" });
  });

  it("keeps nested items (tags) inside their parent, and xmlOwn hides their fields", () => {
    const x =
      "<R><ruleSet>" +
      "<item><cidrIpv4>10.0.0.0/8</cidrIpv4><fromPort>22</fromPort><securityGroupRuleId>sgr-a</securityGroupRuleId><tagSet><item><key>Name</key><value>x</value><description>from-a-tag</description></item></tagSet><toPort>22</toPort></item>" +
      "<item/>" +
      "<item><cidrIpv4>0.0.0.0/0</cidrIpv4><description>b</description><securityGroupRuleId>sgr-b</securityGroupRuleId><tagSet/></item>" +
      "</ruleSet><ruleSet><item><securityGroupRuleId>sgr-other-set</securityGroupRuleId></item></ruleSet></R>";
    const items = xmlItems(x, "ruleSet");
    expect(items).toHaveLength(3);
    expect(items[0]).toContain("<key>Name</key>");
    expect(xmlFirst(xmlOwn(items[0]), "securityGroupRuleId")).toBe("sgr-a");
    expect(xmlFirst(xmlOwn(items[0]), "toPort")).toBe("22");
    expect(xmlFirst(xmlOwn(items[0]), "description")).toBeNull();
    expect(xmlFirst(xmlOwn(items[0]), "key")).toBeNull();
    expect(xmlOwn(items[1])).toBe("");
    expect(xmlFirst(xmlOwn(items[2]), "description")).toBe("b");
  });

  it("an empty or missing set has no items", () => {
    expect(xmlItems("<R><ruleSet/></R>", "ruleSet")).toEqual([]);
    expect(xmlItems("<R><ruleSet></ruleSet></R>", "ruleSet")).toEqual([]);
    expect(xmlItems("<R/>", "ruleSet")).toEqual([]);
  });

  it("a self-closing set with attributes or a space is empty, and does not borrow the next set's items", () => {
    expect(xmlItems('<R><ruleSet a="1"/><other><item><id>x</id></item></other></R>', "ruleSet")).toEqual([]);
    expect(xmlItems("<R><ruleSet /><other><item><id>x</id></item></other></R>", "ruleSet")).toEqual([]);
    // A set that opens with attributes still has its items.
    expect(xmlItems('<R><ruleSet a="1"><item><id>a</id></item></ruleSet></R>', "ruleSet").map((i) => xmlFirst(xmlOwn(i), "id"))).toEqual(["a"]);
  });

  it("items with attributes are whole items, nested ones included", () => {
    const x = '<R><ruleSet><item x="1"><id>a</id><tagSet><item k="v"><id>tag</id></item></tagSet></item><item y="2"/><item><id>b</id></item></ruleSet></R>';
    const items = xmlItems(x, "ruleSet");
    expect(items).toHaveLength(3);
    expect(xmlFirst(xmlOwn(items[0]), "id")).toBe("a");
    expect(xmlOwn(items[1])).toBe("");
    expect(xmlFirst(xmlOwn(items[2]), "id")).toBe("b");
  });

  it("walks reservation -> instance, and the instance's network interface never supplies its address", () => {
    const x =
      "<DescribeInstancesResponse><reservationSet><item><reservationId>r-1</reservationId><groupSet/><instancesSet><item>" +
      "<instanceId>i-1</instanceId><instanceState><code>80</code><name>stopped</name></instanceState>" +
      "<networkInterfaceSet><item><ipAddress>198.51.100.9</ipAddress><instanceType>wrong</instanceType><privateIpAddress>10.50.1.99</privateIpAddress><association><publicIp>198.51.100.9</publicIp></association></item></networkInterfaceSet>" +
      "<groupSet><item><groupId>sg-1</groupId></item></groupSet>" +
      "<instanceType>t4g.micro</instanceType><privateIpAddress>10.50.1.4</privateIpAddress>" +
      "</item></instancesSet></item></reservationSet></DescribeInstancesResponse>";
    const instance = xmlItems(xmlItems(x, "reservationSet")[0], "instancesSet")[0];
    const own = xmlOwn(instance);
    expect(xmlFirst(own, "instanceId")).toBe("i-1");
    expect(xmlFirst(own, "instanceType")).toBe("t4g.micro");
    expect(xmlFirst(own, "privateIpAddress")).toBe("10.50.1.4");
    expect(xmlFirst(own, "ipAddress")).toBeNull();
    expect(xmlFirst(own, "groupId")).toBeNull();
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
