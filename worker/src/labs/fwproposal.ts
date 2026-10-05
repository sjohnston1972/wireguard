// labs/fwproposal.ts
//
// Plain English: the firewall's Labs rule for an install from before labs
// (spec §7.6). A fresh rule set starts with "Clients to labs" (firewall.ts
// STARTER_RULES, position 25). An existing one is never changed behind the
// operator's back: the rule is added once to the Firewall draft, at position
// 25 (between "Clients to the Azure VNet" and "Clients to the home LAN"),
// with a note, and reaches the VM only when the operator reviews the draft
// and presses Apply. Skipped when a live rule already lets clients reach the
// Labs zone. Once is once (KV): a dropped draft does not bring it back.

import type { Env } from "../env";
import * as db from "../db";
import type { FwRule } from "../firewall";

const KV_DONE = "labs:fw_proposed";
export const LABS_RULE_NAME = "Clients to labs";

const toLabs = (r: Pick<FwRule, "src_kind" | "src_value" | "dst_kind" | "dst_value">) => r.src_kind === "zone" && r.src_value === "clients" && r.dst_kind === "zone" && r.dst_value === "labs";

/** Propose the Labs rule in the draft, once. Returns a log line when it did. D1 and KV only. */
export async function proposeLabsRule(env: Env): Promise<string | null> {
  if (await env.STATUS.get(KV_DONE)) return null;
  const live = await db.listFwRules(env);
  if (live.some((r) => r.dst_kind === "zone" && r.dst_value === "labs")) {
    await env.STATUS.put(KV_DONE, "live");
    return null;
  }
  await db.ensureFwDraft(env);
  const draft = await db.listFwDraftRules(env);
  if (!draft.some(toLabs)) {
    await env.DB.prepare(
      `INSERT INTO fw_draft_rules (live_id, position, enabled, name, src_kind, src_value, dst_kind, dst_value, proto, ports, action, log, created_at)
       VALUES (NULL, CAST(?1 AS INTEGER), CAST(1 AS INTEGER), ?2, 'zone', 'clients', 'zone', 'labs', 'any', '', 'allow', CAST(0 AS INTEGER), ?3)`,
    )
      .bind(25, LABS_RULE_NAME, new Date().toISOString())
      .run();
  }
  await env.STATUS.put(KV_DONE, "draft");
  await db.addAlert(env, "info", `Labs: a firewall rule "${LABS_RULE_NAME}" (tunnel clients to the lab pool 10.64.0.0/13) is proposed in the Firewall draft. Review it and press Apply to let clients reach peered labs; nothing changes on the VM until then.`);
  return "firewall: Clients to labs proposed in the draft";
}
