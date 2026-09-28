"""Bounded, secret-safe inspection and optional local Node installation."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "local-harness-bootstrap/0.1"}), timeout=60) as response:
        return response.read()


if "--node" in sys.argv:
    version = "24.21.0"
    name = f"node-v{version}-linux-x64.tar.xz"
    destination = ROOT / ".local"
    destination.mkdir(exist_ok=True)
    data = fetch(f"https://nodejs.org/dist/v{version}/{name}")
    sums = fetch(f"https://nodejs.org/dist/v{version}/SHASUMS256.txt").decode()
    expected = next(line.split()[0] for line in sums.splitlines() if line.endswith("  " + name))
    assert hashlib.sha256(data).hexdigest() == expected
    archive = destination / name
    archive.write_bytes(data)
    with tarfile.open(archive) as bundle:
        bundle.extractall(destination, filter="data")
    archive.unlink()
    print(json.dumps({"node": version, "sha256": expected, "path": str(destination / name.removesuffix(".tar.xz"))}))

if "--metadata" in sys.argv:
    for package in ["@opencode-ai/sdk", "@opencode-ai/plugin", "better-sqlite3", "typescript", "zod", "yaml", "vitest", "@types/node", "@types/better-sqlite3", "commander"]:
        data = json.loads(fetch("https://registry.npmjs.org/" + package.replace("/", "%2f")))
        version = data["dist-tags"]["latest"]
        print(json.dumps({"package": package, "version": version, "engines": data["versions"][version].get("engines")}))
    data = json.loads(fetch("https://crates.io/api/v1/crates/bevy/0.19.1"))["version"]
    print(json.dumps({"bevy": data["num"], "rust_version": data["rust_version"], "yanked": data["yanked"]}))

if "--config" in sys.argv:
    result = subprocess.run(["opencode", "debug", "config"], capture_output=True, text=True, timeout=90)
    if result.returncode:
        print(json.dumps({"config_inspection": "failed", "exit": result.returncode}))
    else:
        data = json.loads(result.stdout)
        print(json.dumps({"model": data.get("model"), "default_agent": data.get("default_agent"),
                          "providers": list(data.get("provider", {})), "plugin_count": len(data.get("plugin", [])),
                          "mcp_names": list(data.get("mcp", {})),
                          "agent_limits": {k: v.get("steps", v.get("maxSteps")) for k, v in data.get("agent", {}).items()}}))
    auth = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "opencode/auth.json"
    if auth.exists():
        print(json.dumps({"credential_provider_ids": list(json.loads(auth.read_text()))}))
    print(json.dumps({"credential_environment_names": [k for k in os.environ if k.endswith(("API_KEY", "AUTH_TOKEN"))]}))
