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
import http.client
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
# 引擎看护（2026-10-23）：进程活着但 hub.db 事务卡死时 8331 端口照常监听、查库 API 挂起，
# 端口探测看不见——所以引擎探活必须打 HTTP。引擎宿主由 vite enginePlugin 看护重拉，
# 这里只负责"确认死了→杀，让 vite 重拉；vite 没拉再兜底自拉"。pythonw 用引擎原进程同源
# AppData Python312（依赖装在那里），勿换 D 盘 python。
ENGINE_PORT = 8331
ENGINE_URL = "/api/overview"
ENGINE_PY = r"C:\Users\ocean.xu\AppData\Local\Programs\Python\Python312\pythonw.exe"
ENGINE_SRV = r"D:\Portable\Documents\工作管理\LoopDeck\web\server.py"
ENGINE_CWD = os.path.dirname(ENGINE_SRV)
WATCH_INTERVAL = 300          # watch 巡检周期
ENGINE_HANG_LIMIT = 1         # API 挂起即动手（8s 超时已是本地毫秒级查询的千倍余量，
                              # 挂起=真死锁；连续2轮等待只会拖长恢复，2026-10-23 收紧）


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
    # 二次确认（2026-10-21）：vite 改配置原地重启时 5173 会瞬断几秒，立刻拉起会得到
    # 端口被占的"僵尸 vite"（落到 517x 高端口，还各带一份引擎看护抢 8331）。
    # 等 4 秒复查仍不通才真拉，瞬断窗口直接放过。
    time.sleep(4)
    if alive():
        log("port back within grace, skip revive")
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


def engine_ok():
    """引擎真健康 = 查库 API 有应答（进程在端口听≠健康，见文件头注释）。"""
    try:
        c = http.client.HTTPConnection("127.0.0.1", ENGINE_PORT, timeout=8)
        c.request("GET", ENGINE_URL)
        r = c.getresponse()
        c.close()
        return r.status == 200
    except Exception:
        return False


def engine_pids():
    """解析 netstat 找 8331 监听 PID（可能 0 个=进程死了，1 个=正常/卡死）。"""
    out = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True,
                         creationflags=0x08000000).stdout.decode("mbcs", "replace")
    pids = set()
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) >= 5 and parts[0] == "TCP" and parts[1].endswith(":%d" % ENGINE_PORT) \
                and parts[3] == "LISTENING":
            pids.add(parts[4])
    return pids


def revive_engine():
    """杀卡死引擎 → 清 singletons 死锁行 → 自拉（兜底不再等 vite：实测 vite enginePlugin
    只在 vite 启动瞬间拉引擎，不做死亡重拉；2026-10-23 实证杀后 vite 静默 150s+）。
    清锁必须做：taskkill 后 Windows 可能复用旧 PID 给活进程，singleton_acquire 的
    _pid_alive 误判锁仍被持，新引擎全部自杀退出（同日实证 3 连 lock held）。"""
    pids = engine_pids()
    for pid in pids:
        subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True,
                       creationflags=0x08000000)
    log("engine stuck, killed pids=%s (journal will rollback on restart)" % ",".join(pids))
    try:  # 清 server 单例死锁行；引擎启动自会重写（busy_timeout 防 WAL 窗口）
        import sqlite3
        c = sqlite3.connect(r"D:\Portable\Documents\工作管理\LoopDeck\hub\hub.db", timeout=5)
        c.execute("PRAGMA busy_timeout=3000")
        c.execute("DELETE FROM singletons WHERE name='server'")
        c.commit()
        c.close()
    except Exception as e:
        log("clear singleton lock failed: %r (engine may exit if PID reused)" % e)
    with open(LOG, "ab") as out:
        subprocess.Popen([ENGINE_PY, "-X", "utf8", ENGINE_SRV, "--engines"],
                         cwd=ENGINE_CWD, creationflags=0x08000000,
                         stdout=out, stderr=subprocess.STDOUT)
    log("engine relaunched by keepalive")


def watch():
    """常驻看护（2026-10-23，Run 键 StarMap-Serve 无参即进此模式，替代已删的
    StarMap-keep 计划任务）：每 5 分钟 vite 端口探活（复用 main 的拉起逻辑）
    + 引擎 API 探活（连续 2 轮挂起才杀，防慢查询误杀）。多实例无害：探活幂等，
    revive 有 90s 等待窗天然错峰。"""
    hang = 0
    while True:
        main()          # vite 5173：不通拉起（原单跑逻辑，幂等）
        if engine_ok():
            hang = 0
        else:
            hang += 1
            log("engine api hang %d/%d" % (hang, ENGINE_HANG_LIMIT))
            if hang >= ENGINE_HANG_LIMIT:
                revive_engine()
                hang = 0
        time.sleep(WATCH_INTERVAL)


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
    if len(sys.argv) > 1 and sys.argv[1] == "boot":
        boot()
    elif len(sys.argv) > 1 and sys.argv[1] == "once":
        main()      # 单跑（调试用；原无参行为）
    else:
        watch()     # 无参=常驻看护（2026-10-23 起默认，Run 键 StarMap-Serve 直接生效）
