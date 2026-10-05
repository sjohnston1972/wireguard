// labs/resources.ts
//
// Plain English: the running lab's resources for its modal (LabDetail.resources):
// one ARM read of rg-lab-<id> (plus a sign-in when the token has expired),
// names, types and provisioning states only. Null when Azure is not
// connected or does not answer, so the modal simply leaves the list out.

import type { Env } from "../env";
import { canAzure } from "../env";
import { labRg } from "../../../shared/labs";
import type { LabDetail } from "../../../shared/api";
import { arm, directNet } from "./net";

export async function labResources(env: Env, labId: string): Promise<LabDetail["resources"]> {
  if (!canAzure(env)) return null;
  const rg = labRg(labId);
  try {
    const r = await arm(env, directNet(), `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${encodeURIComponent(rg)}/resources?api-version=2021-04-01&$expand=provisioningState`);
    if (!r.ok) return null;
    const j = (await r.json()) as { value?: { name?: string; type?: string; provisioningState?: string; properties?: { provisioningState?: string } }[] };
    return (j.value ?? []).slice(0, 200).map((x) => ({ name: String(x.name ?? ""), type: String(x.type ?? ""), group: rg, state: x.provisioningState ?? x.properties?.provisioningState ?? null }));
  } catch {
    return null;
  }
}
