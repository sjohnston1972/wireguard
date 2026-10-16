Five ways to let the parts of a system stop waiting on each other. An order is put on an EventBridge bus; a rule starts a Step Functions workflow; the workflow asks a Lambda function to check the order and publishes it to an SNS topic; the topic copies it into two SQS queues, billing and shipping, which their own consumers would read at their own pace. Billing's queue has a dead-letter queue for messages nobody manages to handle. Everything is listed in the lab's resource group, `lab-saa-13-decoupling`, in AWS Resource Groups (London).
From the SAA-C03 outline: design loosely coupled architectures with queues, notifications, events and workflows, and handle failures with retries and dead-letter queues.

## What it deploys

- The bus `lab-saa-13-decoupling-bus` and its rule `lab-saa-13-decoupling-placed` (OrderPlaced events from `cloudlabs.shop`), whose target starts the workflow as the role `lab-saa-13-decoupling-events`
- The workflow `lab-saa-13-decoupling-orders` (Step Functions, standard): Validate (the function `lab-saa-13-decoupling-validate`, retried twice on a Lambda service error), then Publish to the topic; an order that fails validation ends in Rejected
- The topic `lab-saa-13-decoupling-orders`, fanning out to the queues `lab-saa-13-decoupling-billing` and `lab-saa-13-decoupling-shipping`
- The dead-letter queue `lab-saa-13-decoupling-billing-dlq`: a billing message received three times without being deleted moves there

```text
lab-saa-13-decoupling (London)
  put-events --> bus-orders --rule placed--> sfn-orders: Validate (fn-validate) --> Publish --> topic-orders
  topic-orders --fan-out--> queue-billing --3 failed receives--> queue-billing-dlq
  topic-orders --fan-out--> queue-shipping
  sfn-orders: Validate fails --> Rejected
```

## Things to try

- Put an order on the bus with the first Connect line in CloudShell, then list the workflow's runs with the second: open the run in the Step Functions console and follow it state by state, inputs and outputs included.
- Read the order from both queues with the third and fourth lines: one publish, two copies, each queue independent of the other.
- Read the billing message three times without deleting it (wait for its 20-second visibility timeout between reads): the fourth read finds nothing, and the fifth Connect line finds it in the dead-letter queue.
- Put an order with `quantity` 0 on the bus: the workflow ends in Rejected and nothing reaches the queues. Find the function's error in `/cloudlabs/saa-13-decoupling/validate`.
- Put an event with a different `Source` on the bus: the rule does not match it, so nothing runs. EventBridge decides what goes where, not the sender.

## Learn more

- [Using dead-letter queues in Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Fanout Amazon SNS notifications to Amazon SQS queues](https://docs.aws.amazon.com/sns/latest/dg/sns-sqs-as-subscriber.html)
- [Event buses in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-bus.html)
- [Invoke an AWS Lambda function with Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/connect-lambda.html)
- [Handling errors in Step Functions workflows](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-13-decoupling` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
