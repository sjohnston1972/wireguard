A CloudFormation stack inside a Terraform lab: Terraform makes a service role and hands CloudFormation the template in this lab's folder, and CloudFormation builds a small work queue system from it. Practise changing a stack with change sets, finding drift and seeing a stack policy refuse an update. Everything is listed in the lab's resource group, `lab-soa-06-cloudformation`, in AWS Resource Groups (London), and the stack under CloudFormation, Stacks.
From the SOA-C03 outline: provision and maintain cloud resources with AWS CloudFormation, troubleshoot deployment issues, and manage stacks with change sets, drift detection and stack policies.

## What it deploys

- The stack `lab-soa-06-cloudformation-stack`, from `terraform/cfn/stack.yaml`, with five parameters (the lab's id, the queue's visibility timeout, receives before a message is dead-lettered, and the names of its log group and parameter)
- A work queue and its dead-letter queue (`lab-soa-06-cloudformation-stack-WorkQueue-…` and `…-DeadLetterQueue-…`): a message received three times without being deleted moves to the dead-letter queue
- An SNS topic and the alarm `…-OldestMessageAlarm-…`, which notifies it when a message has waited five minutes
- The log group `/cloudlabs/soa-06-cloudformation/stack` (one day) and the parameter `/cloudlabs/soa-06-cloudformation/config/greeting`
- The service role `lab-soa-06-cloudformation-cfn`: CloudFormation builds the stack as this role, which may touch only what the stack names
- A stack policy that lets any update through except one that replaces or deletes `WorkQueue`

The template is YAML written with the long form of each function (`Ref: VisibilityTimeout`, `Fn::GetAtt: [WorkQueue, Arn]`): Terraform reads it with `yamldecode`, which does not understand the short forms (`!Ref`, `!GetAtt`) you will see in most examples. CloudFormation treats both forms the same.

```text
lab-soa-06-cloudformation (London)
  Terraform --> service role lab-<id>-cfn --> stack lab-<id>-stack (cfn/stack.yaml)
    WorkQueue --(3 receives)--> DeadLetterQueue
    OldestMessageAlarm (WorkQueue age > 5 min) --> AlertTopic
    StackLog /cloudlabs/<id>/stack     Greeting /cloudlabs/<id>/config/greeting
    stack policy: no Update:Replace or Update:Delete on WorkQueue
```

## Things to try

- In CloudFormation, open the stack and choose **Update**, **Make a direct update**, keep the current template and change `VisibilityTimeout` to 60. Choose **Create change set** rather than executing: read what it will modify (one property, no replacement), then execute it. Terraform will see the difference at tear-down and still delete the stack.
- Edit the parameter `/cloudlabs/soa-06-cloudformation/config/greeting` in Systems Manager, Parameter Store, then run **Detect drift** on the stack (or the third Connect line) and read **View drift results**: the parameter shows as modified, with the expected and actual values side by side.
- Try a change the stack policy refuses: a change set that sets `QueueName` on `WorkQueue` (renaming a queue replaces it) fails on execution with the policy's reason, and the stack rolls back. Read the events tab to see where it stopped.
- Send messages with the second Connect line, receive one three times without deleting it (`aws sqs receive-message --queue-url … --visibility-timeout 0`), and find it in the dead-letter queue. Leave one unread for five minutes and watch the alarm go to In alarm.
- Look at the stack's **Template** tab: CloudFormation shows the JSON Terraform handed it. Compare it with `cfn/stack.yaml`.

## Not built here

**StackSets.** A StackSet deploys one template to many accounts and regions from an administrator account, usually across an AWS Organization. This lab works in one account and one region, so StackSets are described here only, and the lab scope check refuses `aws_cloudformation_stack_set`. See [Working with AWS CloudFormation StackSets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html).

## Learn more

- [Updating stacks using change sets](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-changesets.html)
- [Detect unmanaged configuration changes to stacks and resources with drift detection](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-stack-drift.html)
- [Prevent updates to stack resources (stack policies)](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/protect-stack-resources.html)
- [AWS CloudFormation service role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [Intrinsic function reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html)
- [Using Amazon SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-06-cloudformation` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
