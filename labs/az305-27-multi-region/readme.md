One small web app running in two Azure regions, with two global front ends in front of it: Traffic Manager, which fails over by changing DNS answers, and Front Door Standard, a reverse proxy at Microsoft's edge that fails over between origins. Stop one region and watch each move to the other. From the AZ-305 outline: design network solutions (recommend a load-balancing and routing solution, and a connectivity solution that connects Azure resources to the internet), design compute solutions (recommend a container-based solution) and design for high availability (recommend a high availability solution for compute).

Deploy this lab in uksouth: its second region is ukwest, uksouth's Azure pair. Besides `rg-lab-az305-27-multi-region` it makes a second resource group in ukwest, `rg-lab-az305-27-multi-region-secondary`, which holds the ukwest container group. Traffic Manager and Front Door are global, so they live in `rg-lab-az305-27-multi-region`.

This lab also counts for AZ-700, in Design and implement application delivery services. From the AZ-700 outline: design and implement Azure Traffic Manager (routing methods and endpoints) and Azure Front Door (endpoints, routes, origin groups and origins). For more, lab 42 builds Front Door Premium with rules, caching, a WAF policy and a Private Link origin.

## What it deploys

- `ci-uks` in `rg-lab-az305-27-multi-region` (uksouth) and `ci-ukw` in `rg-lab-az305-27-multi-region-secondary` (ukwest): Azure Container Instances groups of 0.5 vCPU and 0.5 GB, each running Microsoft's Azure Linux Python image, which writes `Hello from <region>` into a page and serves it with `python3 -m http.server` on port 80. Each has a public IP and a DNS name, `<prefix>-uks.uksouth.azurecontainer.io` and `<prefix>-ukw.ukwest.azurecontainer.io`
- A Traffic Manager profile, `<prefix>-tm.trafficmanager.net`: Priority routing over two external endpoints (`ci-uks` first), HTTP checks on `/` every 30 seconds, a 30-second DNS TTL
- A Front Door Standard profile, `afd-lab`, with one endpoint (`<prefix>-afd-<hash>.z01.azurefd.net`), one origin group holding both containers (`ci-uks` at priority 1, probed every 100 seconds), and one route for `/*` that takes HTTP and HTTPS and forwards HTTP. No caching, no WAF policy, no custom domain

There is no VNet and nothing to peer: everything here is public by nature, so open the Connect URLs in a browser. The containers' own URLs answer within a few minutes of the deploy, but Front Door's edge can take several more minutes to serve a new endpoint, so a 404 from it at first is normal. Front Door Standard has a base fee of about £26 a month per profile, billed for each hour, or part hour, the profile exists: about £0.04 an hour, the biggest part of this lab's cost. App Service would be the usual home for an app like this, but the subscription has no App Service quota, so the app runs in container instances.

```text
                 you (browser, curl)
                  |                   |
   DNS: <prefix>-tm.trafficmanager.net   https://<prefix>-afd-<hash>.z01.azurefd.net
   Traffic Manager (Priority, global)    Front Door Standard (edge proxy, global)
       | 1               | 2                 | 1                | 2
rg-lab-<id> (uksouth)            rg-lab-<id>-secondary (ukwest)
  ci-uks (ACI, public, :80)        ci-ukw (ACI, public, :80)
  "Hello from uksouth"             "Hello from ukwest"
```

## Things to try

- Open all four Connect URLs. Then stop the uksouth app from Cloud Shell: `az container stop -g rg-lab-az305-27-multi-region -n ci-uks`. Watch the Traffic Manager profile's endpoint go **Degraded** after about 90 seconds, and `nslookup <prefix>-tm.trafficmanager.net` start answering with ci-ukw's name (once the 30-second TTL runs out). Start it again with `az container start` and watch both come back.
- With `ci-uks` stopped, reload the Front Door URL: requests that hit an unhealthy origin fail until the edge's probes (every 100 seconds, 3 of the last 4) mark it down, then every request goes to ukwest. Compare which front end moved first and why: a DNS answer cached by clients against a proxy that decides per request.
- Change the Traffic Manager profile's routing to **Weighted** (50/50) or **Performance**, and Front Door's origins to equal priority with weights, and see how each spreads load rather than failing over.
- Why the app must ignore the Host header: a browser asks Traffic Manager's name for the page, and the container answers whatever the Host header says. App Service would refuse a host name it has not been told about, which is why App Service behind Traffic Manager needs a custom domain; Front Door sends each origin its own host name instead (`origin_host_header`).
- Sketch the design choices: Traffic Manager for any protocol and DNS-level failover, Front Door for HTTP with TLS at the edge, caching and a WAF (Premium adds private origins), and what a real app would also need: data replicated to the second region.

## Learn more

- [What is Traffic Manager?](https://learn.microsoft.com/azure/traffic-manager/traffic-manager-overview)
- [Traffic Manager routing methods](https://learn.microsoft.com/azure/traffic-manager/traffic-manager-routing-methods)
- [Traffic Manager endpoint monitoring](https://learn.microsoft.com/azure/traffic-manager/traffic-manager-monitoring)
- [What is Azure Front Door?](https://learn.microsoft.com/azure/frontdoor/front-door-overview)
- [Origins and origin groups in Azure Front Door](https://learn.microsoft.com/azure/frontdoor/origin)
- [Health probes in Azure Front Door](https://learn.microsoft.com/azure/frontdoor/health-probes)
- [Understand Azure Front Door billing](https://learn.microsoft.com/azure/frontdoor/billing)
- [Load-balancing options](https://learn.microsoft.com/azure/architecture/guide/technology-choices/load-balancing-overview)
- [What is Azure Container Instances?](https://learn.microsoft.com/azure/container-instances/container-instances-overview)

Anything you build by hand inside `rg-lab-az305-27-multi-region` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-27-multi-region-`.
