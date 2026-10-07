// labs-az305-messaging.test.mjs
//
// Plain English: lab 30, az305-30-messaging (AZ-305 batch 4: Service Bus,
// Event Grid and an event-driven consumer), checked without touching Azure.
// It runs the shared content suite (fixtures/labs/content.mjs: catalogue
// rules, lint, one resource group, lab.yaml agreeing with the Terraform,
// prices, marker, terraform fmt), then its own tests: what it builds, read
// from its Terraform text, that no secret reaches an output and no role is
// assigned, and that the consumer's Python really does Service Bus's
// peek-lock dance (against a fake Service Bus on 127.0.0.1, when python3 is
// installed). Plans and the scope check are lab-plans.test.mjs's job; init,
// validate and the mocked plan are npm run labs-tf's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attr, lab, labContentSuite, resources, uncomment } from "./fixtures/labs/content.mjs";
import { COMPUTED, SCHEMA_FACTS } from "./fixtures/labs/plans/realistic.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { checkPlan } from "../../infra/ci/lab-scope.mjs";
import { timeoutMin } from "../lab-release-test.mjs";

const L30 = "az305-30-messaging";

// ── Helpers ──────────────────────────────────────────────────────────────

const unq = (v) => (v ?? "").replace(/^"|"$/g, "");
/** One resource block by type and name. */
const res = (l, type, name) => {
  const r = resources(l, type).find((x) => x.labels[1] === name);
  assert.ok(r, `${type}.${name} exists`);
  return r;
};
const output = (l, name) => l.blocks.find((b) => b.kind === "output" && b.labels[0] === name);
/** Every Terraform file, comments dropped. */
const code = (l) => uncomment(Object.values(l.files).join("\n"));

