# lambda/producer.py
#
# Plain English: lab 17's producer. Every minute EventBridge calls it; it puts
# 20 made-up shop events (a user, an action, an amount) on the Kinesis
# stream, one JSON object per line so Athena can read the files Firehose
# writes, partitioned by user.

import json
import os
import random
import uuid
from datetime import datetime, timezone

import boto3

KINESIS = boto3.client("kinesis")
STREAM = os.environ["STREAM"]
ACTIONS = ["view", "view", "view", "add_to_basket", "checkout"]


def handler(_event, _context):
    now = datetime.now(timezone.utc).isoformat()
    records = []
    for _ in range(20):
        e = {"event_id": str(uuid.uuid4()), "user": f"user-{random.randint(1, 25):02d}", "action": random.choice(ACTIONS), "amount": round(random.uniform(1, 80), 2), "at": now}
        records.append({"Data": (json.dumps(e) + "\n").encode(), "PartitionKey": e["user"]})
    out = KINESIS.put_records(StreamName=STREAM, Records=records)
    return {"sent": len(records), "failed": out.get("FailedRecordCount", 0)}
