A classic three-tier web app built without App Service: a web tier and an app tier in Azure Container Apps, and an Azure SQL database as the data tier. Only Front Door reaches the web tier, through a WAF policy; only the web tier reaches the app tier; only the app tier's VNet reaches the database, through a private endpoint. Follow a request through all three tiers, then try to get round each guard. From the AZ-305 outline: design compute solutions (recommend a container-based solution), design an application architecture, design network solutions (optimize network security; load balancing and routing) and design data storage for relational data (recommend a database service tier and compute tier).

Why no App Service, and why DTU: this subscription has no App Service quota and no SQL vCore quota in UK South, so the tiers run in Container Apps and the database is Basic (DTU). The design is the same one you would draw with App Service and a vCore database; **Not built here** says what would change.

## What it deploys

- `vnet-lab` (the first /20 of the session's address slot) with `snet-apps` (a /24 delegated to `Microsoft.App/environments`) and `snet-pe` (a /24 for the private endpoint)
- `cae-lab`: a Container Apps **workload-profiles** environment in `snet-apps`, with the **Consumption** profile only (no Dedicated plan management fee) and external ingress. Azure makes a group of its own for the environment's load balancer and two public IPs; this lab names it `rg-lab-az305-28-three-tier-infra`, and Azure deletes it with the environment
- **Web tier**, `ca-web`: a Container App with public HTTPS ingress that scales to zero. Its small Python server refuses with **403** any request that does not carry this lab's Front Door profile id in the `X-Azure-FDID` header, so it answers only through Front Door, and calls the app tier at `http://ca-app`
- **App tier**, `ca-app`: a Container App with **internal** ingress only, always one replica. Its `api` container looks up the SQL server's name, tries TCP 1433 and shows the last query result; its `sqltools` sidecar (Microsoft's SQL Server image, used only for `sqlcmd`; the engine never starts) logs in to `appdb` once a minute and writes the answer to a shared `EmptyDir` volume. The SQL password reaches it only as a Container Apps **secret** (`sql-password`), never as an output or a plain setting
- **Data tier**: the logical server `<prefix>-sql` with the SQL login `labadmin` (its password is behind **Show**), **public network access off**, and `appdb`, **Basic** (5 DTU). One private endpoint in `snet-pe`, and the zone `privatelink.database.windows.net` linked to `vnet-lab`, so inside the VNet the server's name resolves to the endpoint's private address
- **Front Door Standard**, `afd-lab`: one endpoint (`<prefix>-afd-<hash>.z01.azurefd.net`), one route for `/*` that redirects HTTP to HTTPS and talks HTTPS to one origin, the web tier (sent its own host name, which Container Apps routes by). One origin, so no health probe: probes from every edge would keep the web tier awake
- A WAF policy, `waflab`, **Standard**, in **Prevention** mode, with two custom rules: `BlockAdminPath` (anything under `/admin` is blocked) and `RateLimitPerClient` (over 100 requests a minute from one address is blocked). Front Door Standard takes custom rules (match, rate limit, geo) but not Microsoft's managed rule sets or bot protection: those need **Premium**

Everything is public by nature or private by design: nothing is peered. Open the Connect URLs in a browser; Front Door's edge can take several minutes to serve a new endpoint, so a 404 from it at first is normal, and the first request after a quiet spell waits a few seconds while the web tier starts a replica. Front Door Standard has a base fee of about £26 a month per profile, billed for each hour, or part hour, the profile exists: about £0.04 an hour, the biggest part of this lab's cost. The environment's two public IPs and load balancer are billed too (about £0.03 an hour together), because the environment lives in a VNet of its own.

```text
you (browser, curl)
  | https://<prefix>-afd-<hash>.z01.azurefd.net
Front Door Standard (global) + WAF policy waflab (custom rules: /admin, rate limit)
  | HTTPS, X-Azure-FDID: <profile id>
rg-lab-<id>
  vnet-lab (slot /20)
    snet-apps  cae-lab (workload profiles, Consumption)    [platform: rg-lab-<id>-infra]
      ca-web  external ingress, 403 without the header
        | http://ca-app
      ca-app  internal ingress: api + sqltools sidecar (secret sql-password)
        | TCP 1433, <prefix>-sql.database.windows.net -> private address
    snet-pe    pe-<prefix>-sql  -->  <prefix>-sql / appdb (Basic, public access off)
  privatelink.database.windows.net --link--> vnet-lab
```

