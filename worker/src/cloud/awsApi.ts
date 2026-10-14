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

/** One chunk per record, cut where each record's first field starts. Read fields with xmlFirst on a chunk. */
export function xmlRecords(xml: string, firstTag: string): string[] {
  return xml.split(`<${firstTag}>`).slice(1).map((s) => `<${firstTag}>${s}`);
}
