A small streaming analytics pipeline. Every minute a Lambda function puts 20 shop events on a Kinesis stream; Firehose collects them and writes a file to S3 each minute; a Glue crawler reads the files and adds a table to the data catalogue; Athena answers SQL questions about the events, in a workgroup that refuses any query that would scan more than 10 MB. Everything is listed in the lab's resource group, `lab-saa-17-data-pipeline`, in AWS Resource Groups (London).
From the SAA-C03 outline: design high-performing data ingestion and transformation, and choose analytics services such as Kinesis, Firehose, Glue and Athena.

## What it deploys

- The stream `lab-saa-17-data-pipeline-events` (Kinesis Data Streams, one provisioned shard, a day's retention)
- The producer `lab-saa-17-data-pipeline-producer` (Python 3.13, arm64), called every minute by the rule `lab-saa-17-data-pipeline-every-minute`, logging to `/cloudlabs/saa-17-data-pipeline/producer`
- The delivery stream `lab-saa-17-data-pipeline-to-s3` (Firehose): from the stream to `events/` in the bucket `cloudlabs-<name prefix>-lake`, a file every minute, as the role `lab-saa-17-data-pipeline-firehose`
- The Glue database `lab_saa_17_data_pipeline` and the crawler `lab-saa-17-data-pipeline-events` (run it by hand), as the role `lab-saa-17-data-pipeline-crawler`
- The Athena workgroup `lab-saa-17-data-pipeline-wg`: results in `athena-results/` in the lake, at most 10 MB scanned per query

```text
lab-saa-17-data-pipeline (London)
  rule every-minute --> fn-producer --20 events/min--> stream-events (1 shard)
  stream-events --reads--> firehose-to-s3 --delivers--> cloudlabs-<prefix>-lake/events/
  crawler-events --catalogues--> glue-lake (table events)
  you --SQL--> athena-wg --> glue-lake + lake (results in athena-results/)
```

## Things to try

- Run the first Connect line in CloudShell and open the stream's Monitoring tab: about 20 incoming records a minute. Read a few with `aws kinesis get-shard-iterator` and `get-records`.
- After two or three minutes list what Firehose wrote with the second line: one file a minute under a date path. Download one and look: one JSON event a line.
- Run the crawler with the third line (about 5p a run; about a minute), then find the `events` table in the Glue console with the columns it worked out.
- Run the fourth line, then `aws athena get-query-results --query-execution-id <id>`, or use the Athena console with the workgroup `lab-saa-17-data-pipeline-wg` selected. Each query bills by the data it scans (pennies here); try one that would scan more than 10 MB and watch the workgroup cancel it.
- Raise the stream to two shards (`aws kinesis update-shard-count --stream-name lab-saa-17-data-pipeline-events --target-shard-count 2 --scaling-type UNIFORM_SCALING`) and see the shard hours, and the bill, double. Set it back before you leave.

## Learn more

- [What is Amazon Kinesis Data Streams?](https://docs.aws.amazon.com/streams/latest/dev/introduction.html)
- [What is Amazon Data Firehose?](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html)
- [Configuring a crawler](https://docs.aws.amazon.com/glue/latest/dg/add-crawler.html)
- [Using workgroups to control query access and costs](https://docs.aws.amazon.com/athena/latest/ug/workgroups-manage-queries-control-costs.html)
- [Querying JSON](https://docs.aws.amazon.com/athena/latest/ug/querying-JSON.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-17-data-pipeline` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
