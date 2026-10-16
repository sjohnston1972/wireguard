# outputs.tf
#
# Plain English: what the dashboard shows once lab 14 is up: the instance's
# address and how to connect, and the bucket's name for the S3 lines.

output "private_ips" {
  value = { "vm-storage" = aws_instance.storage.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.storage.id} --os-user labadmin --connection-type eice",
    "sudo fio --name=rand --filename=/dev/nvme1n1 --rw=randread --bs=4k --iodepth=16 --direct=1 --runtime=20 --time_based --readonly",
    "df -h /mnt/efs",
    "aws s3api list-objects-v2 --bucket ${aws_s3_bucket.tiers.bucket} --query 'Contents[].[Key,StorageClass]' --output table",
    "ssh labadmin@${aws_instance.storage.private_ip}",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