/** The body of the first nested block `name { ... }` in `body` (any depth), or undefined. */
function nested(body, name) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*\\{`).exec(body ?? "");
  if (!m) return undefined;
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) break;
  }
  return body.slice(m.index + m[0].length, i);
}

/** Every nested block `name { ... }` in `body`, in order. */
function allNested(body, name) {
  const out = [];
  let rest = body ?? "";
  for (let b = nested(rest, name); b !== undefined; b = nested(rest, name)) {
    out.push(b);
    rest = rest.slice(rest.indexOf(b) + b.length);
  }
  return out;
}

/** The azurerm provider's features block from versions.tf. */
const features = (l) => {
  const p = l.blocks.find((b) => b.kind === "provider" && b.labels[0] === "azurerm");
  assert.ok(p, 'versions.tf has provider "azurerm"');
  const f = nested(p.body, "features");
  assert.ok(f !== undefined, "the azurerm provider has a features block");
  return f;
};

// ── The plan fixture's types ─────────────────────────────────────────────

/** Every type lab 30 uses that no earlier lab did: extract-computed.mjs's TYPES, computed.json and schema-facts.json have them. */
const LAB30_TYPES = [
  "azurerm_servicebus_namespace",
  "azurerm_servicebus_namespace_authorization_rule",
  "azurerm_servicebus_queue",
  "azurerm_servicebus_topic",
  "azurerm_servicebus_subscription",
  "azurerm_servicebus_subscription_rule",
  "azurerm_eventgrid_system_topic",
  "azurerm_eventgrid_system_topic_event_subscription",
  "azurerm_container_app_job",
];

test("computed.json and schema-facts.json have every type lab 30 uses, as azurerm 4.81.0 declares them", () => {
  assert.deepEqual(LAB30_TYPES.filter((t) => !COMPUTED.types[t]), []);
  assert.deepEqual(SCHEMA_FACTS.azurerm_servicebus_namespace, { rg: true, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_servicebus_queue, { rg: false, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_eventgrid_system_topic, { rg: true, tags: true });
  assert.deepEqual(SCHEMA_FACTS.azurerm_eventgrid_system_topic_event_subscription, { rg: true, tags: false });
  assert.deepEqual(SCHEMA_FACTS.azurerm_container_app_job, { rg: true, tags: true });
  // The keys and connection strings a plan marks sensitive whether set or not.
  assert.ok(COMPUTED.types.azurerm_servicebus_namespace_authorization_rule.sensitive.includes("primary_connection_string"));
  assert.ok(COMPUTED.types.azurerm_servicebus_namespace.sensitive.includes("default_primary_connection_string"));
});

// ── The shared content suite ─────────────────────────────────────────────

labContentSuite(L30, { marker: "£" });

// ── Service Bus ──────────────────────────────────────────────────────────

test(`${L30}: a Standard Service Bus namespace (topics need Standard), TLS 1.2, shared access keys on for the consumer`, () => {
  const l = lab(L30);
  const ns = res(l, "azurerm_servicebus_namespace", "sb").body;
  assert.equal(attr(ns, "name"), '"sb-${var.name_prefix}"');
  assert.equal(attr(ns, "sku"), '"Standard"', "Standard: topics and subscriptions (Basic has queues only); Premium costs about 70 times as much");
  assert.equal(attr(ns, "capacity"), undefined, "no messaging units (Premium only)");
  assert.equal(attr(ns, "minimum_tls_version"), '"1.2"');
  assert.equal(attr(ns, "local_auth_enabled"), "true", "SAS keys on: the consumer holds one as a Container Apps secret (no Service Bus data role is on the labs' allow-list)");
  assert.equal(attr(ns, "public_network_access_enabled"), "true", "Event Grid, the consumer and the portal reach it over its public endpoint");
  assert.equal(nested(ns, "network_rule_set"), undefined);
  assert.equal(resources(l, "azurerm_servicebus_namespace").length, 1);
});

test(`${L30}: two queues with dead-lettering, a 30-second lock and five deliveries; a topic with two subscriptions and a SQL filter`, () => {
  const l = lab(L30);
  const queues = resources(l, "azurerm_servicebus_queue");
  assert.deepEqual(queues.map((q) => unq(attr(q.body, "name"))).sort(), ["blob-events", "orders"]);
  for (const q of queues) {
    const b = q.body;
    assert.equal(attr(b, "namespace_id"), "azurerm_servicebus_namespace.sb.id", q.labels[1]);
    assert.equal(attr(b, "max_delivery_count"), "5", `${q.labels[1]}: a message the consumer keeps failing is dead-lettered after five deliveries`);
    assert.equal(attr(b, "lock_duration"), '"PT30S"', `${q.labels[1]}: a short lock, so a failed message comes back quickly`);
    assert.equal(attr(b, "default_message_ttl"), '"PT1H"', q.labels[1]);
    assert.equal(attr(b, "dead_lettering_on_message_expiration"), "true", `${q.labels[1]}: expired messages go to the dead-letter queue too`);
    assert.notEqual(attr(b, "requires_session"), "true", `${q.labels[1]}: Event Grid cannot deliver to a session queue`);
    assert.notEqual(attr(b, "partitioning_enabled"), "true", q.labels[1]);
  }
  const topic = res(l, "azurerm_servicebus_topic", "notifications").body;
  assert.equal(attr(topic, "name"), '"notifications"');
  assert.equal(attr(topic, "namespace_id"), "azurerm_servicebus_namespace.sb.id");
  const subs = resources(l, "azurerm_servicebus_subscription");
  assert.deepEqual(subs.map((s) => unq(attr(s.body, "name"))).sort(), ["all", "high-priority"]);
  for (const s of subs) {
    assert.equal(attr(s.body, "topic_id"), "azurerm_servicebus_topic.notifications.id", s.labels[1]);
    assert.equal(attr(s.body, "max_delivery_count"), "5", s.labels[1]);
    assert.equal(attr(s.body, "dead_lettering_on_message_expiration"), "true", s.labels[1]);
  }
  const rules = resources(l, "azurerm_servicebus_subscription_rule");
  assert.equal(rules.length, 1, "one rule: on high-priority");
  const rule = rules[0].body;
  assert.equal(attr(rule, "subscription_id"), "azurerm_servicebus_subscription.high_priority.id");
  assert.equal(attr(rule, "filter_type"), '"SqlFilter"');
  assert.equal(attr(rule, "sql_filter"), `"priority = 'high'"`);
  assert.notEqual(unq(attr(rule, "name")), "$Default", "Terraform cannot take over the rule Azure makes; the readme has the learner delete it");
});

test(`${L30}: two shared access policies: Listen only for the consumer, Manage for KEDA's queue-length check; no Send key anywhere`, () => {
  const l = lab(L30);
  const rules = resources(l, "azurerm_servicebus_namespace_authorization_rule");
  assert.deepEqual(rules.map((r) => r.labels[1]).sort(), ["consumer", "scaler"]);
  const consumer = res(l, "azurerm_servicebus_namespace_authorization_rule", "consumer").body;
  assert.equal(attr(consumer, "namespace_id"), "azurerm_servicebus_namespace.sb.id");
  assert.equal(attr(consumer, "listen"), "true");
  assert.equal(attr(consumer, "send"), "false");
  assert.equal(attr(consumer, "manage"), "false");
  const scaler = res(l, "azurerm_servicebus_namespace_authorization_rule", "scaler").body;
  // KEDA reads a queue's message count through the management API, which needs Manage (and Manage needs Listen and Send).
  assert.equal(attr(scaler, "manage"), "true");
  assert.equal(attr(scaler, "listen"), "true");
  assert.equal(attr(scaler, "send"), "true");
  assert.equal(resources(l, "azurerm_servicebus_queue_authorization_rule").length, 0);
  assert.equal(resources(l, "azurerm_servicebus_topic_authorization_rule").length, 0);
  // No identity change: no role assignment, no Service Bus data role, no managed identity to hold one.
  assert.equal(resources(l, "azurerm_role_assignment").length, 0);
  assert.doesNotMatch(code(l), /Azure Service Bus Data/);
  assert.doesNotMatch(code(l), /\bidentity\s*\{/);
});

