# lambda/rotate.py
#
# Plain English: lab 07's rotation function. Secrets Manager calls it four
# times per rotation, with the secret, a token naming the new version, and the
# step: createSecret (make the new version, labelled AWSPENDING, with a new
# password), setSecret (put the password where it is used: this lab has no
# database, so it only logs), testSecret (read the new version back) and
# finishSecret (move AWSCURRENT to it). Every step is safe to run twice.
import json

import boto3

sm = boto3.client("secretsmanager")


def handler(event, context):
    arn, token, step = event["SecretId"], event["ClientRequestToken"], event["Step"]
    meta = sm.describe_secret(SecretId=arn)
    if not meta.get("RotationEnabled"):
        raise ValueError("rotation is not enabled on this secret")
    stages = meta["VersionIdsToStages"]
    if token not in stages:
        raise ValueError("this version is not one of the secret's")
    if "AWSCURRENT" in stages[token]:
        print(f"{step}: version {token} is already current")
        return
    if "AWSPENDING" not in stages[token]:
        raise ValueError("this version is not pending")

    if step == "createSecret":
        current = json.loads(sm.get_secret_value(SecretId=arn, VersionStage="AWSCURRENT")["SecretString"])
        try:
            sm.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")
            print("createSecret: the pending version is already there")
        except sm.exceptions.ResourceNotFoundException:
            current["password"] = sm.get_random_password(PasswordLength=24, ExcludePunctuation=True)["RandomPassword"]
            sm.put_secret_value(SecretId=arn, ClientRequestToken=token, SecretString=json.dumps(current), VersionStages=["AWSPENDING"])
            print("createSecret: made the pending version")
    elif step == "setSecret":
        print("setSecret: no database in this lab; a real rotation sets the new password where it is used")
    elif step == "testSecret":
        json.loads(sm.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")["SecretString"])
        print("testSecret: the pending version reads back")
    elif step == "finishSecret":
        for version, labels in stages.items():
            if "AWSCURRENT" in labels and version != token:
                sm.update_secret_version_stage(SecretId=arn, VersionStage="AWSCURRENT", MoveToVersionId=token, RemoveFromVersionId=version)
                print(f"finishSecret: {token} is now current")
                break
    else:
        raise ValueError(f"unknown step {step}")
