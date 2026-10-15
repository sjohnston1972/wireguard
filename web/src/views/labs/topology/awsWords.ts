// views/labs/topology/awsWords.ts
//
// Plain English: what an AWS lab calls each kind of resource, shared by the diagram alt text and the lab details panel.

import type { TopoNode } from "@shared/topology/model";

/**
 * What an AWS lab calls each kind (the kinds' own words are Azure's: "Log Analytics workspace", "Network
 * security group"). Written as they read mid-sentence, with their plural; a kind not listed keeps the registry's word.
 */
export const AWS_WORDS: Partial<Record<TopoNode["kind"], [string, string]>> = {
  vm: ["EC2 instance", "EC2 instances"],
  vmss: ["Auto Scaling group", "Auto Scaling groups"],
  loadBalancer: ["load balancer", "load balancers"],
  nsg: ["security group", "security groups"],
  routeTable: ["route table", "route tables"],
  internetGateway: ["internet gateway", "internet gateways"],
  natGateway: ["NAT gateway", "NAT gateways"],
  publicIp: ["Elastic IP", "Elastic IPs"],
  privateEndpoint: ["VPC endpoint", "VPC endpoints"],
  privateLinkService: ["VPC endpoint service", "VPC endpoint services"],
  bastion: ["EC2 Instance Connect Endpoint", "EC2 Instance Connect Endpoints"],
  localNetworkGateway: ["customer gateway", "customer gateways"],
  vpnGateway: ["VPN gateway", "VPN gateways"],
  firewall: ["Network Firewall", "Network Firewalls"],
  firewallPolicy: ["firewall policy", "firewall policies"],
  wafPolicy: ["web ACL", "web ACLs"],
  dnsZone: ["hosted zone", "hosted zones"],
  dnsResolver: ["Resolver endpoint", "Resolver endpoints"],
  dnsRuleset: ["Resolver rule", "Resolver rules"],
  frontDoor: ["CloudFront distribution", "CloudFront distributions"],
  trafficManager: ["Global Accelerator", "Global Accelerators"],
  aks: ["EKS cluster", "EKS clusters"],
  containerApp: ["ECS service", "ECS services"],
  storage: ["S3 bucket", "S3 buckets"],
  sqlServer: ["RDS database", "RDS databases"],
  keyVault: ["KMS key", "KMS keys"],
  registry: ["ECR repository", "ECR repositories"],
  recoveryVault: ["backup vault", "backup vaults"],
  managedIdentity: ["IAM role", "IAM roles"],
  monitor: ["CloudWatch alarm", "CloudWatch alarms"],
  logAnalytics: ["CloudWatch log group", "CloudWatch log groups"],
  messaging: ["messaging resource", "messaging resources"],
  transitGateway: ["transit gateway", "transit gateways"],
  lambda: ["Lambda function", "Lambda functions"],
  dynamodb: ["DynamoDB table", "DynamoDB tables"],
  cache: ["ElastiCache cluster", "ElastiCache clusters"],
  stream: ["Kinesis stream", "Kinesis streams"],
  lattice: ["VPC Lattice service", "VPC Lattice services"],
  clientVpn: ["Client VPN endpoint", "Client VPN endpoints"],
  vnet: ["VPC", "VPCs"],
};

/** A kind's AWS word as a tile label ("Security group", "EC2 instance"), or undefined when the kind keeps the registry's word. */
export function awsLabel(kind: string, count: number): string | undefined {
  const w = (AWS_WORDS as Record<string, [string, string] | undefined>)[kind];
  if (!w) return undefined;
  const s = count === 1 ? w[0] : w[1];
  return s.charAt(0).toUpperCase() + s.slice(1);
}