// ── Event Grid ───────────────────────────────────────────────────────────

test(`${L30}: a system topic on the storage account sends blob events in uploads/ to the blob-events queue, dead-lettering to the account`, () => {
  const l = lab(L30);
  const sa = res(l, "azurerm_storage_account", "events").body;
  assert.equal(attr(sa, "name"), '"${var.name_prefix}evt"');
  assert.equal(attr(sa, "account_kind"), '"StorageV2"', "Event Grid needs a general-purpose v2 (or Blob) account");
  assert.equal(attr(sa, "account_replication_type"), '"LRS"');
  assert.equal(attr(sa, "allow_nested_items_to_be_public"), "false");
  assert.equal(attr(sa, "min_tls_version"), '"TLS1_2"');
  assert.equal(attr(sa, "https_traffic_only_enabled"), "true");
  const containers = resources(l, "azurerm_storage_container");
  assert.deepEqual(containers.map((c) => unq(attr(c.body, "name"))).sort(), ["eventgrid-deadletter", "uploads"]);
  for (const c of containers) {
    assert.equal(attr(c.body, "storage_account_id"), "azurerm_storage_account.events.id", c.labels[1]);
    assert.equal(attr(c.body, "container_access_type"), '"private"', c.labels[1]);
  }
  const topic = res(l, "azurerm_eventgrid_system_topic", "storage").body;
  assert.equal(attr(topic, "topic_type"), '"Microsoft.Storage.StorageAccounts"');
  assert.equal(attr(topic, "source_resource_id"), "azurerm_storage_account.events.id", "source_resource_id (source_arm_resource_id is deprecated in azurerm 4.x)");
  assert.equal(attr(topic, "location"), "azurerm_resource_group.lab.location", "a storage system topic lives in its account's region");
  const sub = res(l, "azurerm_eventgrid_system_topic_event_subscription", "blob_to_queue").body;
  assert.equal(attr(sub, "system_topic"), "azurerm_eventgrid_system_topic.storage.name");
  assert.equal(attr(sub, "service_bus_queue_endpoint_id"), "azurerm_servicebus_queue.blob_events.id");
  assert.match(attr(sub, "included_event_types"), /"Microsoft\.Storage\.BlobCreated"/);
  assert.match(attr(sub, "included_event_types"), /"Microsoft\.Storage\.BlobDeleted"/);
  assert.equal(attr(nested(sub, "subject_filter"), "subject_begins_with"), '"/blobServices/default/containers/uploads/"', "only the uploads container: dead-lettered events landing in the same account never loop back");
  const retry = nested(sub, "retry_policy");
  assert.equal(attr(retry, "max_delivery_attempts"), "5");
  assert.equal(attr(retry, "event_time_to_live"), "60");
  const dl = nested(sub, "storage_blob_dead_letter_destination");
  assert.equal(attr(dl, "storage_account_id"), "azurerm_storage_account.events.id");
  assert.equal(attr(dl, "storage_blob_container_name"), "azurerm_storage_container.deadletter.name");
  // Delivered with Event Grid's own access (no delivery identity, so no role assignment).
  assert.equal(nested(sub, "delivery_identity"), undefined);
  assert.equal(nested(sub, "dead_letter_identity"), undefined);
});

