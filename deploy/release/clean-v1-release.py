#!/usr/bin/env python3
"""Read the non-secret, canonical clean-v1 release record on an operator host."""

import hashlib
import json
import os
import pathlib
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
    required = ["authority_image", "baseline_compatibility_class", "kind", "person_client", "release_id", "released_at", "runtime_profile", "schema_version", "source_sha"]
    # The optional release-bound switch was added after clean-v1 records were
    # accepted. Preserve those canonical legacy bytes while treating absence as
    # false; a new candidate may bind the only supported runtime switch here.
    allowed = (
        sorted(required),
        sorted(required + ["agentic_ask_v1"]),
        sorted(required + ["small_scope_shortcut"]),
        sorted(required + ["agentic_ask_v1", "small_scope_shortcut"]),
    )
    if not isinstance(value, dict) or sorted(value) not in allowed:
        fail("$ must contain exactly: " + ", ".join(sorted(required + ["agentic_ask_v1", "small_scope_shortcut"])))
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
    exact_keys(value["runtime_profile"], ["artifact_sha256", "artifact_url", "profile_version"], "runtime_profile")
    string(value["runtime_profile"]["artifact_url"], "runtime_profile.artifact_url", URL)
    string(value["runtime_profile"]["artifact_sha256"], "runtime_profile.artifact_sha256", SHA256)
    if value["runtime_profile"]["profile_version"] != "clean-v1-profile-1":
        fail("runtime_profile.profile_version must equal clean-v1-profile-1")
    if "agentic_ask_v1" in value and type(value["agentic_ask_v1"]) is not bool:
        fail("agentic_ask_v1 must be boolean")
    if "small_scope_shortcut" in value and type(value["small_scope_shortcut"]) is not bool:
        fail("small_scope_shortcut must be boolean")
    if value.get("small_scope_shortcut") is True and value.get("agentic_ask_v1") is not True:
        fail("small_scope_shortcut requires agentic_ask_v1=true")
    return value


def read(path):
    state = os.lstat(path)
    if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode) or state.st_size <= 0 or state.st_size > MAX_BYTES:
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


def setup_readiness(path, accepted, candidate):
    marker = pathlib.Path(path)
    directory = os.open(marker.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parent = os.fstat(directory)
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) != 0o700:
            fail("setup readiness evidence directory is unsafe")
        fd = os.open(marker.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
    finally:
        os.close(directory)
    try:
        state = os.fstat(fd)
        if not stat.S_ISREG(state.st_mode) or state.st_uid != os.geteuid() or stat.S_IMODE(state.st_mode) != 0o600 or state.st_nlink != 1:
            fail("setup readiness evidence is unsafe")
        raw = b""
        while len(raw) <= 512:
            chunk = os.read(fd, 513 - len(raw))
            if not chunk: break
            raw += chunk
    finally:
        os.close(fd)
    if len(raw) > 512:
        fail("setup readiness evidence is too large")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        fail("setup readiness evidence is not valid JSON")
    if not isinstance(value, dict) or set(value) != {"accepted_sha256", "candidate_sha256", "setup_class"}:
        fail("setup readiness evidence shape is invalid")
    if raw != json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii") + b"\n":
        fail("setup readiness evidence is not canonical")
    if value["setup_class"] not in ("ready", "initial_onboarding"):
        fail("setup readiness evidence class is invalid")
    digest = lambda item: hashlib.sha256(pathlib.Path(item).read_bytes()).hexdigest()
    if value["candidate_sha256"] != digest(candidate):
        fail("setup readiness evidence does not match the candidate")
    if accepted == "-":
        if value["accepted_sha256"] is not None: fail("setup readiness evidence does not match the accepted release")
    elif value["accepted_sha256"] != digest(accepted):
        fail("setup readiness evidence does not match the accepted release")
    sys.stdout.write(value["setup_class"] + "\n")


def main(argv):
    if len(argv) == 4 and argv[0] == "setup-readiness":
        setup_readiness(argv[1], argv[2], argv[3]); return
    if len(argv) not in (2, 3) or argv[0] not in ("validate", "field") or (argv[0] == "field" and len(argv) != 3):
        fail("usage: clean-v1-release.py <validate|field> <record> [authority-image|baseline-class|client-url|client-sha256|client-version|runtime-profile-url|runtime-profile-sha256|runtime-profile-version|agentic-ask-v1|small-scope-shortcut]")
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
        "runtime-profile-url": record["runtime_profile"]["artifact_url"],
        "runtime-profile-sha256": record["runtime_profile"]["artifact_sha256"],
        "runtime-profile-version": record["runtime_profile"]["profile_version"],
        "agentic-ask-v1": "true" if record.get("agentic_ask_v1", False) else "false",
        "small-scope-shortcut": "true" if record.get("small_scope_shortcut", False) else "false",
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
