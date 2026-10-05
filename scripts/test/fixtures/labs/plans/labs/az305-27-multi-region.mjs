// scripts/test/fixtures/labs/plans/labs/az305-27-multi-region.mjs
//
// Plain English: lab 27's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what azurerm 4.81.0 computes). A container
// group in rg-lab-<id> (uksouth) and one in rg-lab-<id>-secondary (ukwest),
// a Traffic Manager profile with two external endpoints and a Front Door
// Standard profile, endpoint, origin group, two origins and a route, all
// global and in rg-lab-<id>. The containers' commands and DNS labels come
// from variables (known at plan); their FQDNs, which both front ends use,
// and every id are not.

import { ctx, IN_RG, ref, REGION, rgResource, rgSecondaryResource, SECONDARY } from "../common.mjs";

/** A resource inside rg-lab-<id>-secondary: its group's name and location, and var.tags. */
const IN_RG2 = { resource_group_name: ref("azurerm_resource_group.secondary", "name"), location: ref("azurerm_resource_group.secondary", "location"), tags: ["var.tags"] };
const IMAGE = "mcr.microsoft.com/azurelinux/base/python:3.12";

export default () => {
  const c = ctx("az305-27-multi-region", "27");
  const aci = (key, rg, location, refsIn, regionVar) => ({
    address: `azurerm_container_group.${key}`,
    values: {
      name: `ci-${key}`,
      resource_group_name: rg,
      location,
      os_type: "Linux",
      ip_address_type: "Public",
      dns_name_label: `${c.prefix}-${key}`,
      restart_policy: "Always",
      tags: c.tags,
      container: [
        {
          name: "web",
          image: IMAGE,
          cpu: 0.5,
          memory: 0.5,
          commands: ["/bin/sh", "-c", `mkdir -p /srv && echo "Hello from ${location} (ci-${key})" > /srv/index.html && exec python3 -m http.server 80 --directory /srv`],
          ports: [{ port: 80, protocol: "TCP" }],
        },
      ],
    },
    refs: { ...refsIn, dns_name_label: ["var.name_prefix"], "container.0.commands": [regionVar] },
  });
  const profile = "azurerm_traffic_manager_profile.lab";
  const endpoint = (key, priority) => ({
    address: `azurerm_traffic_manager_external_endpoint.${key}`,
    values: { name: `ep-${key}`, priority },
    unknown: ["profile_id", "target"],
    refs: { profile_id: ref(profile, "id"), target: ref(`azurerm_container_group.${key}`, "fqdn") },
  });
  const afd = "azurerm_cdn_frontdoor_profile.lab";
  const og = "azurerm_cdn_frontdoor_origin_group.lab";
  const origin = (key, priority) => ({
    address: `azurerm_cdn_frontdoor_origin.${key}`,
    values: { name: `origin-${key}`, enabled: true, http_port: 80, https_port: 443, priority, weight: 1000, certificate_name_check_enabled: true },
    unknown: ["cdn_frontdoor_origin_group_id", "host_name", "origin_host_header"],
    refs: { cdn_frontdoor_origin_group_id: ref(og, "id"), host_name: ref(`azurerm_container_group.${key}`, "fqdn"), origin_host_header: ref(`azurerm_container_group.${key}`, "fqdn") },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      rgSecondaryResource(c),
      aci("uks", c.rg, REGION, IN_RG, "var.region"),
      aci("ukw", c.rgSecondary, SECONDARY, IN_RG2, "var.secondary_region"),
      // Traffic Manager (global, in rg-lab-<id>; no location of its own).
      {
        address: profile,
        values: {
          name: `${c.prefix}-tm`,
          resource_group_name: c.rg,
          traffic_routing_method: "Priority",
          tags: c.tags,
          dns_config: [{ relative_name: `${c.prefix}-tm`, ttl: 30 }],
          monitor_config: [{ protocol: "HTTP", port: 80, path: "/", interval_in_seconds: 30, timeout_in_seconds: 10, tolerated_number_of_failures: 3 }],
        },
        refs: { name: ["var.name_prefix"], resource_group_name: IN_RG.resource_group_name, tags: ["var.tags"], "dns_config.0.relative_name": ["var.name_prefix"] },
      },
      endpoint("uks", 1),
      endpoint("ukw", 2),
      // Front Door Standard (global, in rg-lab-<id>).
      { address: afd, values: { name: "afd-lab", resource_group_name: c.rg, sku_name: "Standard_AzureFrontDoor", tags: c.tags }, refs: { resource_group_name: IN_RG.resource_group_name, tags: ["var.tags"] } },
      {
        address: "azurerm_cdn_frontdoor_endpoint.lab",
        values: { name: `${c.prefix}-afd`, tags: c.tags },
        unknown: ["cdn_frontdoor_profile_id"],
        refs: { name: ["var.name_prefix"], cdn_frontdoor_profile_id: ref(afd, "id"), tags: ["var.tags"] },
      },
      {
        address: og,
        values: {
          name: "og-aci",
          session_affinity_enabled: false,
          health_probe: [{ protocol: "Http", path: "/", request_type: "HEAD", interval_in_seconds: 100 }],
          load_balancing: [{ sample_size: 4, successful_samples_required: 3 }],
        },
        unknown: ["cdn_frontdoor_profile_id"],
        refs: { cdn_frontdoor_profile_id: ref(afd, "id") },
      },
      origin("uks", 1),
      origin("ukw", 2),
      {
        address: "azurerm_cdn_frontdoor_route.lab",
        values: { name: "route-all", patterns_to_match: ["/*"], supported_protocols: ["Http", "Https"], forwarding_protocol: "HttpOnly", https_redirect_enabled: false, link_to_default_domain: true },
        unknown: ["cdn_frontdoor_endpoint_id", "cdn_frontdoor_origin_group_id", "cdn_frontdoor_origin_ids"],
        refs: {
          cdn_frontdoor_endpoint_id: ref("azurerm_cdn_frontdoor_endpoint.lab", "id"),
          cdn_frontdoor_origin_group_id: ref(og, "id"),
          cdn_frontdoor_origin_ids: [...ref("azurerm_cdn_frontdoor_origin.uks", "id"), ...ref("azurerm_cdn_frontdoor_origin.ukw", "id")],
        },
      },
    ],
  };
};