// ── The consumer: a Container Apps job, not App Service ──────────────────

test(`${L30}: no App Service anywhere (the subscription's quota is 0): the consumer is an event-driven Container Apps job`, () => {
  const l = lab(L30);
  for (const t of ["azurerm_service_plan", "azurerm_linux_function_app", "azurerm_windows_function_app", "azurerm_function_app_flex_consumption", "azurerm_linux_web_app", "azurerm_logic_app_standard", "azurerm_api_connection"]) {
    assert.equal(resources(l, t).length, 0, `no ${t}`);
  }
  const env = res(l, "azurerm_container_app_environment", "lab").body;
  assert.equal(attr(env, "infrastructure_subnet_id"), undefined, "consumption only, no subnet: Azure makes no ME_ group (ruling 7)");
  assert.equal(nested(env, "workload_profile"), undefined);
  assert.equal(attr(env, "log_analytics_workspace_id"), "azurerm_log_analytics_workspace.lab.id");
  assert.equal(attr(env, "logs_destination"), '"log-analytics"');
  const job = res(l, "azurerm_container_app_job", "consumer").body;
  assert.equal(attr(job, "name"), '"caj-consumer"');
  assert.equal(attr(job, "container_app_environment_id"), "azurerm_container_app_environment.lab.id");
  assert.equal(attr(job, "replica_retry_limit"), "0", "a failed run is not retried: the message's own redelivery is the retry");
  assert.ok(Number(attr(job, "replica_timeout_in_seconds")) <= 300, "a run is short");
  assert.equal(nested(job, "schedule_trigger_config"), undefined);
  assert.equal(nested(job, "manual_trigger_config"), undefined);
  const trigger = nested(job, "event_trigger_config");
  assert.ok(trigger, "event-driven");
  const scale = nested(trigger, "scale");
  assert.equal(attr(scale, "min_executions"), "0", "nothing runs (or bills) while the queues are empty");
  assert.ok(Number(attr(scale, "max_executions")) <= 3);
  assert.equal(attr(scale, "polling_interval_in_seconds"), "30");
  const rules = allNested(scale, "rules");
  assert.equal(rules.length, 2, "a KEDA rule per queue");
  const queuesWatched = [];
  for (const r of rules) {
    assert.equal(attr(r, "custom_rule_type"), '"azure-servicebus"');
    const meta = /metadata\s*=\s*\{([^}]*)\}/.exec(r)?.[1];
    assert.ok(meta, "a metadata map");
    const q = /queueName\s*=\s*(azurerm_servicebus_queue\.[a-z_]+\.name)/.exec(meta)?.[1];
    assert.ok(q, "queueName names a queue by reference");
    queuesWatched.push(q);
    assert.match(meta, /namespace\s*=\s*azurerm_servicebus_namespace\.sb\.name/);
    assert.match(meta, /messageCount\s*=\s*"1"/);
    const auth = nested(r, "authentication");
    assert.equal(attr(auth, "secret_name"), '"sb-scaler"');
    assert.equal(attr(auth, "trigger_parameter"), '"connection"');
    assert.equal(attr(r, "identity_id"), undefined, "no managed identity: it would need a Service Bus data role");
  }
  assert.deepEqual(queuesWatched.sort(), ["azurerm_servicebus_queue.blob_events.name", "azurerm_servicebus_queue.orders.name"]);
  // The two keys are Container Apps secrets, from the two policies' connection strings.
  const secrets = Object.fromEntries(allNested(job, "secret").map((s) => [unq(attr(s, "name")), attr(s, "value")]));
  assert.deepEqual(secrets, {
    "sb-listen": "azurerm_servicebus_namespace_authorization_rule.consumer.primary_connection_string",
    "sb-scaler": "azurerm_servicebus_namespace_authorization_rule.scaler.primary_connection_string",
  });
  const container = nested(nested(job, "template"), "container");
  assert.equal(attr(container, "image"), '"mcr.microsoft.com/azurelinux/base/python:3.12"', "Microsoft's Python image from MCR: no registry, no image build");
  assert.equal(attr(container, "command"), '["python3", "-c", file("${path.module}/consumer.py")]');
  const envs = Object.fromEntries(allNested(container, "env").map((e) => [unq(attr(e, "name")), { value: attr(e, "value"), secret: attr(e, "secret_name") }]));
  assert.deepEqual(envs.SB_CONNECTION, { value: undefined, secret: '"sb-listen"' }, "the consumer gets the Listen key only");
  assert.deepEqual(envs.QUEUES, { value: '"${azurerm_servicebus_queue.orders.name},${azurerm_servicebus_queue.blob_events.name}"', secret: undefined });
  assert.equal(envs.SB_SCHEME, undefined, "SB_SCHEME is only for the tests' fake Service Bus");
  assert.equal(nested(job, "registry"), undefined);
});

