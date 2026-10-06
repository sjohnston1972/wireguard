// shared/topology/armTemplate.ts
//
// Plain English: Bicep labs' resources for the planned diagram (lab topology
// spec ruling 24). A Bicep lab's Terraform deploys one compiled ARM template
// (azurerm_resource_group_template_deployment); the mock plan knows the
// template and its parameters, but not what is inside. This is a minimal ARM
// template evaluator, enough for that: parameters (with defaults), variables,
// format(), concat(), resourceGroup().location, resourceId(), copy loops
// (resource and property), copyIndex(), length(), cidrSubnet() and a few
// plain helpers, and nested Microsoft.Resources/deployments with inline
// templates. Anything else throws UnsupportedArm naming the expression, so a
// new Bicep lab can never silently lose resources from its diagram; outputs
// are never evaluated (they need reference(), which only a real deployment has).
//
// resourceId(type, name, ...) gives "/providers/<type>/<name>/..." here, so a
// property naming another resource (a subnet's NSG) can be matched by type
// and name.

import type { TfInst } from "./rules/planned";

export interface ArmResource {
  type: string;
  name: string;
  /** ARM "type/name" of each dependency (from dependsOn). */
  dependsOn: string[];
  properties: Record<string, unknown>;
  location?: string;
  kind?: string;
  sku?: Record<string, unknown>;
  /** "type/name" of every resource named by id inside its properties. */
  refs: string[];
  /** [vnet, subnet] of every subnet named by id inside its properties. */
  subnetRefs: [string, string][];
}

export class UnsupportedArm extends Error {
  constructor(readonly expression: string) {
    super(`the planned diagram cannot evaluate this ARM template expression: ${expression}`);
    this.name = "UnsupportedArm";
  }
}

export interface ArmCtx {
  parameters: Record<string, unknown>;
  variables: Record<string, unknown>;
  location: string;
  /** copyIndex values by loop name ("" for the resource loop). */
  copy?: Record<string, number>;
  /** Variables still to evaluate (lazy), and the template's own variable definitions. */
  rawVariables?: Record<string, unknown>;
}

// ── Expressions ──────────────────────────────────────────────────────────

type Tok = { t: "str"; v: string } | { t: "num"; v: number } | { t: "id"; v: string } | { t: "p"; v: string };

function tokenize(s: string, whole: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "'") {
      let v = "";
      i++;
      for (;;) {
        if (i >= s.length) throw new UnsupportedArm(whole);
        if (s[i] === "'" && s[i + 1] === "'") {
          v += "'";
          i += 2;
        } else if (s[i] === "'") {
          i++;
          break;
        } else v += s[i++];
      }
      out.push({ t: "str", v });
    } else if (/[0-9-]/.test(c)) {
      const m = /^-?\d+/.exec(s.slice(i));
      if (!m) throw new UnsupportedArm(whole);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else if ("(),.[]".includes(c)) {
      out.push({ t: "p", v: c });
      i++;
    } else throw new UnsupportedArm(whole);
  }
  return out;
}

const ipToInt = (ip: string): number => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const intToIp = (n: number): string => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");

function cidrSubnet(network: string, bits: number, index: number): string {
  const [ip, len] = network.split("/");
  const base = ipToInt(ip ?? "0.0.0.0");
  const size = 2 ** (32 - bits);
  if (!(bits >= Number(len)) || bits > 32) throw new UnsupportedArm(`cidrSubnet('${network}', ${bits}, ${index})`);
  return `${intToIp(base - (base % 2 ** (32 - Number(len))) + index * size)}/${bits}`;
}

function evalTokens(toks: Tok[], ctx: ArmCtx, whole: string): unknown {
  let i = 0;
  const peek = () => toks[i];
  const take = (v?: string) => {
    const t = toks[i++];
    if (!t || (v !== undefined && !(t.t === "p" && t.v === v))) throw new UnsupportedArm(whole);
    return t;
  };
  const expr = (): unknown => {
    const t = take();
    let v: unknown;
    if (t.t === "str" || t.t === "num") v = t.v;
    else if (t.t === "id") {
      take("(");
      const args: unknown[] = [];
      if (!(peek()?.t === "p" && peek()!.v === ")")) {
        args.push(expr());
        while (peek()?.t === "p" && peek()!.v === ",") {
          take(",");
          args.push(expr());
        }
      }
      take(")");
      v = call(t.v, args, ctx, whole);
    } else throw new UnsupportedArm(whole);
    // Property access and indexing.
    for (;;) {
      const p = peek();
      if (p?.t === "p" && p.v === ".") {
        take(".");
        const name = take();
        if (name.t !== "id") throw new UnsupportedArm(whole);
        v = (v as Record<string, unknown> | null)?.[name.v];
      } else if (p?.t === "p" && p.v === "[") {
        take("[");
        const k = expr();
        take("]");
        v = (v as Record<string | number, unknown> | null)?.[k as string | number];
      } else break;
    }
    return v;
  };
  const v = expr();
  if (i !== toks.length) throw new UnsupportedArm(whole);
  return v;
}

