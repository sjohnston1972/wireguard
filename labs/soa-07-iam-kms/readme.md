Identity and encryption with nothing to run but the services themselves: a console user and a Lambda role held by a permission boundary, IAM Access Analyzer looking for anything shared outside the account, a customer managed KMS key with its own key policy, and a secret encrypted with that key which a Lambda function rotates. Everything is listed in the lab's resource group, `lab-soa-07-iam-kms`, in AWS Resource Groups (London); the user and roles are in IAM under the path `/cloudlabs-lab/`.
From the SOA-C03 outline: implement and manage IAM users, roles and policies, permission boundaries and IAM Access Analyzer, protect data with AWS KMS keys and key policies, and store and rotate secrets with AWS Secrets Manager.

## What it deploys

- The console user `lab-soa-07-iam-kms-ann`, with the permission boundary `wg-admin-lab-boundary` and her own policy `lab-soa-07-iam-kms-ann` (EC2 and CloudFormation reads, the lab key through its alias, the lab secret). Her password is behind **Show**; she signs in at the account's sign-in address shown with it
- The customer managed key `alias/lab-soa-07-iam-kms-data`, whose key policy lets the account's IAM policies grant its use, and which waits 7 days (the shortest window) when deleted
- The secret `lab-soa-07-iam-kms-app-<name prefix>` (a user name and password), encrypted with that key
- The function `lab-soa-07-iam-kms-rotate` (Python, no VPC), run as the role `lab-soa-07-iam-kms-rotate` under the same boundary, which rotates the secret once at deploy and every 30 days, and logs to `/cloudlabs/soa-07-iam-kms/rotate`
- The account's IAM Access Analyzer `lab-soa-07-iam-kms-account` (external access, London)

```text
lab-soa-07-iam-kms (London)
  user ann --(own policy AND boundary)--> EC2 reads, key (via alias), secret;  CloudFormation: refused by the boundary
  key alias/lab-<id>-data (key policy: the account's IAM decides) --encrypts--> secret lab-<id>-app-<prefix>
  Secrets Manager --invokes--> function lab-<id>-rotate (role under the boundary) --> new password, AWSCURRENT
  Access Analyzer lab-<id>-account: anything in London shared outside the account
```

## Things to try

- Sign in as `lab-soa-07-iam-kms-ann` in a private window (the first Connect line). switch the console to Europe (London) first, as the boundary allows no other region. EC2 opens; CloudFormation says she is not authorised, although her own policy allows `cloudformation:ListStacks`: the boundary does not, and what she may do is where the two overlap. In IAM, open her user and read **Permissions boundary**; then use the IAM policy simulator (as yourself) on her user for both actions.
- As ann, open the secret in Secrets Manager and **Retrieve secret value**: it decrypts because her policy allows the key through its alias (`kms:ResourceAliases`). Then rotate it (the third Connect line, as yourself), watch `/cloudlabs/soa-07-iam-kms/rotate` for the four steps, and see a new value and a new AWSCURRENT version.
- Turn on **Automatic key rotation** on the key (KMS, Customer managed keys, Key rotation), and read the key policy: it names only the account, which is why IAM policies can grant the key at all.
- Add a statement to the key policy that allows another AWS account that exists (a second account of your own, for example; KMS refuses a principal it cannot find) `kms:Decrypt`, then open IAM Access Analyzer: a new active finding (it can take a few minutes; use **Rescan**) names the key as shared outside the account. **Archive** it, or remove the statement and **Rescan**; both clear it.
- Make an access key for ann (IAM, her user, Security credentials) and see its last-used date stay empty. Tear-down removes it with her (`force_destroy`); the lab's own pipeline may never make one.

## Not built here

**AWS Organizations and service control policies.** An SCP is a guardrail on a whole account or organizational unit: like a permission boundary it grants nothing and only limits, but it applies to every principal in the account, root included. It needs an AWS Organization, which this single account is not part of, so it is described here only, and the lab scope check refuses `aws_organizations_*`. See [Service control policies (SCPs)](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html).

## Learn more

- [Permissions boundaries for IAM entities](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- [Using AWS Identity and Access Management Access Analyzer](https://docs.aws.amazon.com/IAM/latest/UserGuide/what-is-access-analyzer.html)
- [Key policies in AWS KMS](https://docs.aws.amazon.com/kms/latest/developerguide/key-policies.html)
- [Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)
- [Rotate AWS Secrets Manager secrets](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html)
- [Lambda function rotation](https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_lambda.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-07-iam-kms` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