test(`${L30}: the workspace is capped and deleted for good on tear-down`, () => {
  const l = lab(L30);
  const w = res(l, "azurerm_log_analytics_workspace", "lab").body;
  assert.equal(attr(w, "sku"), '"PerGB2018"');
  assert.equal(attr(w, "daily_quota_gb"), "0.05");
  assert.equal(attr(w, "retention_in_days"), "30");
  assert.equal(attr(nested(features(l), "log_analytics_workspace"), "permanently_delete_on_destroy"), "true");
  assert.equal(attr(nested(features(l), "resource_group"), "prevent_deletion_if_contains_resources"), "false");
});

test(`${L30}: no secret reaches an output, and outputs name the namespace, the upload container and the job`, () => {
  const l = lab(L30);
  const outs = l.blocks.filter((b) => b.kind === "output");
  assert.deepEqual(outs.map((o) => o.labels[0]).sort(), ["connect", "private_ips"]);
  for (const o of outs) {
    assert.doesNotMatch(o.body, /connection_string|_key\b|primary_key|secondary_key|secret|sensitive/i, `${o.labels[0]} holds no key or connection string`);
  }
  const connect = output(l, "connect").body;
  assert.match(connect, /azurerm_servicebus_namespace\.sb\.name/);
  assert.match(connect, /azurerm_storage_account\.events\.primary_blob_endpoint/);
  assert.match(connect, /azurerm_container_app_job\.consumer\.name/);
  assert.equal(attr(output(l, "private_ips").body, "value"), "{}");
  // And no plan attribute marked sensitive is read anywhere but a Container Apps secret.
  const uses = [...code(l).matchAll(/\.(primary_connection_string|secondary_connection_string|primary_key|secondary_key|default_primary_connection_string|default_primary_key|primary_access_key)\b/g)];
  assert.equal(uses.length, 2, "only the two secrets read a key");
});

test(`${L30}: lab.yaml: AZ-305 infrastructure, expert, no peering or subnets, no identity, the Service Bus base charge authored`, () => {
  const { yaml } = lab(L30);
  assert.equal(yaml.exam, "AZ-305");
  assert.deepEqual(yaml.skill_areas, ["az305.infra"]);
  assert.equal(yaml.level, "expert");
  assert.equal(yaml.type, "explore");
  assert.deepEqual(yaml.prerequisites, ["az104-11-containers"]);
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual(yaml.capacity, { vm_sizes: [] });
  const sb = yaml.cost.items.find((i) => /Service Bus/.test(i.name) && /Standard/.test(i.name));
  assert.ok(sb, "a Service Bus Standard item");
  // "Standard Base Unit" has a 1/Month (£7.5475) and a 1/Hour (£0.0101) row in uksouth: two prices, so authored (ruling 2).
  assert.equal(sb.retail, undefined, "authored: the meter has two uksouth prices");
  assert.ok(sb.gbp_h >= 0.0101 && sb.gbp_h <= 0.0105, `about £0.0101-£0.0104/h (${sb.gbp_h})`);
  for (const i of yaml.cost.items) assert.equal(i.retail, undefined, `${i.name}: authored`);
  assert.ok(yaml.cost.items.some((i) => /Event Grid/.test(i.name)));
  assert.ok(yaml.cost.items.some((i) => /Container Apps/.test(i.name) && i.gbp_h === 0));
  assert.equal(yaml.cost.pricey, null);
});