function variable(name: string, ctx: ArmCtx, whole: string): unknown {
  if (Object.hasOwn(ctx.variables, name)) return ctx.variables[name];
  if (ctx.rawVariables && Object.hasOwn(ctx.rawVariables, name)) {
    const v = evaluateDeep(ctx.rawVariables[name], ctx);
    ctx.variables[name] = v;
    return v;
  }
  throw new UnsupportedArm(whole);
}

function call(fn: string, a: unknown[], ctx: ArmCtx, whole: string): unknown {
  const f = fn.toLowerCase();
  const s = (x: unknown) => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : JSON.stringify(x));
  switch (f) {
    case "parameters":
      if (!Object.hasOwn(ctx.parameters, String(a[0]))) throw new UnsupportedArm(whole);
      return ctx.parameters[String(a[0])];
    case "variables":
      return variable(String(a[0]), ctx, whole);
    case "format":
      return String(a[0]).replace(/\{(\d+)(:[^}]*)?\}/g, (_m, n: string) => s(a[Number(n) + 1]));
    case "concat":
      return a.every(Array.isArray) && a.length ? (a as unknown[][]).flat() : a.map(s).join("");
    case "resourcegroup":
      return { location: ctx.location };
    case "resourceid": {
      if (a.length < 2 || typeof a[0] !== "string" || !/^[A-Za-z]+\.[A-Za-z]+\//.test(a[0])) throw new UnsupportedArm(whole);
      const [ns, ...types] = (a[0] as string).split("/");
      const names = a.slice(1).map(s);
      if (names.length !== types.length) throw new UnsupportedArm(whole);
      return `/providers/${ns}/${types.map((t, i) => `${t}/${names[i]}`).join("/")}`;
    }
    case "copyindex": {
      const name = typeof a[0] === "string" ? a[0] : "";
      const offset = typeof a[0] === "number" ? a[0] : typeof a[1] === "number" ? a[1] : 0;
      const v = ctx.copy?.[name];
      if (v === undefined) throw new UnsupportedArm(whole);
      return v + offset;
    }
    case "length":
      return Array.isArray(a[0]) || typeof a[0] === "string" ? (a[0] as unknown[] | string).length : a[0] && typeof a[0] === "object" ? Object.keys(a[0]).length : 0;
    case "cidrsubnet":
      return cidrSubnet(String(a[0]), Number(a[1]), Number(a[2]));
    case "tolower":
      return s(a[0]).toLowerCase();
    case "toupper":
      return s(a[0]).toUpperCase();
    case "string":
      return s(a[0]);
    case "int":
      return Number.parseInt(s(a[0]), 10);
    case "add":
      return Number(a[0]) + Number(a[1]);
    case "sub":
      return Number(a[0]) - Number(a[1]);
    case "mul":
      return Number(a[0]) * Number(a[1]);
    case "equals":
      return JSON.stringify(a[0]) === JSON.stringify(a[1]);
    case "not":
      return !a[0];
    case "and":
      return a.every(Boolean);
    case "or":
      return a.some(Boolean);
    case "if":
      return a[0] ? a[1] : a[2];
    case "true":
      return true;
    case "false":
      return false;
    case "empty":
      return a[0] == null || (Array.isArray(a[0]) ? a[0].length === 0 : typeof a[0] === "object" ? Object.keys(a[0] as object).length === 0 : a[0] === "");
    case "createarray":
      return a;
    default:
      throw new UnsupportedArm(whole);
  }
}

/** One template string: "[...]" is an expression, "[[" a literal "[", anything else as it is. */
export function evaluateArm(value: string, ctx: ArmCtx): unknown {
  if (!value.startsWith("[") || !value.endsWith("]")) return value;
  if (value.startsWith("[[")) return value.slice(1);
  const body = value.slice(1, -1);
  return evalTokens(tokenize(body, value), ctx, value);
}

/** A value with every expression inside it evaluated, and property copy loops expanded. */
function evaluateDeep(v: unknown, ctx: ArmCtx): unknown {
  if (typeof v === "string") return evaluateArm(v, ctx);
  if (Array.isArray(v)) return v.map((x) => evaluateDeep(x, ctx));
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (Array.isArray(o.copy)) {
      for (const loop of o.copy as Record<string, unknown>[]) {
        const name = String(loop.name);
        const count = Number(evaluateDeep(loop.count, ctx));
        const items: unknown[] = [];
        for (let i = 0; i < count; i++) items.push(evaluateDeep(loop.input, { ...ctx, copy: { ...(ctx.copy ?? {}), [name]: i } }));
        out[name] = items;
      }
    }
    for (const [k, x] of Object.entries(o)) if (k !== "copy" || !Array.isArray(o.copy)) out[k] = evaluateDeep(x, ctx);
    return out;
  }
  return v;
}

