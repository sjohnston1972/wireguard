// cloud/awsApi.ts
//
// Plain English: how the Worker talks to AWS. Every call is signed (SigV4)
// with the Worker's own narrow IAM user. EC2 answers in XML; tagging and
// Cost Explorer answer in JSON. We only ever need a handful of fields, so
// the XML is read with small, strict helpers rather than a full parser
// (Workers have no DOMParser).

import { AwsClient } from "aws4fetch";
import type { Env } from "../env";
import { config } from "../env";

/** An AWS refusal: its error code ("UnauthorizedOperation", "ThrottlingException", ...) and HTTP status. */
export class AwsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function client(env: Env, service: string, region: string): AwsClient {
  return new AwsClient({
    accessKeyId: env.AWS_WORKER_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.AWS_WORKER_SECRET_ACCESS_KEY ?? "",
    service,
    region,
    retries: 1, // one quick retry, then the error surfaces; the watchman tries again on its next tick
  });
}

/** One EC2 Query API call. `params` use the Query API's flat names (Filter.1.Name, InstanceId.1, ...). Returns the XML. */
export async function ec2(env: Env, action: string, params: Record<string, string> = {}): Promise<string> {
  const region = config(env).aws.region;
  const body = new URLSearchParams({ Action: action, Version: "2016-11-15", ...params });
  const r = await client(env, "ec2", region).fetch(`https://ec2.${region}.amazonaws.com/`, {
    method: "POST",
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
  });
  const text = await r.text();
  if (!r.ok) throw new AwsError(xmlFirst(text, "Code") ?? `HTTP${r.status}`, xmlFirst(text, "Message") ?? `EC2 ${action} failed (${r.status})`, r.status);
  return text;
}

/**
 * Every page of a paged EC2 Describe call: each answer's nextToken is sent back for the next page, at most `maxPages`
 * pages (10). Returns each page's XML. EC2 may answer a filtered call with an empty page and a token, so the token,
 * not the page, says whether there is more.
 */
export async function ec2Pages(env: Env, action: string, params: Record<string, string> = {}, maxPages = 10): Promise<string[]> {
  const pages: string[] = [];
  let token = "";
  for (let page = 0; page < maxPages; page++) {
    const xml = await ec2(env, action, token ? { ...params, NextToken: token } : params);
    pages.push(xml);
    token = xmlFirst(xml, "nextToken") ?? "";
    if (!token) break;
  }
  return pages;
}

/**
 * One Query API call to another AWS service in the Worker's region (CloudWatch: service "monitoring", Version
 * 2010-08-01), the same way as ec2() but with the service and API version given. Returns the XML.
 */
export async function awsQuery(env: Env, service: string, action: string, params: Record<string, string>, version: string): Promise<string> {
  const region = config(env).aws.region;
  const body = new URLSearchParams({ Action: action, Version: version, ...params });
  const r = await client(env, service, region).fetch(`https://${service}.${region}.amazonaws.com/`, {
    method: "POST",
    body: body.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
  });
  const text = await r.text();
  if (!r.ok) throw new AwsError(xmlFirst(text, "Code") ?? `HTTP${r.status}`, xmlFirst(text, "Message") ?? `${service} ${action} failed (${r.status})`, r.status);
  return text;
}

/** One JSON-protocol call (tagging, Cost Explorer). */
export async function awsJson<T>(env: Env, o: { service: string; region: string; host: string; target: string; body: unknown }): Promise<T> {
  const r = await client(env, o.service, o.region).fetch(`https://${o.host}/`, {
    method: "POST",
    body: JSON.stringify(o.body),
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": o.target },
  });
  const text = await r.text();
  if (!r.ok) {
    let code = `HTTP${r.status}`;
    let message = `${o.target} failed (${r.status})`;
    try {
      const j = JSON.parse(text) as { __type?: string; message?: string; Message?: string };
      if (j.__type) code = j.__type.split("#").pop() ?? code;
      message = j.message ?? j.Message ?? message;
    } catch {
      /* not JSON: keep the generic message */
    }
    throw new AwsError(code, message, r.status);
  }
  return JSON.parse(text) as T;
}

