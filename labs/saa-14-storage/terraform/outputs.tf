# outputs.tf
#
# Plain English: what the dashboard shows once lab 14 is up: the instance's
# address and how to connect, the bucket's name for the S3 lines, and one fio
# line per data volume, named by volume id (the NVMe order is not the attach
# order).

output "private_ips" {
  value = { "vm-storage" = aws_instance.storage.private_ip }
}

output "connect" {
  value = [
    "aws ec2-instance-connect ssh --instance-id ${aws_instance.storage.id} --os-user labadmin --connection-type eice",
    "sudo fio --name=gp3 --filename=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${replace(aws_ebs_volume.gp3.id, "-", "")} --rw=randread --bs=4k --iodepth=16 --direct=1 --runtime=20 --time_based --readonly",
    "df -h /mnt/efs",
    "aws s3api list-objects-v2 --bucket ${aws_s3_bucket.tiers.bucket} --query 'Contents[].[Key,StorageClass]' --output table",
    "ssh labadmin@${aws_instance.storage.private_ip}",
    "sudo fio --name=io2 --filename=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${replace(aws_ebs_volume.io2.id, "-", "")} --rw=randread --bs=4k --iodepth=16 --direct=1 --runtime=20 --time_based --readonly",
  ]
}

output "peer_vpc_id" {
  value = aws_vpc.lab.id
}

output "peer_route_table_ids" {
  value = [aws_route_table.private.id]
}