/** Every "/providers/<type>/<name>..." id inside a value: refs as "type/name" and subnets as [vnet, subnet]. */
function idsIn(v: unknown, refs: Set<string>, subnets: Map<string, [string, string]>): void {
  if (typeof v === "string") {
    const m = /\/providers\/([A-Za-z]+\.[A-Za-z]+)\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/]+))?/.exec(v);
    if (!m) return;
    refs.add(`${m[1]}/${m[2]}/${m[3]}`);
    if (m[2]!.toLowerCase() === "virtualnetworks" && m[4]?.toLowerCase() === "subnets") subnets.set(`${m[3]}/${m[5]}`.toLowerCase(), [m[3]!, m[5]!]);
  } else if (Array.isArray(v)) v.forEach((x) => idsIn(x, refs, subnets));
  else if (v && typeof v === "object") for (const x of Object.values(v)) idsIn(x, refs, subnets);
}

const DEPLOYMENTS = "microsoft.resources/deployments";

/**
 * The resources a template makes, given its parameter values (plain values,
 * not { value } wrappers) and the resource group's location. Nested inline
 * deployments are expanded in place (their own entry is not returned).
 */
export function expandTemplate(template: Record<string, unknown>, parameters: Record<string, unknown>, rgLocation: string): ArmResource[] {
  const ctx: ArmCtx = { parameters: {}, variables: {}, location: rgLocation, rawVariables: (template.variables ?? {}) as Record<string, unknown> };
  for (const [name, def] of Object.entries((template.parameters ?? {}) as Record<string, { defaultValue?: unknown }>)) {
    if (Object.hasOwn(parameters, name)) ctx.parameters[name] = parameters[name];
    else if (def && Object.hasOwn(def, "defaultValue")) ctx.parameters[name] = evaluateDeep(def.defaultValue, ctx);
  }
  const list = Array.isArray(template.resources) ? (template.resources as Record<string, unknown>[]) : Object.values((template.resources ?? {}) as Record<string, Record<string, unknown>>);
  const out: ArmResource[] = [];
  for (const r of list) {
    if (r.existing === true) continue;
    const loop = r.copy as { name?: string; count?: unknown } | undefined;
    const count = loop ? Number(evaluateDeep(loop.count, ctx)) : 1;
    for (let i = 0; i < count; i++) {
      const c: ArmCtx = loop ? { ...ctx, copy: { ...(ctx.copy ?? {}), "": i, [String(loop.name ?? "")]: i } } : ctx;
      const type = String(evaluateDeep(r.type, c));
      const props = (r.properties ?? {}) as Record<string, unknown>;
      if (type.toLowerCase() === DEPLOYMENTS) {
        if (props.templateLink || !props.template) throw new UnsupportedArm(`${type} ${String(r.name)}: a linked template or template spec`);
        const inner = (props.expressionEvaluationOptions as { scope?: string } | undefined)?.scope?.toLowerCase() === "inner";
        const p: Record<string, unknown> = {};
        for (const [k, w] of Object.entries((props.parameters ?? {}) as Record<string, { value?: unknown }>)) p[k] = evaluateDeep(w?.value, c);
        // scope outer: the nested template sees the parent's parameters and variables.
        const params = inner ? p : { ...c.parameters, ...p };
        out.push(...expandTemplate(props.template as Record<string, unknown>, params, rgLocation));
        continue;
      }
      const name = String(evaluateDeep(r.name, c));
      const properties = (evaluateDeep(props, c) ?? {}) as Record<string, unknown>;
      const refs = new Set<string>();
      const subnets = new Map<string, [string, string]>();
      idsIn(properties, refs, subnets);
      const dependsOn = ((evaluateDeep(r.dependsOn ?? [], c) as unknown[]) ?? []).map(String).map((d) => {
        const m = /\/providers\/([^/]+\/[^/]+)\/([^/]+)/.exec(d);
        return m ? `${m[1]}/${m[2]}` : d;
      });
      out.push({
        type,
        name,
        dependsOn,
        properties,
        location: typeof r.location === "string" ? String(evaluateDeep(r.location, c)) : undefined,
        kind: typeof r.kind === "string" ? String(evaluateDeep(r.kind, c)) : undefined,
        sku: r.sku ? (evaluateDeep(r.sku, c) as Record<string, unknown>) : undefined,
        refs: [...refs].sort(),
        subnetRefs: [...subnets.values()].sort((a, b) => (a.join("/") < b.join("/") ? -1 : 1)),
      });
    }
  }
  return out;
}

/** A template deployment instance's resources: its template_content with parameters_content (a { name: { value } } map). */
export function expandDeployment(inst: TfInst, rgLocation: string): ArmResource[] {
  const text = inst.after.template_content;
  if (typeof text !== "string") return [];
  const template = JSON.parse(text) as Record<string, unknown>;
  const raw = typeof inst.after.parameters_content === "string" ? (JSON.parse(inst.after.parameters_content) as Record<string, { value?: unknown }>) : {};
  const params = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v?.value]));
  return expandTemplate(template, params, rgLocation);
}
