// scripts/test/fixtures/labs/plans/labs/saa-15-data-security.mjs
//
// Plain English: lab saa-15's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then kms.tf (the key and its alias), s3.tf (the bucket, its public
// access block, the SSE-KMS configuration, the bucket policy and the secret
// object), endpoint.tf (the S3 endpoint's policy) and compute.tf (the client's
// role, policy, attachment and profile, and vm-client). The key policy, the
// bucket policy, the endpoint policy and the role's policy are built from the
// caller identity, the lab id, the name prefix and the region, so they are
// known at plan (rulings A68, P18); the bucket's encryption names the key by
// its ARN, which is not.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, al2023Instance, awsData, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

/** A policy document as Terraform's jsonencode prints it: object keys in sorted order. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const doc = (statements) => JSON.stringify(sorted({ Version: "2012-10-17", Statement: statements }));

export default () => {
  const c = ctxAws("saa-15-data-security", "15");
  const id = c.id;
  const region = c.variables.region;
  const bucket = `cloudlabs-${c.prefix}-data`;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const onBucket = (type, key, values, extra = {}) => ({ address: `${type}.${key}`, values, unknown: ["bucket", ...(extra.unknown ?? [])], refs: { bucket: ref("aws_s3_bucket.data", "id"), ...(extra.refs ?? {}) } });
  const instance = al2023Instance(c, { key: "client", name: "vm-client", type: "t4g.nano", profile: "aws_iam_instance_profile.client" });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // kms.tf
      {
        address: "aws_kms_key.data",
        values: tagged(c, {
          description: `lab ${id}, encrypts the lab bucket`, deletion_window_in_days: 7,
          policy: doc([{ Sid: "TheAccountAndItsIamPolicies", Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: "kms:*", Resource: "*" }]),
          tags: { Name: "key-data" },
        }),
        refs: { description: ["var.lab_id"], policy: ["data.aws_caller_identity.current.account_id", "data.aws_caller_identity.current"] },
      },
      {
        address: "aws_kms_alias.data",
        values: { name: `alias/lab-${id}-data` },
        unknown: ["target_key_id"],
        refs: { name: ["var.lab_id"], target_key_id: ["aws_kms_key.data.key_id", "aws_kms_key.data"] },
      },
      // s3.tf
      { address: "aws_s3_bucket.data", values: tagged(c, { bucket, force_destroy: true, tags: { Name: "data" } }), refs: { bucket: ["local.bucket"] } },
      onBucket("aws_s3_bucket_public_access_block", "data", { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
      onBucket("aws_s3_bucket_server_side_encryption_configuration", "data", {
        rule: [{ apply_server_side_encryption_by_default: [{ sse_algorithm: "aws:kms" }], bucket_key_enabled: true }],
      }, {
        unknown: ["rule.0.apply_server_side_encryption_by_default.0.kms_master_key_id"],
        refs: { "rule.0.apply_server_side_encryption_by_default.0.kms_master_key_id": ref("aws_kms_key.data", "arn") },
      }),
      onBucket("aws_s3_bucket_policy", "data", {
        policy: doc([
          { Sid: "TlsOnly", Effect: "Deny", Principal: "*", Action: "s3:*", Resource: [bucketArn, `${bucketArn}/*`], Condition: { Bool: { "aws:SecureTransport": "false" } } },
          { Sid: "KmsUploadsOnly", Effect: "Deny", Principal: "*", Action: "s3:PutObject", Resource: `${bucketArn}/*`, Condition: { Null: { "s3:x-amz-server-side-encryption": "false" }, StringNotEquals: { "s3:x-amz-server-side-encryption": "aws:kms" } } },
        ]),
      }, { refs: { policy: ["local.bucket_arn", "local.bucket_arn", "local.bucket_arn"] } }),
      onBucket("aws_s3_object", "secret", tagged(c, { key: "secret.txt", content: "encrypted at rest with the lab's own key\n", content_type: "text/plain" })),
      // endpoint.tf
      {
        address: "aws_vpc_endpoint_policy.s3",
        values: {
          policy: doc([
            { Sid: "LabBucketOnly", Effect: "Allow", Principal: "*", Action: "s3:*", Resource: [bucketArn, `${bucketArn}/*`] },
            { Sid: "AmazonLinuxRepositories", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::al2023-repos-${region}-*/*` },
          ]),
        },
        unknown: ["vpc_endpoint_id"],
        refs: { vpc_endpoint_id: ref("aws_vpc_endpoint.s3", "id"), policy: ["local.bucket_arn", "local.bucket_arn", "var.region"] },
      },
      // compute.tf
      {
        address: "aws_iam_role.client",
        values: tagged(c, { name: `lab-${id}-client`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: doc([{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }]) }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_policy.client",
        values: tagged(c, {
          name: `lab-${id}-client`, path: "/cloudlabs-lab/",
          policy: doc([
            { Sid: "LabBucket", Effect: "Allow", Action: ["s3:ListBucket", "s3:GetObject", "s3:PutObject"], Resource: [bucketArn, `${bucketArn}/*`] },
            { Sid: "ListMyBuckets", Effect: "Allow", Action: "s3:ListAllMyBuckets", Resource: "*" },
            {
              Sid: "LabKeyThroughS3", Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: "*",
              Condition: { StringEquals: { "kms:ViaService": `s3.${region}.amazonaws.com` }, StringLike: { "kms:EncryptionContext:aws:s3:arn": [bucketArn, `${bucketArn}/*`] } },
            },
          ]),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.bucket_arn", "local.bucket_arn", "local.bucket_arn", "local.bucket_arn", "var.region"] },
      },
      {
        address: "aws_iam_role_policy_attachment.client",
        values: { role: `lab-${id}-client` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.client", "name"), policy_arn: ref("aws_iam_policy.client", "arn") },
      },
      { address: "aws_iam_instance_profile.client", values: tagged(c, { name: `lab-${id}-client`, path: "/cloudlabs-lab/", role: `lab-${id}-client` }), refs: { name: ["var.lab_id"], role: ref("aws_iam_role.client", "name") } },
      instance,
    ],
  };
};
