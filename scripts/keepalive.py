# -*- coding: utf-8 -*-
"""星图保活（5173）：端口通=零动作；不通=静默拉起 vite dev。

触发方（共用本脚本，幂等防双开）：
  - HKCU Run 键 StarMap-Serve：登录即起（vite 秒级起，赶在 Lively 壁纸加载前后均可）
  - 计划任务 StarMap-keep（每 2 分钟）：看门狗，进程崩了/被误杀自动拉回
同 LoopDeck ui/dash_keepalive.py 的模式：socket 探测 + CREATE_NO_WINDOW，全程无窗口。
"""
import os
import socket
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"C:\Program Files\nodejs\node.exe"
VITE = os.path.join(ROOT, "node_modules", "vite", "bin", "vite.js")
LOG = os.path.join(ROOT, ".artifacts", "vite-keepalive.log")


def alive(port=5173):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=0.8)
        s.close()
        return True
    except OSError:
        return False


def main():
    if alive():
        return
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "ab") as out:   # 追加留痕：起没起、起了几次一眼可查（崩循环排查用）
        out.write(("--- revive %s ---\n" % __import__("time").strftime("%Y-%m-%d %H:%M:%S")).encode("utf-8"))
        out.flush()
        subprocess.Popen(
            [NODE, VITE, "--host", "127.0.0.1"],
            cwd=ROOT,
            creationflags=0x08000000,  # CREATE_NO_WINDOW：静默铁律，不闪窗
            stdout=out,
            stderr=subprocess.STDOUT,
        )


if __name__ == "__main__":
    main()
