Messaging and events, the way an AZ-305 design question frames them: **Service Bus** for messages a business cannot lose (queues for work items, topics for publish and subscribe, dead-lettering for what cannot be processed), **Event Grid** for reacting to something that happened (here, a file landing in storage), and a serverless consumer that runs only when there is work. From the AZ-305 outline (Design infrastructure solutions): recommend a messaging architecture, recommend an event-driven architecture, and recommend a serverless-based and a container-based solution.

## What it deploys

- `sb-<prefix>`, a **Service Bus namespace, Standard** tier (Basic has queues only; topics and subscriptions need Standard). Two queues, `orders` and `blob-events`, each with a 30-second lock, a maximum delivery count of 5 and dead-lettering of expired messages. A topic, `notifications`, with two subscriptions: `all`, and `high-priority` with the SQL filter rule `priority = 'high'`
- Two shared access policies on the namespace: `consumer` (**Listen** only) and `scaler` (**Manage**, which KEDA needs to read a queue's length). No managed identity and no role assignment: the labs' role allow-list has no Service Bus data role, so the keys are held as Container Apps secrets, and none is ever shown as an output
- `<prefix>evt`, a storage account with containers `uploads` and `eventgrid-deadletter`, and `egst-storage`, an **Event Grid system topic** on it. Its subscription `blob-to-queue` sends **BlobCreated** and **BlobDeleted** events for `uploads` to the `blob-events` queue, retries 5 times within 60 minutes, then dead-letters the event to `eventgrid-deadletter`
- `cae-lab`, a consumption-only Container Apps environment (no subnet, so Azure makes no extra resource group), logging to `log-lab` (capped at 0.05 GB a day, deleted for good on tear-down)
- `caj-consumer`, an **event-driven Container Apps job**: KEDA's `azure-servicebus` scaler checks both queues every 30 seconds and starts a run when one holds a message. Each run is a short Python script on Microsoft's Python image from MCR that peek-locks every waiting message, prints it and completes it. A message whose body contains the word `fail` is left uncompleted, so Service Bus delivers it again until it is dead-lettered

The lab has no VNet and is never peered: everything is reached through the portal. The Connect lines name the namespace, the upload container and the job.

```text
rg-lab-<id>
  <prefix>evt (storage)  uploads/  --BlobCreated, BlobDeleted-->  egst-storage (Event Grid system topic)
                         eventgrid-deadletter/  <--undeliverable events--+   |
                                                                            | blob-to-queue
  sb-<prefix> (Service Bus, Standard)                                       v
    queue orders       <-- you, Service Bus Explorer      queue blob-events
    topic notifications --> subscription all
                        --> subscription high-priority (priority = 'high', plus $Default)
         ^ KEDA checks both queues every 30 s (scaler key, Manage)
         | peek-lock, complete (consumer key, Listen)
  cae-lab (Container Apps, consumption, no subnet)
    caj-consumer (job, 0 to 2 runs)  --console-->  log-lab
```

## Things to try

- Open `sb-<prefix>`, the `orders` queue and **Service Bus Explorer**, and send a message. If the Explorer says you lack permission, switch its authentication to **Access key**: your subscription role can read the namespace's keys but holds no Service Bus data role. Within about 30 seconds `caj-consumer`'s **Execution history** shows a run; its console line is in `log-lab` (`ContainerAppConsoleLogs_CL | project TimeGenerated, Log_s`, a few minutes behind).
- Send a message whose body contains `fail`. The consumer leaves it locked, the lock runs out, and the next runs see it again (watch **Delivery count** in the Explorer's peek). After the fifth delivery Service Bus moves it to the queue's **dead-letter** subqueue with the reason `MaxDeliveryCountExceeded`: peek it there, then resubmit it (without the word) and watch it complete.
- Upload a file to the `uploads` container, then delete it. Each raises an Event Grid event that lands in `blob-events` and is completed by the next run, which prints the event type and subject. Open `egst-storage`'s **Metrics** (published and delivered events) and the subscription's filters. Upload to `eventgrid-deadletter` and see that nothing happens: the subject filter only matches `uploads`.
- Send three messages to the topic `notifications` with a custom property `priority` of `high`, `low` and none. Peek both subscriptions: both have all three, because Azure gave `high-priority` a `$Default` rule (a true filter) and rules are ORed. Delete `$Default` from `high-priority`'s **Filters**, send again, and only the `high` one arrives there. Topics, unlike queues, give every subscription its own copy.
- Compare the three services: Service Bus keeps a message until a consumer takes it (send ten to `orders` at once and watch the runs drain them, at most two at a time), Event Grid pushes a notice that something happened and retries it for up to an hour, and Event Hubs (below) keeps a stream that readers can replay. Then decide which you would choose for orders, for "a file arrived" and for device telemetry, and check your answer against Learn's comparison.

## Not built here

**Azure Functions.** The usual consumer here is a function with a Service Bus trigger. Every Functions hosting plan (Consumption, Flex Consumption, Premium and Dedicated) is an App Service plan, and this subscription's App Service quota is 0, so the lab uses the same event-driven scaling Functions uses on Container Apps (KEDA's Service Bus scaler) with a Container Apps job instead. Functions on Container Apps itself needs your function code built into a container image and pushed to a registry, which a lab with no image build cannot do. See [Azure Functions hosting options](https://learn.microsoft.com/azure/azure-functions/functions-scale) and [Azure Container Apps hosting of Azure Functions](https://learn.microsoft.com/azure/azure-functions/functions-container-apps-hosting).

**Event Hubs and Service Bus Premium.** Event Hubs is for streaming telemetry at volume (partitions, consumer groups, replay), not individual business messages. Service Bus Premium adds dedicated messaging units, private endpoints, geo-replication and large messages, at about £0.70 an hour per unit, roughly 70 times this lab's Standard namespace. Both are compared, not built.

## Learn more

- [What is Azure Service Bus?](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-messaging-overview)
- [Service Bus queues, topics and subscriptions](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-queues-topics-subscriptions)
- [Topic filters and actions](https://learn.microsoft.com/azure/service-bus-messaging/topic-filters)
- [Service Bus dead-letter queues](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-dead-letter-queues)
- [Use Service Bus Explorer](https://learn.microsoft.com/azure/service-bus-messaging/explorer)
- [Service Bus access control with shared access signatures](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-sas)
- [System topics in Azure Event Grid](https://learn.microsoft.com/azure/event-grid/system-topics)
- [Service Bus as an Event Grid handler](https://learn.microsoft.com/azure/event-grid/handler-service-bus)
- [Dead letter and retry policies in Event Grid](https://learn.microsoft.com/azure/event-grid/manage-event-delivery)
- [Choose between Azure messaging services](https://learn.microsoft.com/azure/service-bus-messaging/compare-messaging-services)
- [Jobs in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/jobs)
- [Set scaling rules in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/scale-app)

The namespace's Standard base charge is about £0.01 an hour (£0.0101 by the hour, £7.55 a month); everything else here costs pennies or nothing while the queues are quiet.

Anything you build by hand inside `rg-lab-az305-30-messaging` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-30-messaging-`.
