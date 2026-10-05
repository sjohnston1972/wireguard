Azure Cosmos DB for NoSQL on a serverless account: one database and three containers, each partitioned a different way,
so you can measure what a partition key costs in request units, see a hot partition coming, and read what each
consistency level trades away. From the AZ-305 outline: recommend a solution for storing semi-structured data, and a data
storage solution that balances features, performance and costs.

## What it deploys

- An Azure Cosmos DB account, `<prefix>-cosmos` (the session's random prefix; the Connect lines show it): the NoSQL API, **serverless** (billed per request unit and per GB stored, with no throughput to provision), in one region, with **Session** consistency by default
- The free tier is off: a subscription gets one free-tier account, and creating a second fails, so the lab never asks for it
- A database, `shop`, with three containers:
- `orders`, partitioned by `/customerId`: many values, so reads and writes spread evenly
- `events`, with a **hierarchical** partition key, `/tenantId` then `/userId`, so one large tenant can grow past a logical partition's 20 GB limit and a query for one tenant still goes to a few physical partitions
- `bykey-status`, partitioned by `/status`: only a handful of values, the deliberate **hot partition** example

The account is public with key authentication on, so the portal's **Data Explorer** works from anywhere. There is no network and nothing to peer. Serverless accounts run in a single region, and no region can be added later: a second region, or multi-region writes, needs provisioned (or autoscale) throughput. An idle account costs only its storage, a fraction of a penny an hour.

```text
rg-lab-<id>
  <prefix>-cosmos   NoSQL API, serverless, one region, Session consistency
    shop
      orders         /customerId                 (good: high cardinality)
      events         /tenantId -> /userId        (hierarchical, MultiHash)
      bykey-status   /status                     (poor: a hot partition)
```

## Things to try

- In Data Explorer, add a few items to `orders` (`{"id": "1", "customerId": "c1", "total": 12}` and so on), then read one back with **its partition key** and again by a query without it. Open **Query Stats** each time and compare the **request charge**: a point read of a 1 KB item costs 1 RU, a cross-partition query costs more.
- Run a cross-partition query such as `SELECT * FROM c WHERE c.total > 10` on `orders` and read how many partitions it touched. Then add items to `events` for two tenants and query one tenant with `WHERE c.tenantId = 't1'`: the hierarchical key lets it target that tenant only.
- Put every new item in `bykey-status` under `"status": "open"` and think through what happens at scale: one logical partition takes all the writes and stops at 20 GB. Sketch a **synthetic** key instead (`status` plus a date, or a random suffix 0 to 9) and what it costs to read back.
- Open **Default consistency** and read the five levels, Strong, Bounded staleness, Session, Consistent prefix and Eventual: what each guarantees a reader and what it costs in latency and RU. Switch the default to Eventual and back (on one region the guarantees barely differ; with several regions they matter).
- Open **Replicate data globally** and try to add UK West: a serverless account refuses a second region. Note what you would need instead (provisioned or autoscale throughput) and what multi-region writes would add.
- Open **Keys** and the **Networking** page and note what you would change for production: Microsoft Entra ID with data-plane RBAC instead of keys, and a private endpoint instead of public access.

## Learn more

- [Partitioning and horizontal scaling in Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/partitioning-overview)
- [Hierarchical partition keys in Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/hierarchical-partition-keys)
- [Consistency levels in Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/consistency-levels)
- [Request units in Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/request-units)
- [Azure Cosmos DB serverless account type](https://learn.microsoft.com/azure/cosmos-db/serverless)
- [Choose between provisioned throughput and serverless](https://learn.microsoft.com/azure/cosmos-db/throughput-serverless)
- [Azure Cosmos DB lifetime free tier](https://learn.microsoft.com/azure/cosmos-db/free-tier)

Anything you build by hand inside `rg-lab-az305-24-cosmos` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-24-cosmos-`.
