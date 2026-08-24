#!/usr/bin/env python3
"""Read the non-secret, canonical clean-v1 release record on an operator host."""

import json
import os
import re
import stat
import sys
from datetime import datetime, timezone

MAX_BYTES = 16 * 1024
SHA256 = re.compile(r"^[0-9a-f]{64}$")
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
IMAGE = re.compile(r"^[a-z0-9][a-z0-9.-]*(?:/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
RELEASE_ID = re.compile(r"^clean-v1-[a-z0-9][a-z0-9-]{2,63}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
URL = re.compile(r"^https://[^\s?#]+(?:[?#][^\s]*)?$")


def fail(message):
    raise ValueError("clean-v1 release record: " + message)


def exact_keys(value, keys, path):
    if not isinstance(value, dict) or sorted(value) != sorted(keys):
        fail(path + " must contain exactly: " + ", ".join(sorted(keys)))


def string(value, name, pattern):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        fail(name + " is invalid")
    return value


def timestamp(value, name):
    string(value, name, TIMESTAMP)
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        fail(name + " must be a UTC second timestamp")
    if parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != value:
        fail(name + " must be a UTC second timestamp")
    return value


def validate(value):
    exact_keys(value, ["authority_image", "baseline_compatibility_class", "kind", "person_client", "release_id", "released_at", "schema_version", "source_sha"], "$")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        fail("schema_version must equal integer 1")
    if value["kind"] != "echo-clean-v1-release":
        fail("kind must be echo-clean-v1-release")
    string(value["release_id"], "release_id", RELEASE_ID)
    timestamp(value["released_at"], "released_at")
    if value["baseline_compatibility_class"] != "clean-v1":
        fail("baseline_compatibility_class must equal clean-v1")
    string(value["source_sha"], "source_sha", SOURCE_SHA)
    exact_keys(value["authority_image"], ["reference"], "authority_image")
    string(value["authority_image"]["reference"], "authority_image.reference", IMAGE)
    exact_keys(value["person_client"], ["artifact_sha256", "artifact_url", "package", "version"], "person_client")
    if value["person_client"]["package"] != "@echo-brain/person-client":
        fail("person_client.package must equal @echo-brain/person-client")
    string(value["person_client"]["version"], "person_client.version", VERSION)
    string(value["person_client"]["artifact_url"], "person_client.artifact_url", URL)
    string(value["person_client"]["artifact_sha256"], "person_client.artifact_sha256", SHA256)
    return value


def read(path):
    state = os.lstat(path)
    if not stat.S_ISREG(state.st_mode) or state.st_size <= 0 or state.st_size > MAX_BYTES:
        fail("record must be a non-empty regular file no larger than 16 KiB")
    with open(path, "r", encoding="utf-8") as source:
        raw = source.read()
    try:
        value = validate(json.loads(raw))
    except json.JSONDecodeError:
        fail("record is not valid JSON")
    canonical = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    if raw != canonical:
        fail("record bytes are not canonical JSON followed by one newline")
    return value


def main(argv):
    if len(argv) not in (2, 3) or argv[0] not in ("validate", "field") or (argv[0] == "field" and len(argv) != 3):
        fail("usage: clean-v1-release.py <validate|field> <record> [authority-image|baseline-class|client-url|client-sha256|client-version]")
    record = read(argv[1])
    if argv[0] == "validate":
        sys.stdout.write(json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
        return
    fields = {
        "authority-image": record["authority_image"]["reference"],
        "baseline-class": record["baseline_compatibility_class"],
        "release-id": record["release_id"],
        "client-url": record["person_client"]["artifact_url"],
        "client-sha256": record["person_client"]["artifact_sha256"],
        "client-version": record["person_client"]["version"],
        "source-sha": record["source_sha"],
    }
    if argv[2] not in fields:
        fail("unknown field")
    sys.stdout.write(fields[argv[2]] + "\n")


try:
    main(sys.argv[1:])
except (OSError, ValueError) as error:
    sys.stderr.write(str(error) + "\n")
    sys.exit(1)
