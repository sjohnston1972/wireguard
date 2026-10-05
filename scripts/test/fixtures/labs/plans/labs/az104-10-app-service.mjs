// az104-10-app-service.mjs: lab 10's first-deploy plan, as
// labs/az104-10-app-service/terraform/main.tf builds it (a P0v3 Linux plan,
// a web app, a staging slot and autoscale on the plan). No VNet. Fake ids;
// realistic.mjs adds what Azure computes (hostnames, outbound addresses).

import { ctx, IN_RG, REGION, ref, rgResource } from "../common.mjs";

const PLAN = "azurerm_service_plan.plan";
const SITE = [{ always_on: true, ftps_state: "Disabled", minimum_tls_version: "1.2", http2_enabled: true, application_stack: [{ node_version: "22-lts" }] }];

const cpuRule = (operator, threshold, direction) => ({
  metric_trigger: [{ metric_name: "CpuPercentage", metric_namespace: "microsoft.web/serverfarms", time_grain: "PT1M", statistic: "Average", time_window: "PT5M", time_aggregation: "Average", operator, threshold }],
  scale_action: [{ direction, type: "ChangeCount", value: "1", cooldown: "PT5M" }],
});

export default () => {
  const c = ctx("az104-10-app-service", "10");
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: PLAN, values: { name: "asp-lab", resource_group_name: c.rg, location: REGION, os_type: "Linux", sku_name: "P0v3", worker_count: 1, tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_linux_web_app.web",
        values: { name: `${c.prefix}-web`, resource_group_name: c.rg, location: REGION, https_only: true, tags: c.tags, site_config: SITE },
        unknown: ["service_plan_id"],
        refs: { ...IN_RG, name: ["var.name_prefix"], service_plan_id: ref(PLAN, "id") },
      },
      {
        address: "azurerm_linux_web_app_slot.staging",
        values: { name: "staging", https_only: true, tags: c.tags, site_config: SITE },
        unknown: ["app_service_id"],
        refs: { app_service_id: ref("azurerm_linux_web_app.web", "id"), tags: ["var.tags"] },
      },
      {
        address: "azurerm_monitor_autoscale_setting.plan",
        values: {
          name: "autoscale-asp-lab",
          resource_group_name: c.rg,
          location: REGION,
          enabled: true,
          tags: c.tags,
          profile: [{ name: "cpu", capacity: [{ default: 1, minimum: 1, maximum: 2 }], rule: [cpuRule("GreaterThan", 70, "Increase"), cpuRule("LessThan", 25, "Decrease")] }],
        },
        unknown: ["target_resource_id", "profile.0.rule.0.metric_trigger.0.metric_resource_id", "profile.0.rule.1.metric_trigger.0.metric_resource_id"],
        refs: {
          ...IN_RG,
          target_resource_id: ref(PLAN, "id"),
          "profile.0.rule.0.metric_trigger.0.metric_resource_id": ref(PLAN, "id"),
          "profile.0.rule.1.metric_trigger.0.metric_resource_id": ref(PLAN, "id"),
        },
      },
    ],
  };
};
