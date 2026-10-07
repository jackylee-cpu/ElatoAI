#!/usr/bin/env python3
"""Publish a firmware build for OTA, and choose which release boards install.

    export SUPABASE_URL=https://elatoai.hkqft.com/supabase-api
    export SUPABASE_SERVICE_ROLE_KEY=...
    pio run -e spotpear-ai-toy
    python3 tools/release_firmware.py publish spotpear-ai-toy --notes "..."
    python3 tools/release_firmware.py promote spotpear-ai-toy 1.0.1
    python3 tools/release_firmware.py list

`publish` uploads .pio/build/<env>/firmware.bin to the private `firmware`
bucket and records it in firmware_releases. It does not roll anything out:
`promote` (or `publish --current`) makes it the release every board of that
kind installs on its next boot. See supabase/migrations/20261008100000_firmware_releases.sql
and src/OTA.cpp for the other two ends.

The version is FIRMWARE_VERSION from src/OTA.h -- bump it first; a version that
is already published for the board is refused, because a board that rolled
back from a version is never offered it again and a re-used number would
silently skip those boards. Development builds (anything pointed at a LAN
machine, or the speaker self-test) are refused too.

Standard library only.
"""

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUCKET = "firmware"

# platformio env -> BOARD_ID in src/BoardConfig.h. Only these ship.
RELEASE_ENVS = {
    "spotpear-ai-toy": "spotpear-ai-toy",
    "xmini-c3": "xmini-c3",
    "waveshare-s3-audio": "waveshare-s3-audio",
    "esp32-s3-devkitc-1": "elato-breadboard",
}


def firmware_version() -> str:
    text = (ROOT / "src" / "OTA.h").read_text()
    match = re.search(r'#define\s+FIRMWARE_VERSION\s+"([^"]+)"', text)
    if not match:
        sys.exit("FIRMWARE_VERSION not found in src/OTA.h")
    return match.group(1)


class Supabase:
    def __init__(self):
        self.url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        self.key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        if not self.url or not self.key:
            sys.exit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")

    def call(self, method, path, body=None, headers=None, raw=None):
        h = {"apikey": self.key, "Authorization": f"Bearer {self.key}"}
        data = raw
        if body is not None:
            h["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        h.update(headers or {})
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as resp:
                text = resp.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            sys.exit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:300]}")

    def releases(self, board=None):
        query = "select=release_id,board,version,size_bytes,sha256,is_current,created_at,notes&order=created_at.desc"
        if board:
            query += f"&board=eq.{board}"
        return self.call("GET", f"/rest/v1/firmware_releases?{query}")

    def promote(self, board, version):
        target = [r for r in self.releases(board) if r["version"] == version]
        if not target:
            sys.exit(f"{board} {version} is not published")
        # One current release per board (a partial unique index): clear first.
        self.call("PATCH", f"/rest/v1/firmware_releases?board=eq.{board}&is_current=eq.true",
                  {"is_current": False})
        self.call("PATCH", f"/rest/v1/firmware_releases?release_id=eq.{target[0]['release_id']}",
                  {"is_current": True})
        print(f"{board} {version} is now current: boards install it on their next boot")


def publish(args, db):
    env = args.env
    if env in RELEASE_ENVS:
        board = RELEASE_ENVS[env]
    elif args.dev:
        # A -localall build against a local stack, to try an update on a board
        # on the desk. Never against a real database.
        host = urllib.parse.urlparse(db.url).hostname
        if host not in ("localhost", "127.0.0.1"):
            sys.exit("--dev only publishes to a local Supabase")
        base = max((e for e in RELEASE_ENVS if env.startswith(e + "-")), key=len, default=None)
        if not base:
            sys.exit(f"{env} is not a variant of a release environment")
        board = RELEASE_ENVS[base]
    else:
        sys.exit(f"{env} is not a release environment ({', '.join(RELEASE_ENVS)}); "
                 "local, localws and audiotest builds never ship")
    binary = ROOT / ".pio" / "build" / env / "firmware.bin"
    if not binary.exists():
        sys.exit(f"{binary} not found; run: pio run -e {env}")
    image = binary.read_bytes()
    version = firmware_version()
    if args.version:
        if not args.dev:
            sys.exit("--version is only for --dev test builds; release versions come from src/OTA.h")
        version = args.version
    if board.encode() not in image or version.encode() not in image:
        sys.exit(f"{binary} does not carry board {board} and version {version}; rebuild it")
    if any(r["version"] == version for r in db.releases(board)):
        sys.exit(f"{board} {version} is already published; bump FIRMWARE_VERSION in src/OTA.h")

    sha256 = hashlib.sha256(image).hexdigest()
    path = f"{board}/{version}.bin"
    db.call("POST", f"/storage/v1/object/{BUCKET}/{path}", raw=image,
            headers={"Content-Type": "application/octet-stream", "x-upsert": "false"})
    db.call("POST", "/rest/v1/firmware_releases", {
        "board": board, "version": version, "storage_path": path,
        "sha256": sha256, "size_bytes": len(image), "notes": args.notes,
    })
    print(f"published {board} {version}: {len(image)} bytes, sha256 {sha256}")
    if args.current:
        db.promote(board, version)
    else:
        print(f"not rolled out yet: release_firmware.py promote {board} {version}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("publish", help="upload a build and record the release")
    p.add_argument("env", help="platformio environment, e.g. spotpear-ai-toy")
    p.add_argument("--notes", default=None)
    p.add_argument("--current", action="store_true", help="also roll it out")
    p.add_argument("--dev", action="store_true",
                   help="allow a development build (e.g. -localall); local Supabase only")
    p.add_argument("--version", help="with --dev: the version the test build was compiled with "
                                     "(PLATFORMIO_BUILD_FLAGS=-DFIRMWARE_VERSION=...)")
    p = sub.add_parser("promote", help="make a published release the one boards install")
    p.add_argument("board")
    p.add_argument("version")
    p = sub.add_parser("list", help="show published releases")
    p.add_argument("board", nargs="?")
    args = parser.parse_args()

    db = Supabase()
    if args.command == "publish":
        publish(args, db)
    elif args.command == "promote":
        db.promote(args.board, args.version)
    else:
        for r in db.releases(args.board):
            mark = "*" if r["is_current"] else " "
            print(f"{mark} {r['board']:20s} {r['version']:10s} {r['size_bytes']:>8} "
                  f"{r['created_at'][:16]}  {r['notes'] or ''}")


if __name__ == "__main__":
    main()
