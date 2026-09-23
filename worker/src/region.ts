// region.ts
//
// Plain English: "which Azure site is closest to me right now?". Cloudflare
// tells the Worker which country each request comes from, so when Steven
// presses Deploy from abroad the dashboard can offer the nearest Azure region
// alongside the usual one. Like picking the nearest POP for a breakout. The
// clients do not change: they still dial wg.clydeford.net, which follows the
// VM wherever it is built.

/** Azure regions the dashboard will offer, with a plain name. All carry Standard_B1s. */
export const REGIONS: Record<string, string> = {
  uksouth: "UK South (London)",
  ukwest: "UK West (Cardiff)",
  northeurope: "North Europe (Dublin)",
  westeurope: "West Europe (Amsterdam)",
  francecentral: "France Central (Paris)",
  germanywestcentral: "Germany West Central (Frankfurt)",
  switzerlandnorth: "Switzerland North (Zurich)",
  italynorth: "Italy North (Milan)",
  spaincentral: "Spain Central (Madrid)",
  norwayeast: "Norway East (Oslo)",
  swedencentral: "Sweden Central (Gävle)",
  polandcentral: "Poland Central (Warsaw)",
  eastus: "East US (Virginia)",
  westus2: "West US 2 (Washington)",
  canadacentral: "Canada Central (Toronto)",
  mexicocentral: "Mexico Central (Querétaro)",
  brazilsouth: "Brazil South (São Paulo)",
  uaenorth: "UAE North (Dubai)",
  southafricanorth: "South Africa North (Johannesburg)",
  centralindia: "Central India (Pune)",
  southeastasia: "Southeast Asia (Singapore)",
  eastasia: "East Asia (Hong Kong)",
  japaneast: "Japan East (Tokyo)",
  koreacentral: "Korea Central (Seoul)",
  australiaeast: "Australia East (Sydney)",
};

const BY_COUNTRY: Record<string, string> = {
  GB: "uksouth", IM: "uksouth", JE: "uksouth", GG: "uksouth",
  IE: "northeurope", IS: "northeurope",
  NL: "westeurope", BE: "westeurope", LU: "westeurope",
  FR: "francecentral", MC: "francecentral",
  DE: "germanywestcentral", AT: "germanywestcentral", CZ: "germanywestcentral",
  CH: "switzerlandnorth", LI: "switzerlandnorth",
  IT: "italynorth", MT: "italynorth", SI: "italynorth", HR: "italynorth",
  ES: "spaincentral", PT: "spaincentral", AD: "spaincentral", GI: "spaincentral",
  NO: "norwayeast",
  SE: "swedencentral", FI: "swedencentral", DK: "swedencentral", EE: "swedencentral", LV: "swedencentral", LT: "swedencentral",
  PL: "polandcentral", SK: "polandcentral", HU: "polandcentral", RO: "polandcentral", BG: "polandcentral", GR: "italynorth", CY: "italynorth", TR: "italynorth",
  CA: "canadacentral", MX: "mexicocentral", BR: "brazilsouth", AR: "brazilsouth", CL: "brazilsouth", UY: "brazilsouth",
  AE: "uaenorth", SA: "uaenorth", QA: "uaenorth", OM: "uaenorth", BH: "uaenorth", KW: "uaenorth", EG: "uaenorth",
  ZA: "southafricanorth", NA: "southafricanorth", BW: "southafricanorth",
  IN: "centralindia", LK: "centralindia",
  SG: "southeastasia", MY: "southeastasia", ID: "southeastasia", TH: "southeastasia", VN: "southeastasia", PH: "southeastasia",
  HK: "eastasia", TW: "eastasia", MO: "eastasia",
  JP: "japaneast", KR: "koreacentral",
  AU: "australiaeast", NZ: "australiaeast",
};

const BY_CONTINENT: Record<string, string> = { EU: "westeurope", NA: "eastus", SA: "brazilsouth", AS: "southeastasia", OC: "australiaeast", AF: "southafricanorth" };

/**
 * The nearest region for a request's Cloudflare geodata. In the US, splits
 * east and west on longitude. Null when Cloudflare gave nothing useful.
 */
export function nearestRegion(cf: { country?: unknown; continent?: unknown; longitude?: unknown } | undefined | null): string | null {
  if (!cf) return null;
  const country = String(cf.country ?? "").toUpperCase();
  if (country === "US") return Number(cf.longitude) < -100 ? "westus2" : "eastus";
  return BY_COUNTRY[country] ?? BY_CONTINENT[String(cf.continent ?? "").toUpperCase()] ?? null;
}

export function regionName(r: string): string {
  return REGIONS[r] ?? r;
}
