// cloud/index.ts
//
// Plain English: the one door the rest of the Worker uses to touch the
// headend's cloud. Which cloud answers depends on where the headend was built
// (the snapshot's cloud), never on a global setting, so a hibernated Azure
// headend is still woken through Azure after AWS is set up. Like a router
// config that names the uplink per interface rather than assuming one.

import type { Cloud, Env } from "../env";
import type { AzureInventory } from "../state";
import { cloudOf, getSnapshot } from "../state";
import type { PublishedNsgRule } from "../firewall";
import type { AzureView } from "../azure";
import { azureOps } from "./azure";

/** What exists right now. Azure's field names: rg_exists means "the headend's container exists" (resource group, or AWS's tagged VPC). */
export type HeadendView = AzureView & { error?: string };
export type PowerOp = "hibernate" | "resume";

export interface CloudOps {
  id: Cloud;
  label: "Azure" | "AWS";
  /** Are this cloud's Worker credentials set? */
  configured(env: Env): boolean;
  /** Never throws; a failed check comes back with `error`. */
  view(env: Env): Promise<HeadendView>;
  /** Never throws; a failed check comes back with `error`. */
  inventory(env: Env): Promise<AzureInventory>;
  /** Hibernate = stop paying for compute, keep disk and address. Throws when the cloud refuses. */
  power(env: Env, op: PowerOp): Promise<void>;
  /** Point the SSH rule at one source. Throws when the cloud refuses. */
  setSshAllowedCidr(env: Env, cidr: string): Promise<void>;
  /** Make the edge's published-port rules exactly these. Throws when the cloud refuses. */
  setPublishedPorts(env: Env, rules: PublishedNsgRule[]): Promise<void>;
}

const OPS: Partial<Record<Cloud, CloudOps>> = { azure: azureOps };

export function opsFor(cloud: Cloud): CloudOps {
  const ops = OPS[cloud];
  if (!ops) throw new Error(`No adapter for ${cloud}`);
  return ops;
}

/** The adapter for wherever the headend is (or was last built). */
export async function headendOps(env: Env): Promise<CloudOps> {
  return opsFor(cloudOf(await getSnapshot(env)));
}
