# -*- coding: utf-8 -*-
"""星图保活（5173）：端口通=零动作；不通=静默拉起 vite dev。

触发方（共用本脚本，幂等防双开）：
  - HKCU Run 键 StarMap-Serve：登录即起（vite 秒级起，赶在 Lively 壁纸加载前后均可）
  - 计划任务 StarMap-keep（每 2 分钟）：看门狗，进程崩了/被误杀自动拉回
  - HKCU Run 键 Lively（boot 模式，批B 10-15）：先等 5173 端口就绪再启动 Lively——
    开机时两者同时抢跑、Lively 先加载 5173 拿到连接拒绝=壁纸白屏等重试的窗口从此消除。
    vite 的启动方仍是 StarMap-Serve 键（boot 不抢跑 vite，避免双开竞态）；
    90 秒超时兜底照启 Lively（此时退回旧行为），且若端口仍不通顺手拉一把 vite。
同 LoopDeck ui/dash_keepalive.py 的模式：socket 探测 + CREATE_NO_WINDOW，全程无窗口。
"""
import os
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"C:\Program Files\nodejs\node.exe"
VITE = os.path.join(ROOT, "node_modules", "vite", "bin", "vite.js")
LIVELY = r"D:\Portable\LivelyMod\Lively.exe"
LOG = os.path.join(ROOT, ".artifacts", "vite-keepalive.log")


def alive(port=5173):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=0.8)
        s.close()
        return True
    except OSError:
        return False


def log(msg):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "ab") as out:
        out.write(("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)).encode("utf-8"))


def main():
    if alive():
        return
    log("--- revive vite ---")
    with open(LOG, "ab") as out:   # 追加留痕：起没起、起了几次一眼可查（崩循环排查用）
        subprocess.Popen(
            [NODE, VITE, "--host", "127.0.0.1"],
            cwd=ROOT,
            creationflags=0x08000000,  # CREATE_NO_WINDOW：静默铁律，不闪窗
            stdout=out,
            stderr=subprocess.STDOUT,
        )


def boot():
    """登录顺序化：等 vite 就绪（最长 90s）→ 启动 Lively；超时照启（兜底）并顺手拉 vite。"""
    deadline = time.time() + 90
    while time.time() < deadline and not alive():
        time.sleep(0.25)
    ok = alive()
    log("boot: vite %s -> start lively" % ("ready" if ok else "TIMEOUT(fallback)"))
    subprocess.Popen([LIVELY])
    if not ok:
        main()   # 90 秒还没起来（StarMap-Serve 键异常）：boot 自己兜底拉 vite


if __name__ == "__main__":
    boot() if len(sys.argv) > 1 and sys.argv[1] == "boot" else main()
