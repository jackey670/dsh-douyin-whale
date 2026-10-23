#!/usr/bin/env python3
"""douyin_http.py — 把 dy-cli 与私信驱动包装成本地 HTTP API。

为什么要有这一层
----------------
DSH 插件（Cordis）通过子进程调用 ``dy_cli``；但当上层是一个通用的 agent
（或者别的语言写的程序）时，直接调 CLI 并不方便。这个服务把同一批能力
收敛成一组 JSON 接口，只监听 ``127.0.0.1``，默认端口 7709。

接口一览
--------
只读
  GET  /health                       → 依赖自检（dy-cli / yt-dlp / ffmpeg / 私信驱动）
  GET  /status                       → 登录状态（dy-cli status 原样返回）
  POST /trending                     → 抖音热榜
  POST /search   {keyword,count,sort} → 搜索视频
  POST /detail   {id}                → 视频详情（aweme_id 或分享链接）
  POST /profile  {user}              → 用户主页

视频内容
  POST /download {aweme_id}          → 下载无水印视频，返回本地路径
  POST /frames   {aweme_id,n}        → 下载 + ffmpeg 均匀抽帧，返回帧文件路径

私信 / 群聊（Playwright 驱动，默认 dry-run，绝不默认发送）
  POST /im/status                    → 登录态 / 风控 / 私信页就绪检查
  POST /im/conversations {limit}     → 会话列表（kind=user/group）
  POST /im/groups {limit}            → 只列群聊
  POST /im/send {to,text,send}       → 发私信（send 缺省 false → dry-run）
  POST /im/group-send {group,text,send} → 群发（同上，默认 dry-run）

真实发送有两道闸，必须同时打开：
  1) 请求体 ``send=true``
  2) 服务进程环境变量 ``DOUYIN_IM_ALLOW_SEND=1``
缺任意一道，就只把文本填进输入框、截图、然后清空 —— 不会向任何人发出消息。

关于抖音视频下载（重要）
------------------------
yt-dlp 自带的 Douyin 提取器会直接请求
``https://www.douyin.com/aweme/v1/web/aweme/detail/``，该接口需要 ``a_bogus``
签名；即使带上登录 cookie，机房 IP 通常也只拿到空响应。所以这里的做法是：

  1) 用登录 cookie 请求移动端分享页
     ``https://www.iesdouyin.com/share/video/<aweme_id>/``，
     从内嵌的 ``_ROUTER_DATA`` 里解析
     ``videoInfoRes.item_list[0].video.play_addr``（这一步不需要签名）；
  2) 把地址里的 ``playwm`` 换成 ``play`` 得到无水印版，再交给 yt-dlp
     （走 generic 提取器，带 Referer / 移动端 UA）；
  3) yt-dlp 失败时退回 urllib 流式下载，保证接口仍然可用。

媒体直链带时效（通常几十分钟），因此每次都重新解析，不缓存 URL，只缓存成片。

启动
----
    # 已激活 venv 时
    python python/douyin_http.py

    # 或者显式指定
    uvicorn douyin_http:app --host 127.0.0.1 --port 7709

所有路径都可以用环境变量覆盖，见 ``.env.example`` 与 ``docs/HTTP-API.md``。
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request

from fastapi import FastAPI
from pydantic import BaseModel

# ──────────────────────────────────────────────────────────────────────
# 路径与环境
# ──────────────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(HERE)


def _env_path(name: str, default: str) -> str:
    value = (os.environ.get(name) or "").strip()
    return os.path.abspath(os.path.expanduser(value)) if value else default


DATA = _env_path("DOUYIN_DATA_DIR", os.path.join(PROJECT_ROOT, "data"))
MEDIA_DIR = _env_path("DOUYIN_MEDIA_DIR", os.path.join(DATA, "media"))
DOWNLOAD_DIR = os.path.join(MEDIA_DIR, "downloads")
FRAME_DIR = os.path.join(MEDIA_DIR, "frames")
COOKIE_JSON = _env_path(
    "DOUYIN_COOKIE_FILE", os.path.join(DATA, "home", ".dy", "cookies", "default.json")
)

# 私信驱动的数据目录：默认与插件共用同一个 data/
IM_DATA_DIR = _env_path("DOUYIN_IM_DATA_DIR", DATA)

PY = os.environ.get("DOUYIN_PYTHON") or sys.executable
# 有些环境把 `dy` 装成了独立脚本；显式给了就用，否则统一走 `python -m dy_cli.main`
DY_BIN = (os.environ.get("DOUYIN_DY_BIN") or "").strip()
YTDLP = (os.environ.get("DOUYIN_YTDLP") or "").strip() or shutil.which("yt-dlp") or ""
FFMPEG = (os.environ.get("DOUYIN_FFMPEG") or "").strip() or shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = (os.environ.get("DOUYIN_FFPROBE") or "").strip() or shutil.which("ffprobe") or "ffprobe"

IM_PY = os.path.join(HERE, "douyin_im.py")
IM_PYTHON = os.environ.get("DOUYIN_IM_PYTHON") or PY
IM_TIMEOUT = int(os.environ.get("DOUYIN_IM_TIMEOUT", "180") or 180)
IM_LOCK_WAIT = int(os.environ.get("DOUYIN_IM_LOCK_WAIT", "5") or 5)
CACHE_LIMIT_MB = int(os.environ.get("DOUYIN_CACHE_LIMIT_MB", "800") or 800)

HTTP_HOST = os.environ.get("DOUYIN_HTTP_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("DOUYIN_HTTP_PORT", "7709") or 7709)

SHARE_URL = "https://www.iesdouyin.com/share/video/{aid}/"
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
    "Mobile/15E148 Safari/604.1"
)
REFERER = "https://www.iesdouyin.com/"

# dy-cli 需要在 venv 的 PATH 里；同时保证子进程用 UTF-8 输出
DY_ENV = {
    **os.environ,
    "PATH": os.path.dirname(PY) + os.pathsep + os.environ.get("PATH", ""),
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
}

app = FastAPI(
    title="douyin HTTP API",
    description="dy-cli + Playwright 驱动的本地抖音只读 / 私信接口（默认 dry-run）",
    version="1.0.0",
)


# ──────────────────────────────────────────────────────────────────────
# 子进程小工具
# ──────────────────────────────────────────────────────────────────────
def _run(cmd, timeout=300):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _dy_command(args):
    """构造 dy-cli 调用：优先用显式指定的 `dy`，否则 `python -m dy_cli.main`。"""
    if DY_BIN:
        return [DY_BIN, *args]
    return [PY, "-m", "dy_cli.main", *args]


def run_dy(args, timeout=150):
    try:
        r = subprocess.run(
            _dy_command(args),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=DY_ENV,
            cwd=PROJECT_ROOT,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"dy 命令超时（{timeout}s）"}
    except Exception as e:  # 解释器不存在、权限不足……
        return {"ok": False, "error": str(e)}

    out = (r.stdout or "") + "\n" + (r.stderr or "")
    i = out.find("{")
    j = out.rfind("}")
    if i != -1 and j > i:
        try:
            return json.loads(out[i:j + 1])
        except Exception:
            pass
    return {"ok": False, "error": out[-600:]}


# ──────────────────────────────────────────────────────────────────────
# 请求模型
# ──────────────────────────────────────────────────────────────────────
class SearchReq(BaseModel):
    keyword: str
    count: int = 10
    sort: str = "综合"


class DetailReq(BaseModel):
    id: str


class ProfileReq(BaseModel):
    user: str


class DownloadReq(BaseModel):
    aweme_id: str


class FramesReq(BaseModel):
    aweme_id: str
    n: int = 8


class IMConvReq(BaseModel):
    limit: int = 30


class IMSendReq(BaseModel):
    to: str
    text: str
    send: bool = False


class IMGroupSendReq(BaseModel):
    group: str
    text: str
    send: bool = False


# ──────────────────────────────────────────────────────────────────────
# 健康检查 / 只读接口
# ──────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "ok": True,
        "python": PY,
        "dy": bool(DY_BIN) or os.path.exists(PY),
        "ytdlp": bool(YTDLP) and (os.path.isabs(YTDLP) or bool(shutil.which(YTDLP))),
        "ffmpeg": bool(shutil.which(FFMPEG) or os.path.exists(FFMPEG)),
        "im": os.path.exists(IM_PY),
        # 只是"是否解锁"，不代表现在会发；默认 False
        "im_send_allowed": os.environ.get("DOUYIN_IM_ALLOW_SEND") == "1",
        "im_allow_to": [x.strip() for x in (os.environ.get("DOUYIN_IM_ALLOW_TO") or "").split(",") if x.strip()],
        "data_dir": DATA,
        "cookie_present": os.path.exists(COOKIE_JSON),
    }


@app.post("/trending")
def trending():
    return run_dy(["trending", "--json-output"])


@app.post("/search")
def search(req: SearchReq):
    n = max(1, min(int(req.count or 10), 20))
    sort = req.sort if req.sort in ("综合", "最多点赞", "最新发布") else "综合"
    return run_dy(
        ["search", req.keyword, "--count", str(n), "--sort", sort, "--json-output"],
        timeout=180,
    )


@app.post("/detail")
def detail(req: DetailReq):
    return run_dy(["detail", str(req.id), "--json-output"], timeout=120)


@app.post("/profile")
def profile(req: ProfileReq):
    return run_dy(["profile", str(req.user), "--json-output"], timeout=120)


@app.get("/status")
def status():
    try:
        r = subprocess.run(
            _dy_command(["status"]),
            capture_output=True, text=True, timeout=30, env=DY_ENV, cwd=PROJECT_ROOT,
        )
        return {"ok": True, "output": ((r.stdout or "") + (r.stderr or ""))[:1200]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ──────────────────────────────────────────────────────────────────────
# cookie（dy-cli 的 Playwright storage_state，转成请求头）
# ──────────────────────────────────────────────────────────────────────
_cookie_cache = {"mtime": 0.0, "header": ""}


def _cookie_header() -> str:
    """把 storage_state 里的 cookie 拼成 Cookie 头（只取 douyin.com 域的）。"""
    try:
        st = os.stat(COOKIE_JSON)
        if _cookie_cache["mtime"] == st.st_mtime and _cookie_cache["header"]:
            return _cookie_cache["header"]
        with open(COOKIE_JSON, encoding="utf-8") as f:
            d = json.load(f)
        parts = []
        for c in d.get("cookies") or []:
            if "douyin.com" not in (c.get("domain") or ""):
                continue
            name, val = c.get("name"), c.get("value")
            if name and val is not None:
                parts.append(f"{name}={val}")
        header = "; ".join(parts)
        _cookie_cache["mtime"] = st.st_mtime
        _cookie_cache["header"] = header
        return header
    except Exception:
        return ""


# ──────────────────────────────────────────────────────────────────────
# 视频解析 / 下载 / 抽帧
# ──────────────────────────────────────────────────────────────────────
def _clean_id(raw: str) -> str:
    """aweme_id 是纯数字；也容忍粘贴了整段分享链接。"""
    s = str(raw or "").strip()
    m = re.search(r"/video/(\d{8,})", s)
    if m:
        return m.group(1)
    return re.sub(r"\D", "", s)


def _resolve_media(aweme_id: str) -> dict:
    """请求移动端分享页，从 _ROUTER_DATA 里解析无水印播放地址与视频信息。"""
    url = SHARE_URL.format(aid=aweme_id)
    req = urllib.request.Request(url, headers={
        "User-Agent": MOBILE_UA,
        "Referer": REFERER,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    ck = _cookie_header()
    if ck:
        req.add_header("Cookie", ck)

    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            html = r.read().decode("utf-8", "ignore")
    except Exception as e:
        return {"ok": False, "error": f"分享页请求失败：{e}"}

    m = re.search(r"_ROUTER_DATA\s*=\s*(\{.*?\})\s*</script>", html, re.S)
    if not m:
        return {"ok": False, "error": "分享页里没找到 _ROUTER_DATA（被风控了？）"}
    try:
        d = json.loads(m.group(1))
    except Exception as e:
        return {"ok": False, "error": f"_ROUTER_DATA 解析失败：{e}"}

    page = (d.get("loaderData") or {}).get("video_(id)/page") or {}
    items = ((page.get("videoInfoRes") or {}).get("item_list")) or []
    if not items:
        return {"ok": False, "error": "分享页没返回视频数据（视频可能已删/私密/被风控）"}

    it = items[0]
    video = it.get("video") or {}

    # 优先 play_addr（默认 720p），再退到各码率档位
    urls = list((video.get("play_addr") or {}).get("url_list") or [])
    for br in (video.get("bit_rate") or []):
        urls += list(((br.get("play_addr") or {}).get("url_list")) or [])
    if not urls:
        return {"ok": False, "error": "没拿到播放地址"}

    # 无水印：/playwm/ → /play/
    play_url = urls[0].replace("/playwm/", "/play/").replace("playwm", "play")

    author = ((it.get("author") or {}).get("nickname")) or ""
    dur_ms = video.get("duration") or it.get("duration") or 0
    try:
        duration = round(float(dur_ms) / 1000.0, 1)
    except Exception:
        duration = 0.0

    return {
        "ok": True,
        "play_url": play_url,
        "desc": str(it.get("desc") or "")[:200],
        "author": author,
        "duration": duration,
    }


def _meta_path(aweme_id: str) -> str:
    return os.path.join(DOWNLOAD_DIR, f"{aweme_id}.meta.json")


def _save_meta(aweme_id: str, meta: dict):
    """把标题/作者等元信息存成 sidecar，缓存命中时还能告诉调用方视频讲什么。"""
    try:
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        with open(_meta_path(aweme_id), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False)
    except Exception:
        pass


def _load_meta(aweme_id: str) -> dict:
    try:
        with open(_meta_path(aweme_id), encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def _prune_cache(limit_mb: int = CACHE_LIMIT_MB):
    """成片/帧攒太多就删最旧的，避免把磁盘占满。"""
    try:
        budget = limit_mb * 1024 * 1024
        for pat, extra in (
            (os.path.join(DOWNLOAD_DIR, "*.mp4"), ".meta.json"),
            (os.path.join(FRAME_DIR, "*.jpg"), None),
        ):
            files = [(os.path.getmtime(p), p, os.path.getsize(p)) for p in glob.glob(pat)]
            total = sum(sz for _, _, sz in files)
            if total <= budget:
                continue
            for _, p, sz in sorted(files):
                try:
                    os.remove(p)
                    if extra:
                        mp = p[:-len(".mp4")] + extra
                        if os.path.exists(mp):
                            os.remove(mp)
                except Exception:
                    pass
                total -= sz
                if total <= budget:
                    break
    except Exception:
        pass


def _download_sync(aweme_id: str) -> dict:
    """下载一个抖音视频（内部函数，/frames 也复用）。已经下过就直接用缓存。"""
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    _prune_cache()
    cached = os.path.join(DOWNLOAD_DIR, f"{aweme_id}.mp4")
    if os.path.exists(cached) and os.path.getsize(cached) > 100 * 1024:
        meta = _load_meta(aweme_id)
        return {
            "ok": True, "path": cached, "cached": True, "via": "cache",
            "desc": meta.get("desc", ""), "author": meta.get("author", ""),
            "duration": meta.get("duration", 0), "size": os.path.getsize(cached),
        }

    media = _resolve_media(aweme_id)
    if not media.get("ok"):
        return {"ok": False, "error": media.get("error", "解析播放地址失败")}

    url = media["play_url"]
    out_tpl = os.path.join(DOWNLOAD_DIR, f"{aweme_id}.%(ext)s")
    exe = YTDLP if YTDLP and (os.path.exists(YTDLP) or shutil.which(YTDLP)) else "yt-dlp"
    cmd = [
        exe,
        "--no-playlist", "--no-warnings", "--no-progress",
        "--referer", REFERER,
        "--user-agent", MOBILE_UA,
        "-o", out_tpl,
        url,
    ]
    err = ""
    try:
        r = _run(cmd, timeout=240)
        if r.returncode != 0:
            err = ((r.stderr or "") + (r.stdout or ""))[-400:]
    except subprocess.TimeoutExpired:
        err = "yt-dlp 超时（240s）"
    except Exception as e:
        err = str(e)

    def _finished():
        fs = [p for p in glob.glob(os.path.join(DOWNLOAD_DIR, f"{aweme_id}.*"))
              if not p.endswith((".part", ".ytdl", ".temp"))
              and os.path.getsize(p) > 100 * 1024]
        return fs[0] if fs else None

    def _ok(path, via, extra=None):
        meta = {
            "desc": media["desc"], "author": media["author"],
            "duration": media["duration"], "size": os.path.getsize(path),
        }
        _save_meta(aweme_id, meta)
        out = {"ok": True, "path": path, "cached": False, "via": via, **meta}
        if extra:
            out.update(extra)
        return out

    got = _finished()
    if got:
        return _ok(got, "yt-dlp")

    # 兜底：yt-dlp 不行就直接流式下载
    try:
        req = urllib.request.Request(url, headers={"User-Agent": MOBILE_UA, "Referer": REFERER})
        part = cached + ".part"
        with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as f:
            while True:
                buf = r.read(256 * 1024)
                if not buf:
                    break
                f.write(buf)
        os.replace(part, cached)
        if os.path.getsize(cached) > 100 * 1024:
            return _ok(cached, "urllib", {"ytdlp_error": err})
    except Exception as e:
        err = (err + " | " + str(e))[-500:]

    return {"ok": False, "error": "下载失败", "detail": err}


def _probe_duration(path: str) -> float:
    try:
        r = _run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                  "-of", "default=noprint_wrappers=1:nokey=1", path], timeout=30)
        return float((r.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def _extract_frames(path: str, aweme_id: str, n: int = 8) -> list:
    """均匀抽 n 帧（短视频抽中间、长视频均匀），返回 jpg 路径列表。"""
    os.makedirs(FRAME_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(FRAME_DIR, f"{aweme_id}_*.jpg")):
        try:
            os.remove(old)
        except Exception:
            pass

    dur = _probe_duration(path)
    if dur <= 0:
        dur = 60.0
    n = max(4, min(int(n or 8), 12))
    frames = []
    for i in range(n):
        t = dur * (i + 0.5) / n
        out = os.path.join(FRAME_DIR, f"{aweme_id}_{i}.jpg")
        try:
            _run([FFMPEG, "-y", "-ss", f"{t:.2f}", "-i", path, "-frames:v", "1",
                  "-vf", "scale=640:-2", "-q:v", "4", out], timeout=60)
            if os.path.exists(out) and os.path.getsize(out) > 1000:
                frames.append(out)
        except Exception:
            continue
    return frames


@app.post("/download")
def download(req: DownloadReq):
    """下载抖音视频到媒体目录，返回本地路径。"""
    aweme_id = _clean_id(req.aweme_id)
    if not aweme_id.isdigit():
        return {"ok": False, "error": f"aweme_id 不合法：{req.aweme_id}"}
    res = _download_sync(aweme_id)
    res["aweme_id"] = aweme_id
    return res


@app.post("/frames")
def frames(req: FramesReq):
    """下载视频并均匀抽取关键帧，只返回帧文件路径（给调用方自己喂视觉模型）。"""
    aweme_id = _clean_id(req.aweme_id)
    if not aweme_id.isdigit():
        return {"ok": False, "error": f"aweme_id 不合法：{req.aweme_id}"}

    dl = _download_sync(aweme_id)
    if not dl.get("ok"):
        return {"ok": False, "error": dl.get("error", "下载失败"), "detail": dl.get("detail", "")}

    fr = _extract_frames(dl["path"], aweme_id, req.n or 8)
    return {
        "ok": True,
        "aweme_id": aweme_id,
        "path": dl["path"],
        "frames": fr,
        "via": dl.get("via"),
        "desc": dl.get("desc", ""),
        "author": dl.get("author", ""),
        "duration": dl.get("duration", 0),
        "size": dl.get("size", 0),
    }


# ══════════════════════════════════════════════════════════════════════
# 私信 / 群聊：subprocess 调 douyin_im.py（Playwright 驱动）
# ══════════════════════════════════════════════════════════════════════
# 设计要点：
#   1) 默认 dry-run —— 请求体不带 send=true 就绝不发送；
#   2) 第二道闸在服务环境变量 DOUYIN_IM_ALLOW_SEND=1，默认不设；
#   3) 全局串行 —— 小内存机器扛不住两个 Chromium，锁等待超时直接返回 BUSY；
#   4) 超时用进程组收尸 —— 只杀 python 会让 Chromium 变成孤儿，吃满内存。
IM_ENV = {
    **os.environ,
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
    "DOUYIN_DATA_DIR": IM_DATA_DIR,
}
_im_lock = threading.Lock()


def _im_parse(out: str) -> dict | None:
    """douyin_im.py 在 stdout 只打一行 JSON；容忍前面混进 Playwright 的日志。"""
    text = (out or "").strip()
    if not text:
        return None
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                return json.loads(line)
            except Exception:
                continue
    i, j = text.find("{"), text.rfind("}")
    if i != -1 and j > i:
        try:
            return json.loads(text[i:j + 1])
        except Exception:
            pass
    return None


def run_im(args, timeout: int = IM_TIMEOUT) -> dict:
    """串行执行 douyin_im.py 子命令，返回它的 JSON 信封（ok/data 或 ok/error）。"""
    if not os.path.exists(IM_PY):
        return {"ok": False, "error": {"code": "NOT_INSTALLED",
                                       "message": f"找不到 {IM_PY}"}}
    if not _im_lock.acquire(timeout=IM_LOCK_WAIT):
        return {"ok": False, "error": {
            "code": "BUSY",
            "message": f"已有私信任务在跑（等锁 {IM_LOCK_WAIT}s 未释放），请稍后再试"}}

    started = time.time()
    proc = None
    out = err = ""
    try:
        proc = subprocess.Popen(
            [IM_PYTHON, IM_PY, *list(args)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env=IM_ENV, cwd=PROJECT_ROOT,
            # POSIX 下单独开进程组，超时才杀得干净；Windows 用 CREATE_NEW_PROCESS_GROUP
            start_new_session=(os.name != "nt"),
            creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
        )
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            try:
                proc.communicate(timeout=10)
            except Exception:
                pass
            return {"ok": False, "error": {
                "code": "TIMEOUT",
                "message": f"私信操作超时（{timeout}s），已连同浏览器一起终止；"
                           "页面可能加载缓慢或被风控拦住"}}
    except Exception as e:
        return {"ok": False, "error": {"code": "SPAWN_FAILED",
                                       "message": f"{type(e).__name__}: {e}"}}
    finally:
        _im_lock.release()

    res = _im_parse(out)
    if res is None:
        detail = ((out or "") + "\n" + (err or "")).strip()[-600:]
        return {"ok": False, "error": {
            "code": "BAD_OUTPUT",
            "message": f"douyin_im.py 没输出可解析的 JSON（exit={proc.returncode}）: {detail}"}}
    res["elapsed_ms"] = int((time.time() - started) * 1000)
    return res


def _kill_tree(proc) -> None:
    """把驱动进程和它拉起的浏览器一起收掉。"""
    try:
        if os.name != "nt":
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           capture_output=True, timeout=15)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _im_text(text: str, limit: int = 500) -> str:
    t = (text or "").strip()
    if not t:
        raise ValueError("text 不能为空")
    if len(t) > limit:
        raise ValueError(f"text 太长（{len(t)} 字 > {limit}），私信不适合一次发这么多")
    return t


def _im_do_send(cmd: str, flag: str, target: str, text: str, want_send: bool) -> dict:
    """send / group-send 共用：校验入参 → 双开关判定 → 调驱动 → 补执行模式。"""
    target = (target or "").strip()
    if not target:
        return {"ok": False, "error": {"code": "BAD_INPUT", "message": f"{flag} 不能为空"}}
    try:
        body = _im_text(text)
    except ValueError as e:
        return {"ok": False, "error": {"code": "BAD_INPUT", "message": str(e)}}

    allow = os.environ.get("DOUYIN_IM_ALLOW_SEND") == "1"
    do_send = bool(want_send) and allow
    # 用 --opt=value 形式：文本里带空格/短横线/中文都不会被 argparse 误当成选项
    args = [cmd, f"--{flag}={target}", f"--text={body}"]
    if do_send:
        args.append("--send")

    res = run_im(args)
    # 把"这次到底按什么模式跑的"写进数据区，避免调用方误读成已发送
    if isinstance(res.get("data"), dict):
        res["data"]["dry_run"] = not do_send
        res["data"]["send_requested"] = bool(want_send)
        res["data"]["send_allowed_by_server"] = allow
    if want_send and not allow:
        res["warning"] = ("服务端未开启真实发送（DOUYIN_IM_ALLOW_SEND != 1），本次按 dry-run 执行："
                          "文本填进输入框、截图、然后清空，没有发出任何消息")
    return res


@app.post("/im/status")
def im_status():
    """登录态 / 风控 / 私信页就绪检查（会真的开一次浏览器，约 10~30s）。"""
    return run_im(["status"], timeout=150)


@app.post("/im/conversations")
def im_conversations(req: IMConvReq | None = None):
    """私信会话列表（kind=user/group）。"""
    limit = max(1, min(int((req.limit if req else 30) or 30), 100))
    return run_im(["conversations", "--limit", str(limit)])


@app.post("/im/groups")
def im_groups(req: IMConvReq | None = None):
    """只列群聊会话。"""
    limit = max(1, min(int((req.limit if req else 30) or 30), 100))
    return run_im(["groups", "--limit", str(limit)])


@app.post("/im/send")
def im_send(req: IMSendReq):
    """给单个用户发私信。默认 dry-run（只填框 + 截图 + 清空）。"""
    return _im_do_send("send", "to", req.to, req.text, req.send)


@app.post("/im/group-send")
def im_group_send(req: IMGroupSendReq):
    """给群聊发消息。默认 dry-run；打开的是个人会话会直接 NOT_GROUP 中止。"""
    return _im_do_send("group-send", "group", req.group, req.text, req.send)


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=HTTP_HOST, port=HTTP_PORT, log_level="info")


if __name__ == "__main__":
    main()
