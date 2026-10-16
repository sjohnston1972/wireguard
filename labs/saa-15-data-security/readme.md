Three layers that decide who can read data in S3: the KMS key that encrypts it, the bucket's own policy, and the VPC endpoint the request travels through. Each refuses things the others would allow, so you can watch a request pass one layer and fail the next. Everything is listed in the lab's resource group, `lab-saa-15-data-security`, in AWS Resource Groups (London).
From the SAA-C03 outline: design data security controls: encryption at rest with AWS KMS, encryption in transit, bucket policies and VPC endpoint policies.

## What it deploys

- The key `alias/lab-saa-15-data-security-data` (Name `key-data`), a customer managed KMS key whose policy lets the account's IAM policies grant its use
- The bucket `cloudlabs-<name prefix>-data`: encrypted by default with that key (SSE-KMS and an S3 Bucket Key), private; its policy refuses anything not over TLS and any upload asking for other encryption; one object, `secret.txt`
- A policy on the S3 gateway endpoint `vpce-s3`: through it only the lab's bucket and Amazon Linux's package repositories can be reached
- The instance `vm-client` (t4g.nano) running as the role `lab-saa-15-data-security-client`, which may read and write the bucket and use the key only through S3 for it; its only way out is the S3 endpoint

```text
lab-saa-15-data-security (London)
  vm-client [role client] --S3 endpoint vpce-s3 (policy: lab bucket + AL2023 repos only)--> cloudlabs-<prefix>-data
  cloudlabs-<prefix>-data: SSE-KMS with key-data; bucket policy: TLS only, KMS uploads only
  key-data: the account's IAM policies may grant it; the client's role uses it only via S3
```

## Things to try

- Connect (the first Connect line) and run the second: the object reads back, and `head-object` shows `ServerSideEncryption: aws:kms` and the key's ARN.
- Run the third line: the upload asks for AES256, so the bucket policy refuses it. Run it again without `--sse AES256`: the bucket's default encryption uses the lab's key.
- From the instance, try `aws s3 ls s3://<any other bucket of yours>`: the endpoint policy refuses it before the bucket ever sees the request, even though your role would allow it.
- Disable the key (KMS, the key, Key actions, Disable), then read `secret.txt` again: the object is still there, but nobody can decrypt it. Enable it again.
- Add a statement to the bucket policy denying `s3:GetObject` unless `aws:SourceVpce` is the endpoint id (the fourth Connect line). Now the instance can read the object and you, in the console, cannot. Remove the statement before tear-down if you want the console to see the bucket.

## Learn more

- [Using server-side encryption with AWS KMS keys (SSE-KMS)](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html)
- [Reducing the cost of SSE-KMS with Amazon S3 Bucket Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)
- [Gateway endpoints for Amazon S3](https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html)
- [Controlling access from VPC endpoints with bucket policies](https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies-vpc-endpoint.html)
- [Key policies in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-15-data-security` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
