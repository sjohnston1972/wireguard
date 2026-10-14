#!/usr/bin/env bash
# aws-safety-net.sh
#
# Plain English: after terraform destroy, make sure nothing tagged
# wg-admin=vpn is left in the region (the AWS twin of "delete the resource
# group by name"). Deletes in dependency order, then checks again and fails
# loudly if anything survived. Never touches anything without the tag.
#
# The headend's network card (ENI) outlives the instance and keeps the Elastic
# IP attached, which would block the security group, subnet and VPC deletes.
# So the order is: terminate, detach the IP, release it, delete the card.
set -euo pipefail
R="${AWS_REGION:-eu-west-2}"
TAG=(Name=tag:wg-admin,Values=vpn)
q() { aws ec2 "$@" --region "$R" --output text; }

inst="$(q describe-instances --filters "${TAG[@]}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId')"
if [[ -n "$inst" ]]; then
  echo "::warning::terminating $inst"
  aws ec2 terminate-instances --region "$R" --instance-ids $inst >/dev/null
  aws ec2 wait instance-terminated --region "$R" --instance-ids $inst
fi
# Detach each tagged Elastic IP from its network card, then release it.
for assoc in $(q describe-addresses --filters "${TAG[@]}" --query 'Addresses[?AssociationId!=`null`].AssociationId'); do
  echo "::warning::disassociating $assoc"; aws ec2 disassociate-address --region "$R" --association-id "$assoc" || true
done
for a in $(q describe-addresses --filters "${TAG[@]}" --query 'Addresses[].AllocationId'); do
  echo "::warning::releasing $a"; aws ec2 release-address --region "$R" --allocation-id "$a" || true
done
# The headend's network card survives the instance (DeleteOnTermination=false).
for eni in $(q describe-network-interfaces --filters "${TAG[@]}" Name=status,Values=available --query 'NetworkInterfaces[].NetworkInterfaceId'); do
  echo "::warning::deleting network interface $eni"; aws ec2 delete-network-interface --region "$R" --network-interface-id "$eni" || true
done
for v in $(q describe-volumes --filters "${TAG[@]}" Name=status,Values=available --query 'Volumes[].VolumeId'); do
  echo "::warning::deleting $v"; aws ec2 delete-volume --region "$R" --volume-id "$v" || true
done
for k in $(q describe-key-pairs --filters "${TAG[@]}" --query 'KeyPairs[].KeyName'); do
  aws ec2 delete-key-pair --region "$R" --key-name "$k" || true
done
for vpc in $(q describe-vpcs --filters "${TAG[@]}" --query 'Vpcs[].VpcId'); do
  echo "::warning::removing $vpc and what is in it"
  for sg in $(q describe-security-groups --filters Name=vpc-id,Values="$vpc" --query "SecurityGroups[?GroupName!='default'].GroupId"); do
    aws ec2 delete-security-group --region "$R" --group-id "$sg" || true
  done
  for igw in $(q describe-internet-gateways --filters Name=attachment.vpc-id,Values="$vpc" --query 'InternetGateways[].InternetGatewayId'); do
    aws ec2 detach-internet-gateway --region "$R" --internet-gateway-id "$igw" --vpc-id "$vpc" || true
    aws ec2 delete-internet-gateway --region "$R" --internet-gateway-id "$igw" || true
  done
  for sn in $(q describe-subnets --filters Name=vpc-id,Values="$vpc" --query 'Subnets[].SubnetId'); do
    aws ec2 delete-subnet --region "$R" --subnet-id "$sn" || true
  done
  for rt in $(q describe-route-tables --filters Name=vpc-id,Values="$vpc" --query 'RouteTables[?length(Associations[?Main==`true`])==`0`].RouteTableId'); do
    aws ec2 delete-route-table --region "$R" --route-table-id "$rt" || true
  done
  aws ec2 delete-vpc --region "$R" --vpc-id "$vpc" || true
done

left="$(q describe-instances --filters "${TAG[@]}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId') $(q describe-vpcs --filters "${TAG[@]}" --query 'Vpcs[].VpcId') $(q describe-addresses --filters "${TAG[@]}" --query 'Addresses[].AllocationId') $(q describe-network-interfaces --filters "${TAG[@]}" --query 'NetworkInterfaces[].NetworkInterfaceId')"
if [[ -n "${left// /}" ]]; then
  echo "::error::still in AWS after clean-up: $left"
  exit 1
fi
echo "AWS clean: nothing tagged wg-admin=vpn in $R"
