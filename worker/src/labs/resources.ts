// labs/resources.ts
//
// Plain English: the running lab's resources for its modal (LabDetail.resources):
// one ARM read of rg-lab-<id> (plus a sign-in when the token has expired),
// names, types and provisioning states only. Null when Azure is not
// connected or does not answer, so the modal simply leaves the list out.
//
// An AWS lab (AWS labs spec §6): what the tagging API lists tagged
// cloudlabs-lab = <id> in London, and in the lab's secondary region when it
// has one, and in us-east-1 for a global lab (one read each): the Name tag (else the resource id), the type from
// the ARN ("ec2:instance"), grouped by the lab's Resource Groups group and
// region. AWS has no provisioning state here. Null without AWS keys or when
// AWS refuses.

import type { Env } from "../env";
import { canAws, canAzure } from "../env";
import { AWS_GLOBAL_LABS, AWS_LAB_REGIONS, readsUsEast1, LAB_TAG, labResourceGroupName, labRg, type LabDef } from "../../../shared/labs";
import { awsRegionName } from "../../../shared/azureMetrics";
import type { LabDetail } from "../../../shared/api";
import { arm, directNet } from "./net";
import { arnParts, labTagged } from "./awsReads";

const MAX = 200;

async function awsLabResources(env: Env, def: LabDef): Promise<LabDetail["resources"]> {
  if (!canAws(env)) return null;
  const net = directNet();
  // A global lab's CloudFront and Route 53 items, and a DNS lab's Route 53 items, are tagged in us-east-1 (rulings P7, P5).
  const regions = [AWS_LAB_REGIONS[0], ...(def.regions.secondary ? [def.regions.secondary] : []), ...(readsUsEast1(def.id) ? ["us-east-1"] : [])];
  try {
    const out: NonNullable<LabDetail["resources"]> = [];
    for (const region of regions) {
      const group = region === "us-east-1" ? `${labResourceGroupName(def.id)} (global: ${AWS_GLOBAL_LABS.includes(def.id) ? "CloudFront, Route 53" : "Route 53"})` : `${labResourceGroupName(def.id)} (${awsRegionName(region)})`;
      for (const t of await labTagged(env, net, region, def.id)) {
        if (t.tags[LAB_TAG] !== def.id) continue;
        const p = arnParts(t.arn);
        out.push({ name: t.tags.Name || p.id, type: p.type ? `${p.service}:${p.type}` : p.service, group, state: null });
      }
    }
    return out.slice(0, MAX);
  } catch {
    return null;
  }
}

export async function labResources(env: Env, def: LabDef): Promise<LabDetail["resources"]> {
  if (def.cloud === "aws") return awsLabResources(env, def);
  if (!canAzure(env)) return null;
  const rg = labRg(def.id);
  try {
    const r = await arm(env, directNet(), `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${encodeURIComponent(rg)}/resources?api-version=2021-04-01&$expand=provisioningState`);
    if (!r.ok) return null;
    const j = (await r.json()) as { value?: { name?: string; type?: string; provisioningState?: string; properties?: { provisioningState?: string } }[] };
    return (j.value ?? []).slice(0, MAX).map((x) => ({ name: String(x.name ?? ""), type: String(x.type ?? ""), group: rg, state: x.provisioningState ?? x.properties?.provisioningState ?? null }));
  } catch {
    return null;
  }
}