// The first release test (2026-10-07): deploy 4m 1s, destroy 29m 2s (the Container Apps environment's delete, about
// 28 minutes, even with no VNet). Rounded up: 5 and 30.
test(`${L30}: timing is the release test's, rounded up, and the readme and job timeout follow it`, () => {
  const l = lab(L30);
  assert.deepEqual(l.yaml.timing, { deploy_min: 5, destroy_min: 30, session_h: 2, max_h: 6 });
  assert.equal(timeoutMin(l.yaml.timing), 90, "job timeout: 2 x (5 + 30) + 20");
  assert.match(l.readme, /Deploying takes about 5 minutes/);
  assert.match(l.readme, /Tear-down takes about 30/);
});

test(`${L30}: the readme teaches queues against topics, filters and $Default, dead-lettering, and says why there is no Functions app`, () => {
  const r = lab(L30).readme;
  assert.match(r, /Service Bus Explorer/);
  assert.match(r, /\*\*Access key\*\*/, "the portal's Explorer needs the access-key option: no data role is assigned");
  assert.match(r, /dead-letter/i);
  assert.match(r, /MaxDeliveryCountExceeded/);
  assert.match(r, /\bfail\b/);
  assert.match(r, /\$Default/);
  assert.match(r, /priority = 'high'/);
  assert.match(r, /KEDA/);
  assert.match(r, /App Service/);
  assert.match(r, /Functions/);
  assert.match(r, /## Not built here/);
  assert.match(r, /Event Hubs/);
  assert.match(r, /Premium/);
  assert.match(r, /ContainerAppConsoleLogs_CL/);
  assert.match(r, /about £0\.01 an hour|£0\.0101/);
});

test(`${L30}: the realistic plan passes the scope check, and a Service Bus data role or a key in an output would not slip by unnoticed`, () => {
  const d = LAB_PLANS[L30];
  assert.ok(d, "a plan fixture");
  assert.deepEqual(checkPlan(d.plan, L30), []);
  const types = new Set(d.resources.map((r) => r.address.split(".")[0]));
  for (const t of LAB30_TYPES) assert.ok(types.has(t), `the fixture plans ${t}`);
  // The job's secrets: their values known only after apply, and the block sensitive as a whole (as the first
  // release test's real plan printed it, 2026-10-07).
  const job = d.plan.resource_changes.find((c) => c.address === "azurerm_container_app_job.consumer").change;
  assert.deepEqual(job.after_unknown.secret, [{ value: true }, { value: true }]);
  assert.equal(job.after_sensitive.secret, true);
  assert.deepEqual(job.after.secret.map((s) => s.name), ["sb-listen", "sb-scaler"]);
  assert.ok(job.after.secret.every((s) => !("value" in s)), "no value in the plan's after");
});

// ── The consumer's Python, against a fake Service Bus ────────────────────

const PY = ["python3", "python"].find((p) => spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0);
const CONSUMER = fileURLToPath(new URL(`../../labs/${L30}/terraform/consumer.py`, import.meta.url));

/**
 * A fake Service Bus queue service speaking the REST runtime API the consumer uses: peek-lock
 * (POST /<queue>/messages/head → 201 with BrokerProperties and Location, or 204), complete (DELETE Location).
 * Every request's SAS token is checked against the key, as Service Bus does.
 */
function fakeServiceBus(key, queues) {
  const log = [];
  const locked = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const auth = req.headers.authorization ?? "";
    const m = /^SharedAccessSignature (.+)$/.exec(auth);
    const p = new URLSearchParams(m ? m[1] : "");
    // The signature is over the URL-encoded resource as sent, a newline and the expiry.
    const raw = Object.fromEntries((m ? m[1] : "").split("&").map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]));
    const want = createHmac("sha256", key).update(`${raw.sr}\n${raw.se}`).digest("base64");
    const queue = url.pathname.split("/")[1];
    const scope = decodeURIComponent(raw.sr ?? "");
    const ok = p.get("sig") === want && p.get("skn") === "consumer" && Number(p.get("se")) > Date.now() / 1000 && scope === `https://${req.headers.host}/${queue}`;
    log.push({ method: req.method, path: url.pathname, ok, scope });
    if (!ok) return res.writeHead(401).end("bad token");
    const q = queues[queue];
    if (!q) return res.writeHead(404).end();
    if (req.method === "POST" && url.pathname === `/${queue}/messages/head`) {
      const msg = q.find((x) => !locked.has(x.id));
      if (!msg) return res.writeHead(204).end();
      locked.add(msg.id);
      msg.deliveries = (msg.deliveries ?? 0) + 1;
      res.writeHead(201, {
        BrokerProperties: JSON.stringify({ MessageId: msg.id, DeliveryCount: msg.deliveries, LockToken: `lock-${msg.id}`, SequenceNumber: 1 }),
        Location: `http://${req.headers.host}/${queue}/messages/${msg.id}/lock-${msg.id}`,
        "Content-Type": "application/json",
      });
      return res.end(msg.body);
    }
    const del = new RegExp(`^/${queue}/messages/([^/]+)/lock-([^/]+)$`).exec(url.pathname);
    if (req.method === "DELETE" && del) {
      const i = q.findIndex((x) => x.id === del[1]);
      if (i < 0) return res.writeHead(404).end();
      q.splice(i, 1);
      return res.writeHead(200).end();
    }
    return res.writeHead(400).end();
  });
  return { server, log };
}

