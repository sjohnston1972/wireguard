Azure SQL Database across two regions: a Basic database in UK South with a geo-secondary in UK West, a failover group
whose listener follows the primary, and a serverless database that pauses when idle. Practise choosing service and compute
tiers, failing a database over to another region by hand and back, and reaching both servers privately. From the AZ-305
outline: recommend a solution for storing relational data, a database service tier and compute tier, a backup and recovery
solution for databases, and a high availability solution for relational data.

## What it deploys

- Two logical servers with the SQL login `labadmin` (its password is behind **Show**), TLS 1.2 at least, public network access on but **no firewall rules**, so only the private endpoints reach them until you add a rule: `<prefix>-sqlp` in `rg-lab-<id>` (UK South) and `<prefix>-sqls` in `rg-lab-<id>-secondary` (UK West)
- `appdb` on `<prefix>-sqlp`: **Basic** (5 DTU), the primary. The subscription's vCore quota in UK South is 0, so nothing vCore runs in the primary region
- `appdb` on `<prefix>-sqls`: a **Basic geo-secondary** of the primary, readable, kept in step by active geo-replication
- A failover group, `<prefix>-fog`, over `appdb` with **customer-managed (Manual)** failover: nothing moves until you ask. Its read-write listener, `<prefix>-fog.database.windows.net`, always names whichever server is primary; `<prefix>-fog.secondary.database.windows.net` is the read-only listener
- `scratch` on `<prefix>-sqls`: **General Purpose serverless** (`GP_S_Gen5_1`, 0.5 to 1 vCore, 1 GB) with auto-pause after 15 idle minutes. It is outside the failover group and not geo-replicated: auto-pause is not available to a geo-replicated serverless database. It is not the free offer, which a subscription may already be using
- A VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-pe` holding a private endpoint for **each** server (the UK West server's too: an endpoint can reach a resource in another region), and the zone `privatelink.database.windows.net` linked to it, with both endpoints' A records

The lab must be deployed in **UK South**, with **UK West** as its secondary region (its pair). `rg-lab-<id>-secondary` holds the secondary server, the geo-secondary `appdb` and `scratch`; everything else is in `rg-lab-<id>`, and tear-down removes both groups.

Deploy with **Peer to gateway** to connect from a tunnel client: the pipeline links `privatelink.database.windows.net` to the gateway's VNet while peered, and the gateway's tunnel DNS forwards `database.windows.net` names to Azure DNS, so the listener and both servers resolve to the private endpoints. Without peering, use the portal's **Query editor** after adding a firewall rule for your own address.

```text
rg-lab-<id> (UK South)                                rg-lab-<id>-secondary (UK West)
  <prefix>-sqlp                                         <prefix>-sqls
    appdb  Basic, primary  ==== geo-replication ====>     appdb    Basic, geo-secondary
      \__ failover group <prefix>-fog (Manual) __/        scratch  serverless, auto-pause
  vnet-lab (slot /20) / snet-pe
    pe-<prefix>-sqlp  --> <prefix>-sqlp
    pe-<prefix>-sqls  --> <prefix>-sqls (in UK West)
  privatelink.database.windows.net --link--> vnet-lab
     peering (optional) <--> gateway VNet (+ the pipeline's zone link) <--> tunnel <--> you
```

## Things to try

- While peered, run the first Connect line (`sqlcmd` to the listener), create a table in `appdb` and insert a row. Then connect to `appdb` on the secondary server and read the row back: the geo-secondary is readable but refuses writes.
- Run `nslookup` on the listener, then fail the group over: in the portal open the failover group and choose **Failover**, or run `az sql failover-group set-primary` against the secondary server. Look up the listener again (it now points at `<prefix>-sqls`), reconnect through it and write another row. Then fail back. You may tear down while failed over: tear-down deletes the failover group and the geo-replication link first, so it still gets back to £0.
- On the primary, query `sys.dm_geo_replication_link_status` for the link's role, state and replication lag, and compare `replication_lag_sec` after a burst of inserts.
- Leave `scratch` idle for 15 minutes and watch its status turn **Paused** in the portal. Connect to it (the last Connect line) and notice the first login waits while it resumes; then read its **App CPU billed** metric to see what serverless charges for.
- Open **Compute + storage** on `appdb` and on `scratch` and compare the DTU and vCore purchasing models: Basic, Standard and Premium against General Purpose, Business Critical and Hyperscale, provisioned against serverless. Read the options and prices without saving: a geo-secondary must be scaled before its primary.
- Connect to the read-only listener with `ApplicationIntent=ReadOnly` and check `DATABASEPROPERTYEX(DB_NAME(), 'Updateability')`: reporting traffic can use the secondary while writes stay on the primary.

## Learn more

- [Failover groups overview and best practices (Azure SQL Database)](https://learn.microsoft.com/azure/azure-sql/database/failover-group-sql-db)
- [Configure a failover group for Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/failover-group-configure-sql-db)
- [Active geo-replication](https://learn.microsoft.com/azure/azure-sql/database/active-geo-replication-overview)
- [Serverless compute tier for Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/serverless-tier-overview)
- [Compare vCore and DTU-based purchasing models of Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/purchasing-models)
- [Azure Private Link for Azure SQL Database](https://learn.microsoft.com/azure/azure-sql/database/private-endpoint-overview)
- [Azure SQL Database connectivity architecture](https://learn.microsoft.com/azure/azure-sql/database/connectivity-architecture)

The same goes for anything you build by hand inside `rg-lab-az305-23-sql-failover-secondary`.

Anything you build by hand inside `rg-lab-az305-23-sql-failover` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-23-sql-failover-`.
