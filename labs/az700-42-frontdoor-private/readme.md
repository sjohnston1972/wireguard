Front Door Premium in front of a web server with no public address at all: the origin is an internal load balancer that Front Door reaches over Private Link, through a Private Link service you approve. On top: a rule set (a redirect, a response header and a cache override), caching and compression on the route, and a WAF policy with Microsoft's managed rule sets and a rate limit. From the AZ-700 outline, in Design and implement application delivery services: select a Front Door SKU and tier, configure endpoints, routes, origin groups and origins, rule sets, caching and compression, and Private Link for Front Door origins. In Design and implement Azure network security services: configure WAF rule sets and custom rules for Front Door and associate a policy. And in Design and implement private access to Azure services: create a Private Link service.

## What it deploys

- `vnet-app` (the first /20 of the session's address slot) with `snet-web` and `snet-pls`, each a /24; `snet-pls` has Private Link service network policies off, as Private Link needs
- `vm-web`, a Standard_B1s Ubuntu 24.04 VM with no public IP, serving a page at `/` and a file at `/static/hello.txt` with python3's built-in web server
- `lb-int`, an internal Standard load balancer with a fixed frontend (the 10th address of `snet-web`), an HTTP probe and a rule for port 80 to `vm-web`
- `pls-web`, a **Private Link service** on `lb-int`'s frontend, its NAT address in `snet-pls`. It approves nothing by itself
- `afd-premium`, a Front Door **Premium** profile with one endpoint (`<prefix>-afd-<hash>.z01.azurefd.net`), an origin group probing `/` over HTTP every 100 seconds, and one origin: `lb-int`'s private address, reached through a private endpoint Front Door makes on `pls-web` in the lab's region
- One route for `/*`: HTTP redirected to HTTPS (Front Door's own certificate), forwarded to the origin over HTTP, with caching (query strings ignored) and compression on
- `ruleslab42`, a rule set on the route: `redirectold` sends `/old` to `/` (301), `addheader` puts `X-Lab: 42` on every response, and `cachestatic` keeps anything under `/static/` in the edge cache for an hour, whatever the origin says
- `wafpremium`, a Premium WAF policy in **Prevention** mode with the Microsoft Default Rule Set 2.1, the Bot Manager rule set 1.1 and a custom rate-limit rule (more than 100 requests in a minute from one client address is blocked), attached to the endpoint by a security policy, `sp-afd`

The deploy takes about 15 minutes, and Front Door can take several more to serve a new endpoint from every edge. Nothing here is peered: Front Door is the only way in, and `vm-web` has no public address (use the serial console or Run command on it). Front Door Premium's base fee is about £249 a month, billed for each hour, or partial hour, the profile exists: about £0.34 an hour, nearly all of this lab's cost, so tear it down when you finish. Premium's managed WAF rules and Private Link origins cost nothing extra (Learn, Front Door billing).

```text
            you (browser, curl)
                   |  https://<prefix>-afd-<hash>.z01.azurefd.net
   afd-premium (Front Door Premium, global)   wafpremium: DRS 2.1, Bot Manager 1.1, rate limit
     route /* (HTTPS redirect, cache, compress)   ruleslab42: /old -> /, X-Lab: 42, /static/* 1 h
     og-web -> origin-lb-int (host: lb-int's address, HTTP 80)
                   |  Private Link (Front Door's managed private endpoint)
                   |  pending until you approve it
rg-lab-<id>        v
  vnet-app (slot /20)
    snet-pls (/24)   pls-web (NAT address)
    snet-web (/24)   lb-int .10:80 (internal, probe /)  -->  vm-web :80
```

## Things to try

- **First, approve Front Door's connection.** Until you do, Front Door answers 502. Open `pls-web` in the portal, **Private endpoint connections**, select the pending request ("Front Door lab 42 asks to reach pls-web") and **Approve** (or `az network private-link-service connection update --name <connection> --service-name pls-web -g rg-lab-az700-42-frontdoor-private --connection-status Approved`). Allow a few minutes, then browse the endpoint.
- Request `/static/hello.txt` twice with `curl -sI` and compare the `x-cache` header (`TCP_MISS`, then `TCP_HIT`); request `/` and see `X-Lab: 42`; request `/old` and follow the 301. Purge the cache from the endpoint and watch the next request miss again.
- Trigger the WAF: a query string like `?id=1'or'1'='1` gets a 403 from the managed rules, and a loop of more than 100 requests in a minute trips the rate limit. Switch the policy to **Detection** and compare.
- Read `vm-web`'s logs (`journalctl -u lab-http` on the serial console): every request arrives from an address in `snet-pls`, the Private Link service's NAT address, never from the internet.
- Why Premium: Private Link origins and managed rule sets need it; Standard (lab 27) reaches only public origins and has custom WAF rules only. Reject the connection on `pls-web` and see Front Door return 502 again.

## Not built here

A custom domain with Front Door managed certificates (it needs a DNS zone you own), and Private Link origins for Storage or App Service, which work the same way with a `target_type`.

## Learn more

- [What is Azure Front Door?](https://learn.microsoft.com/azure/frontdoor/front-door-overview)
- [Secure your origin with Private Link in Azure Front Door Premium](https://learn.microsoft.com/azure/frontdoor/private-link)
- [Connect Azure Front Door Premium to an internal load balancer origin with Private Link](https://learn.microsoft.com/azure/frontdoor/standard-premium/how-to-enable-private-link-internal-load-balancer)
- [What is a rule set in Azure Front Door?](https://learn.microsoft.com/azure/frontdoor/front-door-rules-engine)
- [Caching with Azure Front Door](https://learn.microsoft.com/azure/frontdoor/front-door-caching)
- [Azure Web Application Firewall on Azure Front Door](https://learn.microsoft.com/azure/web-application-firewall/afds/afds-overview)
- [What is Azure Private Link service?](https://learn.microsoft.com/azure/private-link/private-link-service-overview)
- [Understand Azure Front Door billing](https://learn.microsoft.com/azure/frontdoor/billing)

Anything you build by hand inside `rg-lab-az700-42-frontdoor-private` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-42-frontdoor-private-`.
