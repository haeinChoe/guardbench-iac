"""Download or upload a result directory under an S3 prefix (s3://bucket/prefix/)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

from .common import Clients


def parse_s3_prefix(uri: str) -> tuple[str, str]:
    if not uri.startswith("s3://"):
        raise ValueError(f"not an S3 URI: {uri}")
    bucket, _, prefix = uri[len("s3://"):].partition("/")
    if not bucket or not prefix:
        raise ValueError(f"S3 URI needs a bucket and a prefix: {uri}")
    return bucket, prefix.rstrip("/") + "/"


def download_prefix(s3: Any, uri: str, destination: str | Path) -> list[str]:
    bucket, prefix = parse_s3_prefix(uri)
    target = Path(destination)
    target.mkdir(parents=True, exist_ok=True)
    downloaded = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"]
            relative = key[len(prefix):]
            if not relative or relative.endswith("/"):
                continue
            local = target / relative
            if target.resolve() not in local.resolve().parents:
                raise ValueError(f"refusing to write outside the destination: {key}")
            local.parent.mkdir(parents=True, exist_ok=True)
            s3.download_file(bucket, key, str(local))
            downloaded.append(relative)
    return sorted(downloaded)


def upload_directory(s3: Any, source: str | Path, uri: str) -> list[str]:
    bucket, prefix = parse_s3_prefix(uri)
    root = Path(source)
    uploaded = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            s3.upload_file(str(path), bucket, prefix + relative)
            uploaded.append(relative)
    return uploaded


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Move result files between a directory and S3.")
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download")
    download.add_argument("--prefix", required=True)
    download.add_argument("--dest", required=True)
    upload = commands.add_parser("upload")
    upload.add_argument("--prefix", required=True)
    upload.add_argument("--src", required=True)
    args = parser.parse_args(argv)
    try:
        s3 = Clients().s3
        if args.command == "download":
            files = download_prefix(s3, args.prefix, args.dest)
        else:
            files = upload_directory(s3, args.src, args.prefix)
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(f"{args.command}: {len(files)} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
