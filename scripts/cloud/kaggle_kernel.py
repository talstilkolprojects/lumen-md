"""Lumen's real models day on a Kaggle GPU (plan W6.18).

`npm run models:cloud` pushes this file as a private Kaggle script kernel, with the run's private
dataset attached (run.json, and the held-out run copy when there is one). It installs Node, Ollama
and the repo at the asked commit, runs `npm run models:day` with the run's signing key, and leaves
one file in /kaggle/working: results.tar.gz (the sealed report and every result file), next to
cloud.json (what ran where). The runner downloads both and checks the signature.

Nothing here is secret but the dataset: the one-run signing key and the held-out run copy's key.
Both are deleted from the machine when the run ends. The held-out items never reach
/kaggle/working: the evaluator writes aggregates only.

LUMEN_CLOUD_EMULATE=1 (tests only) skips every install and download: it uses the checkout in
LUMEN_CLOUD_REPO and the Ollama at LUMEN_CLOUD_OLLAMA_URL.
"""
from __future__ import annotations

import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

EMU = os.environ.get("LUMEN_CLOUD_EMULATE") == "1"
INPUT = Path(os.environ.get("KAGGLE_INPUT", "/kaggle/input"))
WORK = Path(os.environ.get("KAGGLE_WORKING", "/kaggle/working"))
TMP = Path(os.environ.get("LUMEN_CLOUD_TMP", "/tmp/lumen"))
STATUS = WORK / "cloud.json"
state: dict = {"phase": "start", "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def save(**kw) -> None:
    state.update(kw)
    WORK.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def sh(cmd, env=None, check=True, cwd=None) -> int:
    print("$", cmd if isinstance(cmd, str) else " ".join(cmd), flush=True)
    return subprocess.run(cmd, shell=isinstance(cmd, str), env=env, check=check, cwd=cwd).returncode


def out(cmd) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception:  # noqa: BLE001 — a missing tool is "unknown"
        return ""


def wait_for(url: str, seconds: int = 120) -> None:
    for _ in range(seconds):
        try:
            with urllib.request.urlopen(f"{url}/api/version", timeout=2) as r:
                if r.status == 200:
                    return
        except Exception:  # noqa: BLE001
            time.sleep(1)
    raise SystemExit(f"Ollama did not start at {url}")


def find_run() -> Path:
    hits = sorted(glob.glob(str(INPUT / "**" / "run.json"), recursive=True))
    if not hits:
        raise SystemExit(f"run.json not found under {INPUT}: is the run's dataset attached?")
    return Path(hits[0])


def install(run: dict, env: dict) -> tuple[Path, str]:
    """Node, Ollama, ffmpeg, Python deps, the repo at the commit, npm ci, Chromium. Returns (repo, ollama url)."""
    if EMU:
        return Path(os.environ["LUMEN_CLOUD_REPO"]), os.environ["LUMEN_CLOUD_OLLAMA_URL"]
    save(phase="install")
    sh("apt-get -qq update && apt-get -qq install -y zstd ffmpeg > /dev/null", check=False)
    node = f"node-v{run['node']}-linux-x64"
    if not Path(f"/opt/{node}/bin/node").exists():
        sh(f"curl -fsSL https://nodejs.org/dist/v{run['node']}/{node}.tar.xz | tar -xJ -C /opt")
    env["PATH"] = f"/opt/{node}/bin:" + env["PATH"]
    sh("curl -fsSL https://ollama.com/install.sh | sh", env=env)
    sh([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub", "pyarrow"], env=env)
    repo = TMP / "repo"
    if not repo.exists():
        sh(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", f"https://github.com/{run['repo']}.git", str(repo)], env=env)
    sh(["git", "-C", str(repo), "-c", "advice.detachedHead=false", "checkout", "-q", run["commit"]], env=env)
    sh(["npm", "ci", "--no-audit", "--no-fund"], env=env, cwd=repo)
    sh(["npx", "playwright", "install", "--with-deps", "chromium"], env=env, cwd=repo, check=False)
    env["OLLAMA_MODELS"] = str(TMP / "ollama-models")
    env["OLLAMA_HOST"] = "127.0.0.1:11434"
    subprocess.Popen(["ollama", "serve"], env=env, stdout=open(TMP / "ollama.log", "ab"), stderr=subprocess.STDOUT)
    url = "http://127.0.0.1:11434"
    wait_for(url)
    return repo, url


def main() -> int:
    TMP.mkdir(parents=True, exist_ok=True)
    run_file = find_run()
    run = json.loads(run_file.read_text(encoding="utf-8"))
    save(runId=run["runId"], commit=run["commit"], requester=run.get("requester"))
    env = dict(os.environ)
    repo, url = install(run, env)
    sign = TMP / "sign.pem"
    sign.write_text(run["signKeyPem"], encoding="utf-8")
    os.chmod(sign, 0o600)
    if run.get("heldout"):
        env["LUMEN_HELDOUT_KEY"] = run["heldout"]["key"]
        env["LUMEN_HELDOUT_EXPORT"] = str(run_file.parent / run["heldout"]["file"])
        env["LUMEN_HELDOUT_DIR"] = str(TMP / "heldout")
        env["LUMEN_HELDOUT_TMP"] = str(TMP)
        env["LUMEN_HELDOUT_REQUESTER"] = f"{run.get('requester', '?')} via kaggle"
    day = WORK / "day"
    args = ["node", *run["dayArgs"]]
    args = [a.replace("{url}", url).replace("{out}", str(day)).replace("{signKey}", str(sign)) for a in args]
    save(phase="models-day", gpu=out(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"]) or None, ollama=out(["ollama", "--version"]) or None, node=out(["node", "--version"]) or None)
    try:
        code = sh(args, env=env, check=False, cwd=repo)
    finally:
        sign.unlink(missing_ok=True)
        shutil.rmtree(TMP / "heldout", ignore_errors=True)
    folder = day / run["runId"]
    ok = (folder / "report.json").exists()
    if ok:
        with tarfile.open(WORK / "results.tar.gz", "w:gz") as tf:
            tf.add(folder, arcname=run["runId"])
        shutil.rmtree(day, ignore_errors=True)
    save(phase="done", exit=code, finishedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), results="results.tar.gz" if (WORK / "results.tar.gz").exists() else None)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