/** [["tag:wg-admin", ["vpn"]]] -> { "Filter.1.Name": "tag:wg-admin", "Filter.1.Value.1": "vpn" } */
export function filters(list: [string, string[]][]): Record<string, string> {
  const out: Record<string, string> = {};
  list.forEach(([name, values], i) => {
    out[`Filter.${i + 1}.Name`] = name;
    values.forEach((v, j) => (out[`Filter.${i + 1}.Value.${j + 1}`] = v));
  });
  return out;
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The text of the first <tag>…</tag> (no nested elements), or null. */
export function xmlFirst(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? decode(m[1]) : null;
}

/** The text of every <tag>…</tag> (no nested elements). */
export function xmlAll(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => decode(m[1]));
}

/**
 * Where each top-level <item>…</item> (or <item/>; attributes allowed on either) in `body` starts and ends, counting
 * depth so an item's own nested items (tags, network interfaces) stay inside it. Stops at `stopAt` (a closing tag)
 * found at depth 0.
 */
function itemSpans(body: string, stopAt?: string): [number, number][] {
  const spans: [number, number][] = [];
  const tokens = new RegExp(`<(/?)item(?:\\s[^>]*?)?(/?)>${stopAt ? `|${stopAt}` : ""}`, "g");
  let depth = 0;
  let start = 0;
  for (const m of body.matchAll(tokens)) {
    const at = m.index ?? 0;
    if (m[0] === stopAt) {
      if (depth === 0) break; // the set's own closing tag
    } else if (m[2]) {
      if (depth === 0) spans.push([at, at + m[0].length]);
    } else if (!m[1]) {
      if (depth++ === 0) start = at;
    } else if (depth > 0 && --depth === 0) {
      spans.push([start, at + m[0].length]);
    }
  }
  return spans;
}

/**
 * The top-level <item> elements directly inside the first <setTag>…</setTag>, as strings (nested <item>s, such as
 * tags, stay inside their parent). EC2 orders an item's fields as it likes (DescribeSecurityGroupRules is
 * alphabetical), so records are always cut at whole items, never at a field. Read fields with xmlFirst(xmlOwn(item)).
 */
export function xmlItems(xml: string, setTag: string): string[] {
  // Lazy attributes, so the "/" of <setTag a="1"/> or <setTag /> is read as self-closing, not as an attribute.
  const open = xml.match(new RegExp(`<${setTag}(?:\\s[^>]*?)?(/?)>`));
  if (!open || open[1]) return []; // absent, or empty (<setTag/>)
  const body = xml.slice((open.index ?? 0) + open[0].length);
  return itemSpans(body, `</${setTag}>`).map(([a, b]) => body.slice(a, b));
}

/**
 * An item with its nested <item>s cut out, so a field read with xmlFirst is the item's own and never a child
 * record's (a tag, a network interface's privateIpAddress, a group). Nested non-list elements (instanceState) stay.
 */
export function xmlOwn(item: string): string {
  const inner = itemInner(item);
  let out = "";
  let from = 0;
  for (const [a, b] of itemSpans(inner)) {
    out += inner.slice(from, a);
    from = b;
  }
  return out + inner.slice(from);
}

/**
 * The items of the item's OWN <setTag> (an instance's tagSet or blockDeviceMapping), never a nested record's set of
 * the same name (a network interface has a groupSet and could carry a tagSet of its own).
 */
export function xmlOwnItems(item: string, setTag: string): string[] {
  const inner = itemInner(item);
  const nested = itemSpans(inner);
  for (const m of inner.matchAll(new RegExp(`<${setTag}(?:\\s[^>]*?)?/?>`, "g"))) {
    const at = m.index ?? 0;
    if (!nested.some(([a, b]) => at >= a && at < b)) return xmlItems(inner.slice(at), setTag);
  }
  return [];
}

const itemInner = (item: string) => item.replace(/^<item(?:\s[^>]*)?>/, "").replace(/<\/item>$/, "");
