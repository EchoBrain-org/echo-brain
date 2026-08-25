#!/usr/bin/env python3
"""Validate and safely materialize a canonical clean-v1 runtime profile."""

import json
import os
import re
import stat
import sys
import tempfile

MAX_PROFILE_BYTES = 128 * 1024
MAX_FILE_BYTES = 64 * 1024
SOURCE_SHA = re.compile(r"^[0-9a-f]{40}$")
RUNTIME_PROFILE_FILES = (
    "Caddyfile.clean-v1",
    "Caddyfile.clean-v1.ec2",
    "compose.clean-v1.ec2.yaml",
    "compose.clean-v1.yaml",
)


def fail(message):
    raise ValueError("clean-v1 runtime profile: " + message)


def exact_keys(value, keys, path):
    if not isinstance(value, dict) or sorted(value) != sorted(keys):
        fail(path + " must contain exactly: " + ", ".join(sorted(keys)))


def utf8_text(value, name):
    if not isinstance(value, str):
        fail(name + " must be UTF-8 text no larger than 64 KiB")
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeEncodeError:
        fail(name + " must be UTF-8 text no larger than 64 KiB")
    if len(encoded) > MAX_FILE_BYTES:
        fail(name + " must be UTF-8 text no larger than 64 KiB")
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


def validate(value):
    exact_keys(value, ["files", "kind", "schema_version", "source_sha"], "$")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        fail("schema_version must equal integer 1")
    if value["kind"] != "echo-clean-v1-runtime-profile":
        fail("kind must be echo-clean-v1-runtime-profile")
    if not isinstance(value["source_sha"], str) or not SOURCE_SHA.fullmatch(value["source_sha"]):
        fail("source_sha is invalid")
    exact_keys(value["files"], RUNTIME_PROFILE_FILES, "files")
    for filename in RUNTIME_PROFILE_FILES:
        utf8_text(value["files"][filename], "files." + filename)
    return value


def no_duplicate_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("profile contains a duplicate JSON key")
        result[key] = value
    return result


def read(path):
    state = os.lstat(path)
    if stat.S_ISLNK(state.st_mode) or not stat.S_ISREG(state.st_mode) or state.st_size <= 0 or state.st_size > MAX_PROFILE_BYTES:
        fail("profile must be a non-empty regular non-symlink file no larger than 128 KiB")
    with open(path, "rb") as source:
        raw_bytes = source.read()
    try:
        raw = raw_bytes.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("profile is not valid UTF-8 text")
    try:
        value = validate(json.loads(raw, object_pairs_hook=no_duplicate_object))
    except json.JSONDecodeError:
        fail("profile is not valid JSON")
    if raw != canonical(value):
        fail("profile bytes are not canonical JSON followed by one newline")
    return value


def safe_directory(path, label, allow_missing=False):
    try:
        state = os.lstat(path)
    except FileNotFoundError:
        if allow_missing:
            return False
        fail(label + " is missing")
    if stat.S_ISLNK(state.st_mode) or not stat.S_ISDIR(state.st_mode):
        fail(label + " must be a non-symlink directory")
    return True


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def materialize(profile_path, target_path):
    profile = read(profile_path)
    target = os.path.abspath(target_path)
    parent = os.path.dirname(target)
    name = os.path.basename(target)
    if name in ("", ".", ".."):
        fail("target directory is unsafe")
    safe_directory(parent, "target parent directory")
    exists = safe_directory(target, "target directory", allow_missing=True)
    if exists:
        fail("target directory must not already exist")
    staging = tempfile.mkdtemp(prefix="." + name + ".", dir=parent)
    try:
        os.chmod(staging, 0o700)
        for filename in RUNTIME_PROFILE_FILES:
            destination = os.path.join(staging, filename)
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                remaining = memoryview(profile["files"][filename].encode("utf-8", "strict"))
                while remaining:
                    written = os.write(descriptor, remaining)
                    if written <= 0:
                        fail("could not write the complete materialized profile file")
                    remaining = remaining[written:]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        fsync_directory(staging)
        os.replace(staging, target)
        fsync_directory(parent)
    except Exception:
        if os.path.isdir(staging):
            for filename in os.listdir(staging):
                os.unlink(os.path.join(staging, filename))
            os.rmdir(staging)
        raise
    return profile


def main(argv):
    if not argv or argv[0] not in ("validate", "field", "materialize"):
        fail("usage: clean-v1-runtime-profile.py <validate|field|materialize> <profile> [source-sha|target-dir]")
    command = argv[0]
    if command == "validate" and len(argv) == 2:
        sys.stdout.write(canonical(read(argv[1])))
        return
    if command == "field" and len(argv) == 3 and argv[2] == "source-sha":
        sys.stdout.write(read(argv[1])["source_sha"] + "\n")
        return
    if command == "materialize" and len(argv) == 3:
        materialize(argv[1], argv[2])
        return
    fail("usage: clean-v1-runtime-profile.py <validate|field|materialize> <profile> [source-sha|target-dir]")


try:
    main(sys.argv[1:])
except (OSError, ValueError) as error:
    sys.stderr.write(str(error) + "\n")
    sys.exit(1)