test(`${L30}: the consumer completes ordinary messages and Event Grid events, and leaves a message asking to fail to be redelivered`, { skip: PY ? false : "python3 is not installed" }, async () => {
  const key = "c2VjcmV0LWtleS1mb3ItdGhlLXRlc3Q=";
  const event = JSON.stringify({ id: "e1", eventType: "Microsoft.Storage.BlobCreated", subject: "/blobServices/default/containers/uploads/blobs/hello.txt", data: { url: "https://x/uploads/hello.txt" } });
  const queues = {
    orders: [
      { id: "m1", body: "order 1: two coffees" },
      { id: "m2", body: "please FAIL this one" },
      { id: "m3", body: "order 3" },
    ],
    "blob-events": [{ id: "e1", body: event }],
  };
  const { server, log } = fakeServiceBus(key, queues);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(PY, ["-c", readFileSync(CONSUMER, "utf8")], {
        env: { ...process.env, SB_CONNECTION: `Endpoint=sb://127.0.0.1:${port}/;SharedAccessKeyName=consumer;SharedAccessKey=${key}`, QUEUES: "orders,blob-events", SB_SCHEME: "http" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill(), 30_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, out });
      });
    });
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(log.filter((x) => !x.ok), [], "every request carries a valid SAS token scoped to its queue");
    assert.deepEqual(queues.orders.map((m) => m.id), ["m2"], "m1 and m3 completed; m2 left locked, to come back");
    assert.deepEqual(queues["blob-events"], [], "the event completed");
    assert.match(run.out, /orders: completed message m1 \(delivery 1\): order 1: two coffees/);
    assert.match(run.out, /orders: message m2 \(delivery 1\) asks to fail/);
    assert.match(run.out, /blob-events: completed message e1 \(delivery 1\): Microsoft\.Storage\.BlobCreated \/blobServices\/default\/containers\/uploads\/blobs\/hello\.txt/);
    assert.match(run.out, /orders: 2 completed/);
    assert.doesNotMatch(run.out, new RegExp(key), "the key is never printed");
  } finally {
    server.close();
  }
});

test(`${L30}: the consumer exits 1 (a Failed execution) when Service Bus refuses its token`, { skip: PY ? false : "python3 is not installed" }, async () => {
  const { server } = fakeServiceBus("the-right-key", { orders: [{ id: "m1", body: "x" }] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(PY, ["-c", readFileSync(CONSUMER, "utf8")], {
        env: { ...process.env, SB_CONNECTION: `Endpoint=sb://127.0.0.1:${port}/;SharedAccessKeyName=consumer;SharedAccessKey=the-wrong-key`, QUEUES: "orders", SB_SCHEME: "http" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (status) => resolve({ status, out }));
    });
    assert.equal(run.status, 1, run.out);
    assert.match(run.out, /orders: receive failed, HTTP 401/);
    assert.doesNotMatch(run.out, /the-wrong-key/);
  } finally {
    server.close();
  }
});
