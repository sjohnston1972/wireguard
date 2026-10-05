An App Service plan with a web app, a deployment slot and autoscale. Practise choosing and scaling a plan, configuring an
app's TLS settings, and swapping a staging slot into production. From the AZ-104 outline: provision an App Service plan,
configure scaling for an App Service plan, create an App Service, configure certificates and TLS for an App Service, and
configure deployment slots for an App Service.

## What it deploys

- `asp-lab`, a Linux App Service plan on **Premium v3 P0v3** with one instance: the cheapest Linux tier with both deployment slots and autoscale (Basic has neither)
- A web app, `<prefix>-web`, with Node.js 22 as its built-in runtime and no code deployed, so it shows the runtime's start page. It is https only, with TLS 1.2 or later and FTP off
- A deployment slot, `staging`, with the same settings and its own address
- `autoscale-asp-lab`: 1 to 2 plan instances. A second instance when the plan's average **CpuPercentage** over 5 minutes is above 70%, back to one below 25%

The app and the slot are public websites by nature: the lab has no VNet, cannot peer, and has no password. Open the Connect lines in a browser.

```text
rg-lab-<id>
  asp-lab (Linux, P0v3, 1-2 instances) <-- autoscale-asp-lab (avg CPU > 70%: +1, < 25%: -1)
    <prefix>-web          https://<prefix>-web.azurewebsites.net          (production)
      slot staging        https://<prefix>-web-staging.azurewebsites.net
  you --HTTPS--> either address (public, https only)
```

## Things to try

- Give the slot something to show: under the slot's **Environment variables**, add `GREETING` = `staging` and tick **Deployment slot setting**; add `GREETING` = `production` to the app, unticked. Swap the slots under **Deployment slots**, then look at both apps' settings again: the sticky setting stayed with its slot, the other one moved.
- Swap back with **Swap with preview** and see the two phases: settings applied to the source first, then the swap completed or cancelled.
- Scale up the plan to Standard S1 under **Scale up (App Service plan)** and see what changes in the price and features, then back to P0v3. Note that a scale up keeps the same apps and addresses.
- Edit the autoscale setting under **Scale out (App Service plan)**: add a rule on **Http Queue Length** or a schedule profile that runs 2 instances during working hours. Check the run history afterwards.
- Under **Configuration**, look at the TLS settings and the default certificate on the `azurewebsites.net` address, and try plain `http://`: https only redirects it.

## Learn more

- [Azure App Service plan overview](https://learn.microsoft.com/azure/app-service/overview-hosting-plans)
- [Set up staging environments in Azure App Service](https://learn.microsoft.com/azure/app-service/deploy-staging-slots)
- [Scale up an app in Azure App Service](https://learn.microsoft.com/azure/app-service/manage-scale-up)
- [Get started with autoscale in Azure](https://learn.microsoft.com/azure/azure-monitor/autoscale/autoscale-get-started)
- [Configure an App Service app](https://learn.microsoft.com/azure/app-service/configure-common)
- [Azure App Service TLS overview](https://learn.microsoft.com/azure/app-service/overview-tls)

Anything you build by hand inside `rg-lab-az104-10-app-service` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-10-app-service-`.
