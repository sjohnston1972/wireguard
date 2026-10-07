# consumer.py
#
# Plain English: the lab's message consumer. The Container Apps job
# caj-consumer runs it (python3 -c, on mcr.microsoft.com/azurelinux/base/
# python) each time KEDA sees a message waiting in one of its queues. For
# every queue in QUEUES it receives messages with Service Bus's peek-lock
# (the REST runtime API, Python's standard library only), prints each one
# and completes it, until the queue has nothing more to give. A message
# whose body contains "fail" is left locked and not completed: when its
# 30-second lock runs out Service Bus delivers it again, and after the
# queue's maximum delivery count (5) it moves it to the dead-letter queue.
#
# SB_CONNECTION is the Listen-only policy's connection string (a Container
# Apps secret); the key never leaves this process and is never printed.
# Each request carries a SAS token scoped to its queue. SB_SCHEME exists
# only for the repository's tests, which run this against a fake Service Bus
# over plain HTTP. Exit status 1 (a Failed execution) if a queue could not be
# read.

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def settings(connection):
    """(host, key name, key) from a Service Bus connection string."""
    parts = dict(p.split("=", 1) for p in connection.split(";") if "=" in p)
    host = urllib.parse.urlparse(parts["Endpoint"]).netloc
    return host, parts["SharedAccessKeyName"], parts["SharedAccessKey"]


def sas_token(uri, key_name, key, ttl=300):
    """A shared access signature for `uri`, valid for `ttl` seconds."""
    expiry = str(int(time.time()) + ttl)
    resource = urllib.parse.quote_plus(uri)
    digest = hmac.new(key.encode("utf-8"), (resource + "\n" + expiry).encode("utf-8"), hashlib.sha256).digest()
    signature = urllib.parse.quote_plus(base64.b64encode(digest).decode("ascii"))
    return "SharedAccessSignature sr=" + resource + "&sig=" + signature + "&se=" + expiry + "&skn=" + key_name


def call(method, url, token):
    """(status, headers, body) of one request; an HTTP error is an answer too."""
    data = b"" if method in ("POST", "PUT") else None
    request = urllib.request.Request(url, data=data, method=method, headers={"Authorization": token})
    try:
        with urllib.request.urlopen(request, timeout=30) as reply:
            return reply.status, reply.headers, reply.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def describe(body):
    """An Event Grid event as its type and subject; anything else as its first 200 characters."""
    text = body.decode("utf-8", "replace")
    try:
        event = json.loads(text)
    except ValueError:
        return text[:200]
    if isinstance(event, dict) and "eventType" in event:
        return str(event["eventType"]) + " " + str(event.get("subject", ""))
    return text[:200]


def drain(scheme, host, queue, key_name, key):
    """Receive, print and complete every message in `queue`. False if the queue could not be read."""
    token = lambda: sas_token("https://" + host + "/" + queue, key_name, key)
    completed = 0
    while True:
        status, headers, body = call("POST", scheme + "://" + host + "/" + queue + "/messages/head?timeout=5", token())
        if status == 204:
            break
        if status != 201:
            print(queue + ": receive failed, HTTP " + str(status) + " " + body[:200].decode("utf-8", "replace"))
            return False
        props = json.loads(headers.get("BrokerProperties") or "{}")
        label = "message " + str(props.get("MessageId")) + " (delivery " + str(props.get("DeliveryCount")) + ")"
        if b"fail" in body.lower():
            print(queue + ": " + label + " asks to fail: not completed. Its lock runs out, Service Bus delivers it again, "
                  "and after the queue's maximum delivery count it moves it to the dead-letter queue.")
            continue
        status, _, _ = call("DELETE", headers.get("Location"), token())
        if status != 200:
            print(queue + ": " + label + " could not be completed, HTTP " + str(status) + "; it will be delivered again")
            continue
        print(queue + ": completed " + label + ": " + describe(body))
        completed += 1
    print(queue + ": " + str(completed) + " completed, nothing more waiting")
    return True


def main():
    host, key_name, key = settings(os.environ["SB_CONNECTION"])
    scheme = os.environ.get("SB_SCHEME", "https")
    queues = [q for q in os.environ.get("QUEUES", "").split(",") if q]
    print("caj-consumer: reading " + ", ".join(queues) + " on " + host)
    ok = all([drain(scheme, host, q, key_name, key) for q in queues])
    sys.stdout.flush()
    sys.exit(0 if ok else 1)


main()