## Things to try

- Open the Front Door URL and read the page: the web tier's line, then the app tier's (the server's name resolving to a `10.x` address, TCP 1433 open) and the database's answer. Then open the web tier's own URL (the second Connect line): the same app refuses you with 403, because the request did not come through Front Door. Why is a header check needed at all, when Front Door Premium could reach a private origin over Private Link instead?
- Request `/admin` through Front Door (the third Connect line) and get the WAF's 403. Then hammer the endpoint, for example `for i in $(seq 150); do curl -s -o /dev/null -w "%{http_code} " https://<endpoint>/; done`, and watch the rate limit turn 200s into 403s. In the portal, switch the policy to **Detection** and repeat: nothing is blocked, and only the logs would say so. Open **Managed rules** on the policy and see why it is greyed out on Standard.
- Open a shell in the sidecar with `az containerapp exec -g rg-lab-az305-28-three-tier -n ca-app --container sqltools --command bash` (the last Connect line), then run `/opt/mssql-tools18/bin/sqlcmd -S tcp:$SQLCMDSERVER,1433 -Q "SELECT @@VERSION"` (the server, user, database and password come from the container's settings, the password from the app's secret). Create a table in `appdb`, insert a row, and check the app's page shows the sidecar still connecting. Run `getent hosts $SQLCMDSERVER` to see the private address.
- Prove each guard: from Cloud Shell, `nslookup <prefix>-sql.database.windows.net` gives a public address that refuses you (public network access is off), and `az containerapp show -g rg-lab-az305-28-three-tier -n ca-app --query properties.configuration.ingress` shows the app tier has no external ingress. In the portal, look at `rg-lab-az305-28-three-tier-infra`: which of its resources are you billed for?
- Look at `ca-app`'s **Secrets** and **Containers** blades: the secret's value is hidden, and `SQLCMDPASSWORD` is a secret reference. Sketch the better design: a managed identity for the app tier, set as a contained database user, and no password at all. Why does that need a step after deploy (a T-SQL `CREATE USER ... FROM EXTERNAL PROVIDER`) that this pipeline never runs?
- Open **Compute + storage** on `appdb` and compare DTU tiers with vCore General Purpose and serverless; then change the web tier's **Scale** rule (for example a minimum of one replica) and think about what each tier's scale unit is.

## Not built here

- **App Service** for the web and app tiers (a plan, two web apps, VNet integration for the app tier, access restrictions on the service tag `AzureFrontDoor.Backend` plus the `X-Azure-FDID` header) and **vCore** SQL: this subscription has no quota for either in UK South. Lab 23 builds serverless vCore in UK West.
- **Front Door Premium** adds Microsoft's managed rule sets, bot protection and Private Link origins, so the web tier could have no public ingress at all; lab 42 builds those, at about ten times this lab's Front Door fee.

## Learn more

- [N-tier architecture style](https://learn.microsoft.com/azure/architecture/guide/architecture-styles/n-tier)
- [Workload profiles in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/workload-profiles-overview)
- [Configure virtual networks in Azure Container Apps environments](https://learn.microsoft.com/azure/container-apps/custom-virtual-networks)
- [Ingress in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/ingress-overview)
- [Communicate between container apps](https://learn.microsoft.com/azure/container-apps/connect-apps)
- [Manage secrets in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/manage-secrets)
- [Billing in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/billing)
- [Secure traffic to Azure Front Door origins](https://learn.microsoft.com/azure/frontdoor/origin-security)
- [Custom rules for Web Application Firewall on Azure Front Door](https://learn.microsoft.com/azure/web-application-firewall/afds/waf-front-door-custom-rules)
- [Compare Azure Front Door tiers](https://learn.microsoft.com/azure/frontdoor/front-door-cdn-comparison)
- [Azure Private Link for Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/private-endpoint-overview)
- [Compare vCore and DTU-based purchasing models of Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/purchasing-models)

`rg-lab-az305-28-three-tier-infra` belongs to the Container Apps platform: Azure deletes it with the environment, and tear-down's safety net removes it if anything is left.

Anything you build by hand inside `rg-lab-az305-28-three-tier` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-28-three-tier-`.
