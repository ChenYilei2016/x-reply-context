#!/usr/bin/env python3
"""《X 社交打工人 · 上岗培训》一键出片：HTML 分镜(Chrome 无头截图) + macOS TTS 旁白 + ffmpeg 合成与烧字幕。

每个分段由若干「拍」组成：一拍 = 一张画面 + 一句旁白，画面随旁白逐拍切换。

用法：python3 make.py                  # 全量生成 out/ep02.mp4、out/cover.png、out/ep02.srt
      python3 make.py --frames-only     # 只出分镜图和 contact sheet，便于先看画面
只依赖 Python 标准库、Google Chrome、ffmpeg/ffprobe、say。可重复执行，不改动仓库其他文件。
"""
import argparse, html, json, re, shutil, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
BUILD = HERE / "build"
OUT = HERE / "out"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H, FPS = 1920, 1080, 30
GAP = 0.35   # 拍与拍之间的停顿
VOICE, RATE = "Tingting", 210
REPO_URL = "github.com/ChenYilei2016/x-reply-context"

BG, FG, MUTED = "#0f1419", "#e7e9ea", "#8b98a5"
BLUE, PINK, GREEN, YELLOW, RED = "#1d9bf0", "#f91880", "#00ba7c", "#ffd400", "#f4212e"

# ---------- 分镜：每拍 (画面序号, 旁白, 字幕[, 选项]) ；字幕用 | 分句，旁白省略时读字幕 ----------
def B(f, sub, vo=None, **kw):
    return dict(f=f, sub=sub, vo=vo or sub.replace("|", "，"), **kw)

SEGMENTS = [
    dict(id="s01", lesson="", beats=[
        B(0, "早上九点，打开 X|通知：99+", "早上九点，打开X。通知：九十九加。"),
        B(1, "我盯着第一条想了三秒|这个人……我回过没有？", "我盯着第一条想了三秒。这个人，我回过没有？"),
        B(2, "我的记忆，返回了 404", "我的记忆，返回了：四零四。", gap=0.8),
    ]),
    dict(id="s02", lesson="", beats=[
        B(0, "所以今天，我们来上一堂|《X 社交打工人 · 上岗培训》", "所以今天，我们来上一堂，X社交打工人，上岗培训。"),
        B(0, "讲师是一个 Chrome 插件|名字叫：回过了", "讲师是一个Chrome插件，名字叫：回过了。", gap=0.7),
    ]),
    dict(id="s03", lesson="第 1 课 · 先关噪音", beats=[
        B(0, "第一课：先把噪音关掉"),
        B(1, "点赞、关注消息默认隐藏|转发，想藏也能藏", "点赞和关注消息，默认隐藏。转发，想藏也能藏。"),
        B(2, "别人点赞，我很感激|但它真的不需要我回一句：谢谢你的赞", "别人点赞，我很感激。但它真的不需要我回一句：谢谢你的赞。", gap=0.6),
    ]),
    dict(id="s04", lesson="第 2 课 · 社交记账", beats=[
        B(0, "第二课：记账|回过的，标「文字-已回」|点过红心的，标「红心-已点」", "第二课：记账。回过的，标文字已回。点过红心的，标红心已点。"),
        B(1, "我评他几篇、他评我几篇|同一篇夸三次，也只算一篇", "我评他几篇，他评我几篇。同一篇夸三次，也只算一篇。"),
        B(2, "第一次来的新朋友，亮一个 NEW|社交关系，终于有了账本", "第一次来的新朋友，亮一个new。社交关系，终于有了账本。", gap=0.6),
    ]),
    dict(id="s05", lesson="第 3 课 · 嘴替", beats=[
        B(0, "第三课：嘴替|六组快捷短语，Option 加 1 到 6", "第三课：嘴替。六组快捷短语，option加一到六。"),
        B(0, "一起加油鸭、哈哈、难受啊|太卷了、可爱捏", "一起加油鸭。哈哈。难受啊。太卷了。可爱捏。"),
        B(1, "以及：不许色色", "以及，不许色色。", gap=0.7),
        B(2, "互联网社交的一大半|靠这六句就能撑住|数据来源：我瞎说的", "互联网社交的一大半，靠这六句就能撑住。数据来源：我瞎说的。", gap=0.6),
    ]),
    dict(id="s06", lesson="第 4 课 · 憋不出来怎么办", beats=[
        B(0, "实在憋不出来？按 Option 加 Q|让你自己配置的 AI 推荐一句", "实在憋不出来？按option加Q，让你自己配置的AI，推荐一句。"),
        B(1, "它只往草稿里写|发不发，你说了算", "它只往草稿里写。发不发，你说了算。"),
        B(2, "AI 负责憋词|我负责做人", "AI负责憋词，我负责做人。", gap=0.7),
    ]),
    dict(id="s07", lesson="第 5 课 · 招牌动作", beats=[
        B(0, "第五课，招牌动作：点赞发送下条"),
        B(1, "写好回复，点一下|先点赞，再发送，成功了才去下一条", "写好回复，点一下。先点赞，再发送，成功了，才去下一条。"),
        B(2, "点过的不重复点|不想回，就跳过", "点过的不重复点。不想回，就跳过。"),
        B(3, "出了问题就停下，不自动重试|它很勤快，但不莽", "出了问题就停下，不自动重试。它很勤快，但不莽。", gap=0.7),
    ]),
    dict(id="s08", lesson="第 6 课 · 伴随主页", beats=[
        B(0, "第六课：伴随主页|聊着聊着，想看看他平时都发些啥？", "第六课：伴随主页。聊着聊着，想看看他平时都发些啥？"),
        B(1, "点一下，旁边弹出他的 X 主页|左边的通知和草稿，原地不动", "点一下，旁边弹出他的X主页。左边的通知和草稿，原地不动。"),
        B(2, "同一个人只唤起，换人就复用这一个窗口|不会越点越多，我的内存表示感谢", "同一个人只唤起，换人就复用这一个窗口。不会越点越多，我的内存表示感谢。"),
        B(3, "小提醒：换人前，右边的草稿请自己保存", "小提醒：换人前，右边的草稿，请自己保存。", gap=0.6),
    ]),
    dict(id="s09", lesson="员工守则", beats=[
        B(0, "最后，员工守则|每一条，都由你读、你写、你点发送|记录只存在本机", "最后，员工守则。每一条，都由你读、你写、你点发送。记录只存在本机。"),
        B(1, "它帮你记性，不帮你刷量|批量引流？出门左转，不送", "它帮你记性，不帮你刷量。批量引流？出门左转，不送。", gap=0.7),
    ]),
    dict(id="s10", lesson="开发者汇报", beats=[
        B(0, "顺便汇报：开源六天，三十次提交|从 0.4.1 一路更新到 0.17.1", "顺便汇报：开源六天，三十次提交，从零点四点一，一路更新到零点一七点一。"),
        B(1, "至于作者本人的社交时间……|大概都花在写这个插件上了", "至于作者本人的社交时间，大概，都花在写这个插件上了。", gap=0.8),
    ]),
    dict(id="s11", lesson="结业", beats=[
        B(0, "代码开源在 GitHub，链接放在简介|下载安装包，Chrome 里加载扩展，刷新 X|四步上岗", "代码开源在GitHub，链接放在简介。下载安装包，在Chrome里加载扩展，刷新X，四步上岗。"),
        B(1, "插件能记住你回过谁|但记不住你有没有点 Star", "插件能记住你回过谁，但记不住，你有没有点star。"),
        B(1, "这一步，只能靠你自己了|培训结束，祝各位：该回的回，回过了就安心", "这一步，只能靠你自己了。培训结束。祝各位，该回的回，回过了，就安心。", gap=2.6),
    ]),
]

# ---------- 剪辑版本：(分段, 拍序号[, 覆盖字段]) ；未列出的拍不进入该版本 ----------
CUTS = {
    # X 短版：约 1.5 分钟，只留钩子 + 核心功能 + 结尾推广
    "x": dict(rate=235, beats=[
        ("s01", 0), ("s01", 1), ("s01", 2), ("s02", 0), ("s02", 1),
        ("s03", 1), ("s04", 0), ("s04", 2),
        ("s05", 0), ("s05", 2), ("s05", 3),
        ("s07", 0), ("s07", 1), ("s07", 3, dict(gap=0.4)),
        ("s08", 1, B(1, "伴随主页：点一下，旁边弹出他的 X 主页|左边的通知和草稿，原地不动",
                     "伴随主页：点一下，旁边弹出他的X主页。左边的通知和草稿，原地不动。")),
        ("s08", 2), ("s09", 1),
        ("s11", 0, B(0, "开源免费，GitHub 搜 x-reply-context", "开源免费，GitHub搜，x reply context。")),
        ("s11", 1),
        ("s11", 2, B(1, "这一步，只能靠你自己了", "这一步，只能靠你自己了。", gap=2.0)),
    ]),
}

def cut_beats(cut):
    """返回 [(拍 id, 分段 id, 拍)]；无剪辑版本时为全部拍。"""
    if not cut:
        return [(f"{s['id']}_{k}", s["id"], b) for s in SEGMENTS for k, b in enumerate(s["beats"])]
    segs = {s["id"]: s for s in SEGMENTS}
    out = []
    for item in CUTS[cut]["beats"]:
        sid, k, *ov = item
        beat = {**segs[sid]["beats"][k], **(ov[0] if ov else {})}
        out.append((f"{sid}_{k}", sid, beat))
    return out

# ---------- 样式 ----------
CSS = f"""
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:{W}px;height:{H}px;overflow:hidden;background:{BG};color:{FG};
 font-family:"PingFang SC","Hiragino Sans GB","Heiti SC",sans-serif}}
body{{background:radial-gradient(1200px 700px at 50% 40%,#16202a 0%,{BG} 70%)}}
.tag{{position:absolute;left:56px;top:44px;font-size:30px;font-weight:700;letter-spacing:2px;color:{BLUE}}}
.tag b{{color:{FG};font-weight:600}}
.note{{position:absolute;right:56px;top:46px;font-size:24px;color:{MUTED};border:2px solid #2f3336;padding:6px 16px;border-radius:8px}}
.stage{{position:absolute;left:0;right:0;top:110px;bottom:190px;display:flex;align-items:center;justify-content:center;flex-direction:column}}
.huge{{font-size:220px;font-weight:900;line-height:1}}
.big{{font-size:112px;font-weight:800;line-height:1.15;text-align:center}}
.mid{{font-size:62px;font-weight:700;text-align:center;line-height:1.35}}
.small{{font-size:36px;color:{MUTED};margin-top:28px;text-align:center}}
.b{{color:{BLUE}}} .p{{color:{PINK}}} .g{{color:{GREEN}}} .y{{color:{YELLOW}}} .r{{color:{RED}}} .m{{color:{MUTED}}}
.mono{{font-family:"SF Mono",Menlo,monospace}}
.card{{background:#16181c;border:2px solid #2f3336;border-radius:22px;padding:40px 56px}}
.light{{background:#fff;color:#0f1419;border-radius:22px;box-shadow:0 30px 80px rgba(0,0,0,.55)}}
.shot{{position:relative;border-radius:18px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.55);border:3px solid #2f3336;background:#fff}}
.shot img{{display:block}}
.chip{{display:inline-block;border:1.5px solid #cfd9de;border-radius:8px;padding:4px 12px;margin:0 6px 0 0;font-size:26px;color:#0f1419;background:#f7f9f9;white-space:nowrap}}
.c-mine{{background:#1565c0;color:#fff;border-color:#1565c0;font-weight:700}}
.c-done{{background:#e6f6ee;border-color:#8fd3b0;font-weight:700}}
.c-heart{{background:#fde8ef;border-color:#f3a3bd;font-weight:700}}
.c-new{{background:#ffd76a;border-color:#d8a300;border-radius:999px;font-weight:800}}
.btn{{display:inline-flex;align-items:center;justify-content:center;border-radius:999px;font-weight:700;padding:14px 34px;font-size:32px;border:2px solid #cfd9de;color:#0f1419;background:#fff;white-space:nowrap}}
.btn-main{{background:#0f6fae;border-color:#0f6fae;color:#fff}}
.kbd{{display:inline-block;font-family:"SF Mono",Menlo,monospace;font-size:.62em;color:#536471;margin-left:8px}}
.stamp{{position:absolute;font-weight:900;color:{RED};border:8px solid {RED};border-radius:14px;padding:6px 26px;transform:rotate(-12deg);font-size:72px;background:rgba(15,20,25,.25)}}
.glow{{box-shadow:0 0 0 6px rgba(29,155,240,.45),0 0 60px rgba(29,155,240,.6)}}
.row{{display:flex;align-items:center}}
"""

def page(body, tag="", note=""):
    t = f'<div class="tag">回过了 · 上岗培训{" <b>" + tag + "</b>" if tag else ""}</div>'
    n = f'<div class="note">{note}</div>' if note else ""
    return f'<!doctype html><meta charset="utf-8"><style>{CSS}</style><body>{t}{n}{body}</body>'

esc = html.escape

def img(rel):
    return (REPO / rel).as_uri()

def chips(*items):
    cls = {"我原帖": "c-mine", "文字-已回": "c-done", "红心-已点": "c-heart", "NEW": "c-new"}
    return "".join(f'<span class="chip {cls.get(i, "")}">{esc(i)}</span>' for i in items)

def logo(size=120):
    return (f'<div style="width:{size}px;height:{size}px;border-radius:{size*.26}px;background:#000;border:3px solid #2f3336;'
            f'display:flex;align-items:center;justify-content:center;font-size:{size*.62}px;font-weight:800;color:#fff">𝕏</div>')

def notif_row(icon, color, who, text, fade=False, extra=""):
    op = "opacity:.18;text-decoration:line-through" if fade else ""
    return (f'<div class="row" style="gap:26px;padding:16px 30px;border-bottom:1.5px solid #eff3f4;font-size:32px;{op}">'
            f'<span style="font-size:40px;width:48px;color:{color}">{icon}</span><b>{esc(who)}</b>'
            f'<span style="color:#536471">{esc(text)}</span>{extra}</div>')

def composer(draft, draft_style="", ai="推荐评论", main_glow=False, ai_glow=False, companion_glow=False, phrase_glow=None):
    phrases = ["一起加油", "哈哈", "难受啊", "太卷了", "可爱捏", "不许色色"]
    ph = "".join(
        f'<span class="chip{" glow" if phrase_glow == i else ""}" style="font-weight:700;border-radius:999px;padding:6px 16px">{p}<span class="kbd">⌥{i+1}</span></span>'
        for i, p in enumerate(phrases))
    return f"""<div class="light" style="width:1240px;padding:40px 48px">
      <div style="font-size:30px;margin-bottom:18px">回复 <b>@carol</b>：第一次来，这个思路很有意思！</div>
      <div style="border:2px solid #cfd9de;border-radius:12px;height:150px;padding:18px 22px;font-size:34px;{draft_style}">{draft}</div>
      <div style="margin:22px 0 18px">{ph}</div>
      <div class="row" style="gap:16px">
        <span class="btn{" glow" if ai_glow else ""}" style="border-color:#9ac9ec;background:#eef7fd;color:#0f6fae;min-width:260px">{ai}<span class="kbd">⌥Q</span></span>
        <span class="btn">♡ 点赞</span><span class="btn">跳过</span>
        <span class="btn btn-main{" glow" if main_glow else ""}">点赞发送下条</span>
        <span class="btn{" glow" if companion_glow else ""}" style="font-size:28px;padding:12px 26px;color:#0f6fae">伴随主页 ↗</span></div>
      <div style="margin-top:20px">{chips("我原帖", "文字-待确认", "红心-待确认", "我评他 0", "他评我 1", "NEW")}</div>
    </div>"""

def window(title, body, w, h, accent="#2f3336"):
    return f"""<div style="width:{w}px;height:{h}px;border-radius:16px;overflow:hidden;background:#fff;color:#0f1419;border:4px solid {accent};box-shadow:0 30px 80px rgba(0,0,0,.55)">
      <div class="row" style="gap:10px;height:52px;padding:0 18px;background:#eceff1;font-size:22px;color:#536471">
        <span style="width:14px;height:14px;border-radius:7px;background:#ff5f57"></span><span style="width:14px;height:14px;border-radius:7px;background:#febc2e"></span>
        <span style="width:14px;height:14px;border-radius:7px;background:#28c840"></span><span style="margin-left:14px">{title}</span></div>{body}</div>"""

def frames(sid):
    """返回该分段各拍的 HTML 画面。"""
    if sid == "s01":
        bell = f"""<div style="position:relative"><div style="font-size:300px;line-height:1">🔔</div>
          <div style="position:absolute;right:-90px;top:-10px;background:{RED};color:#fff;font-size:96px;font-weight:900;border-radius:999px;padding:4px 36px">99+</div></div>"""
        return [
            page(f'<div class="stage">{bell}<div class="small">09:00 · 打开 X · 通知</div></div>'),
            page(f"""<div class="stage"><div class="light" style="width:1100px;padding:10px 0">
                {notif_row("💬", BLUE, "Dave", "回复了你：哈哈哈哈哈这个我懂")}</div>
                <div class="big" style="margin-top:70px">我……回过他吗<span class="y">？</span></div></div>"""),
            page(f"""<div class="stage"><div class="huge mono r">404</div>
                <div class="mid" style="margin-top:30px">Memory Not Found</div><div class="small">大脑：这条记录已被自动清理</div></div>"""),
        ]
    if sid == "s02":
        return [page(f"""<div class="stage"><div class="row" style="gap:56px">{logo(190)}
            <div><div style="font-size:150px;font-weight:900;line-height:1.05">回过了</div><div class="mid m" style="text-align:left;font-size:48px">X 通知助手 · Chrome 插件</div></div></div>
            <div class="card" style="margin-top:70px;font-size:54px;font-weight:800;padding:26px 60px">《X 社交打工人 · <span class="b">上岗培训</span>》</div></div>""")]
    if sid == "s03":
        rows = [("♥", PINK, "Alice 等 12 人", "喜欢了你的帖子", True), ("👤", BLUE, "Bob", "关注了你", True),
                ("💬", BLUE, "Carol", "回复了你：第一次来，这个思路很有意思！", False), ("♥", PINK, "Dave 等 7 人", "喜欢了你的回复", True),
                ("👤", BLUE, "Erin 等 3 人", "关注了你", True), ("💬", BLUE, "Frank", "回复了你：具体怎么用呢？", False),
                ("♥", PINK, "Grace", "喜欢了你的帖子", True)]
        def lst(filtered):
            return "".join(notif_row(i, c, w, t, fade=filtered and f) for i, c, w, t, f in rows)
        return [
            page(f'<div class="stage"><div class="light" style="width:1180px;padding:6px 0">{lst(False)}</div></div>',
                 tag="第 1 课", note="功能示意 · 虚构账号"),
            page(f"""<div class="stage"><div class="row" style="gap:60px"><div class="light" style="width:1180px;padding:6px 0">{lst(True)}</div>
                <div><div class="mid" style="text-align:left">7 条<br>→ <span class="g">2 条</span></div><div class="small" style="text-align:left">只剩真正<br>要说话的</div></div></div></div>""",
                 tag="第 1 课", note="点赞/关注默认隐藏 · 转发可选"),
            page(f"""<div class="stage"><div class="row" style="gap:90px"><div class="shot" style="width:372px;height:754px">
                <img src="{img('assets/readme/notification-settings-0.15.3.png')}" width="372" height="754"></div>
                <div><div class="mid" style="text-align:left">「谢谢你的赞」<br><span class="r" style="text-decoration:line-through">需要回复吗？</span></div>
                <div class="big g" style="text-align:left;margin-top:30px">不需要。</div></div></div></div>""",
                 tag="第 1 课", note="扩展弹窗 · 实际界面截图"),
        ]
    if sid == "s04":
        shot = f'<div class="shot" style="width:665px;height:711px"><img src="{img("assets/readme/notifications.jpg")}" width="665" height="711"></div>'
        return [
            page(f"""<div class="stage"><div class="row" style="gap:80px">{shot}<div style="font-size:50px;line-height:2.2;font-weight:700">
                <div>{chips("文字-已回")} 回过了</div><div>{chips("红心-已点")} 赞过了</div><div>{chips("文字-待确认")} 还没找到证据</div></div></div></div>""",
                 tag="第 2 课", note="本地演示 · 虚构账号"),
            page(f"""<div class="stage"><div class="light" style="padding:50px 70px;zoom:2.4">{chips("我评他 1", "他评我 2")}</div>
                <div class="mid" style="margin-top:70px">同一篇夸 <span class="p">3</span> 次 = <span class="b">1</span> 篇</div>
                <div class="small">按对方的不同原帖去重 · 本插件不负责刷绩点</div></div>""", tag="第 2 课"),
            page(f"""<div class="stage"><div class="light" style="padding:44px 70px"><span class="chip c-new" style="font-size:90px;padding:10px 50px">NEW</span></div>
                <div class="mid" style="margin-top:60px">社交关系，终于有了<span class="y">账本</span> 📒</div>
                <div class="small">仅基于本浏览器读取到的记录 · 「待确认」≠ 没互动过</div></div>""", tag="第 2 课"),
        ]
    if sid == "s05":
        def grid(hot=None):
            ps = ["一起加油鸭", "哈哈", "难受啊", "太卷了", "可爱捏", "不许色色"]
            cells = "".join(
                f'<div class="card{" glow" if hot == i else ""}" style="width:470px;padding:34px 40px;{"border-color:" + PINK if hot == i else ""}">'
                f'<div class="mono m" style="font-size:30px">⌥ {i+1}</div><div style="font-size:66px;font-weight:800;margin-top:6px">{p}</div></div>'
                for i, p in enumerate(ps))
            return f'<div style="display:grid;grid-template-columns:repeat(3,470px);gap:34px">{cells}</div>'
        return [
            page(f'<div class="stage">{grid()}<div class="small">只在你点击或按键时填入草稿 · 不会自动发送</div></div>', tag="第 3 课"),
            page(f'<div class="stage" style="position:relative">{grid(5)}<div class="stamp" style="right:150px;bottom:-30px;font-size:60px">本课重点</div></div>', tag="第 3 课"),
            page(f"""<div class="stage"><div class="row" style="gap:90px">
                <div style="width:440px;height:440px;border-radius:50%;background:conic-gradient({BLUE} 0 78%,#2f3336 78% 100%)"></div>
                <div><div class="big" style="text-align:left"><span class="b">一大半</span></div><div class="mid" style="text-align:left">的社交 ≈ 这 6 句</div>
                <div class="small" style="text-align:left">* 数据来源：我瞎说的</div></div></div></div>""", tag="第 3 课"),
        ]
    if sid == "s06":
        return [
            page(f'<div class="stage">{composer("<span style=\'color:#536471\'>（脑子一片空白）</span>", ai="⟳ 生成中…", ai_glow=True)}</div>',
                 tag="第 4 课", note="功能示意 · AI 需自带 API"),
            page(f"""<div class="stage">{composer("谢谢喜欢！这个思路我也是踩了好几次坑才摸出来的", ai_glow=False)}
                <div class="mid" style="margin-top:40px;font-size:52px">写进草稿 ✅　自动发送 <span class="r">✗</span></div></div>""",
                 tag="第 4 课", note="功能示意 · 虚构内容"),
            page(f"""<div class="stage"><div class="row" style="gap:60px">
                <div class="card" style="width:620px;text-align:center"><div style="font-size:90px">🤖</div><div class="mid b">AI</div><div class="mid" style="font-size:54px">负责憋词</div></div>
                <div class="card" style="width:620px;text-align:center"><div style="font-size:90px">🙋</div><div class="mid y">我</div><div class="mid" style="font-size:54px">负责做人</div></div></div></div>""", tag="第 4 课"),
        ]
    if sid == "s07":
        steps = [("✍️", "你写好", FG), ("♥", "点赞", PINK), ("➤", "发送", BLUE), ("⏭", "下一条", GREEN)]
        def pipe(n):
            out = []
            for i, (ic, t, c) in enumerate(steps):
                on = i < n
                out.append(f'<div class="card" style="width:300px;text-align:center;{"" if on else "opacity:.25"}"><div style="font-size:96px;color:{c}">{ic}</div>'
                           f'<div style="font-size:46px;font-weight:800;margin-top:10px">{t}</div></div>')
                if i < len(steps) - 1:
                    out.append(f'<div style="font-size:60px;color:{MUTED};{"" if i + 1 < n else "opacity:.25"}">→</div>')
            return f'<div class="row" style="gap:28px">{"".join(out)}</div>'
        return [
            page(f'<div class="stage">{composer("欢迎常来！具体用法我整理在置顶了", main_glow=True)}</div>', tag="第 5 课", note="功能示意 · 虚构账号"),
            page(f'<div class="stage">{pipe(4)}<div class="small">每一步成功了，才走下一步</div></div>', tag="第 5 课"),
            page(f"""<div class="stage"><div class="row" style="gap:60px">
                <div class="card" style="width:720px;padding:56px 64px"><div class="big p" style="text-align:left;font-size:88px">♥ 已点过</div><div class="small" style="text-align:left;font-size:44px">不重复点，也不会取消</div></div>
                <div class="card" style="width:720px;padding:56px 64px"><div class="big" style="text-align:left;font-size:88px">⤼ 跳过</div><div class="small" style="text-align:left;font-size:44px">不想回？不记为已回</div></div></div></div>""", tag="第 5 课"),
            page(f"""<div class="stage"><div class="card mono" style="font-size:54px;line-height:1.9;width:1300px">
                <div><span class="g">✓</span> 点赞成功 · 已保存</div><div><span class="r">✗</span> 发送结果不明</div>
                <div><span class="y">⏸</span> 已暂停 · 不自动重试</div></div>
                <div class="big" style="margin-top:50px">勤快，<span class="b">但不莽</span></div></div>""", tag="第 5 课", note="功能示意"),
        ]
    if sid == "s08":
        left = window("x.com/notifications", f"""<div style="padding:24px">{notif_row("💬", BLUE, "Carol", "回复了你")}
            <div style="margin:20px 12px;border:2px solid #cfd9de;border-radius:10px;padding:16px;font-size:28px;height:120px">写到一半的草稿……</div>
            <div style="margin-left:12px"><span class="btn" style="font-size:26px;padding:10px 24px;color:#0f6fae">伴随主页 ↗</span></div></div>""", 780, 620)
        def right(name, accent=BLUE):
            posts = "".join(f'<div style="padding:18px 26px;border-bottom:1.5px solid #eff3f4;font-size:26px"><b>{name}</b> <span style="color:#536471">· {d}</span><div style="margin-top:6px">{t}</div></div>'
                            for d, t in [("1 小时", "今天又重构了一遍，心态平和"), ("昨天", "有人知道这个报错吗……"), ("3 天", "周末去爬山了 🏔")])
            return window(f"x.com/{name.lower()}", f'<div style="height:120px;background:#cfe8fa"></div>{posts}', 760, 620, accent)
        return [
            page(f'<div class="stage"><div style="font-size:180px">🤔</div><div class="mid" style="margin-top:20px">他平时，都发些啥？</div></div>', tag="第 6 课"),
            page(f'<div class="stage"><div class="row" style="gap:50px">{left}{right("Carol")}</div></div>', tag="第 6 课", note="功能示意 · 不代表自动分屏"),
            page(f"""<div class="stage"><div class="row" style="gap:70px">
                <div class="card" style="width:640px;text-align:center"><div class="m" style="font-size:40px">别的做法</div><div style="font-size:120px;font-weight:900" class="r">27</div><div style="font-size:40px">个标签页</div></div>
                <div class="card" style="width:640px;text-align:center;border-color:{BLUE}"><div class="m" style="font-size:40px">伴随主页</div><div style="font-size:120px;font-weight:900" class="b">1</div><div style="font-size:40px">个窗口，换人复用</div></div></div>
                <div class="small">同一个人：只唤起 · 换一个人：原窗口直接打开新主页</div></div>""", tag="第 6 课"),
            page(f"""<div class="stage"><div class="row" style="gap:50px">{left}<div style="position:relative">{right("Frank", YELLOW)}
                <div class="stamp" style="left:150px;top:420px;font-size:56px;color:{YELLOW};border-color:{YELLOW}">草稿自己存</div></div></div></div>""",
                 tag="第 6 课", note="插件不检查、不代存右侧草稿"),
        ]
    if sid == "s09":
        rules = [("📖", "每一条，你自己读"), ("✍️", "每一句，你自己写"), ("👆", "每次发送，你自己点"), ("💾", "记录只存在本机")]
        r = "".join(f'<div style="margin:18px 0"><span style="display:inline-block;width:90px">{i}</span>{t}</div>' for i, t in rules)
        return [
            page(f'<div class="stage"><div class="card" style="font-size:58px;font-weight:700;width:1100px">{r}</div></div>', tag="员工守则"),
            page(f"""<div class="stage" style="position:relative"><div class="row" style="gap:70px">
                <div class="card" style="width:620px;text-align:center;border-color:{GREEN}"><div style="font-size:100px">📒</div><div class="mid g">记性外挂</div></div>
                <div class="card" style="width:620px;text-align:center;position:relative;opacity:.8"><div style="font-size:100px">🤖🤖🤖</div><div class="mid">批量水军</div>
                <div class="stamp" style="right:-40px;top:-50px">不送</div></div></div>
                <div class="small">网页脚本接入存在平台规范风险 · 使用前请阅读 README 的风险说明</div></div>""", tag="员工守则"),
        ]
    if sid == "s10":
        items = [("6", "天"), ("30", "次提交"), ("0.17.1", "当前版本")]
        cells = "".join(f'<div style="text-align:center;width:480px"><div style="font-size:120px;font-weight:900" class="b">{n}</div><div style="font-size:40px;color:{MUTED}">{l}</div></div>' for n, l in items)
        return [
            page(f'<div class="stage"><div class="row" style="gap:30px">{cells}</div><div class="small">GitHub 公开仓库 · 2026-10-21 → 2026-10-26</div></div>', tag="开发者汇报"),
            page(f"""<div class="stage"><div class="card" style="width:1300px">
                <div style="font-size:46px;font-weight:700;margin-bottom:22px">作者本人的社交时间</div>
                <div style="height:70px;border-radius:12px;background:#2f3336;overflow:hidden"><div style="width:3%;height:100%;background:{PINK}"></div></div>
                <div class="row" style="justify-content:space-between;font-size:32px;color:{MUTED};margin-top:16px"><span>聊天</span><span>写插件 ████████████ 97%</span></div></div>
                <div class="small">* 数据来源：还是我瞎说的</div></div>""", tag="开发者汇报"),
        ]
    if sid == "s11":
        steps = ["下载安装包并解压", "chrome://extensions 打开开发者模式", "加载已解压的扩展程序", "刷新 X，上岗"]
        s = "".join(f'<div style="margin:12px 0"><span class="b mono" style="display:inline-block;width:60px">{i}</span>{esc(t)}</div>' for i, t in enumerate(steps, 1))
        gh = f"""<div class="card" style="width:1000px;padding:44px 56px"><div class="row" style="gap:22px;font-size:34px;color:{MUTED}"><span style="font-size:56px">🐙</span>GitHub · 开源 · 免费</div>
            <div class="mono" style="font-size:48px;font-weight:700;margin:18px 0 26px">ChenYilei2016/<span class="b">x-reply-context</span></div>
            <div class="row" style="gap:20px"><span class="btn" style="background:{YELLOW};border-color:{YELLOW};font-size:40px">⭐ Star</span>
            <span class="btn" style="background:#16181c;color:{FG};border-color:#2f3336;font-size:34px">下载 0.17.1 安装包</span></div></div>"""
        return [
            page(f"""<div class="stage"><div class="row" style="gap:70px;align-items:center">{gh}
                <div style="font-size:40px;line-height:1.5;font-weight:600">{s}</div></div>
                <div class="mono small" style="font-size:40px;color:{FG}">{REPO_URL}</div></div>""", tag="结业", note="链接在简介"),
            page(f"""<div class="stage"><div class="row" style="gap:80px">{logo(170)}<div>
                <div style="font-size:96px;font-weight:900;line-height:1.2">回过谁，<span class="b">它记得</span><br>点没点 Star，<span class="y">靠你</span> ⭐</div></div></div>
                <div class="mono" style="font-size:46px;margin-top:70px">{REPO_URL}</div>
                <div class="small">每条由你确认发送 · 记录存在本机 · 与 X 官方无关联</div></div>""", tag="结业"),
        ]
    raise ValueError(sid)

def cover_html():
    return page(f"""<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:150px">
      <div style="position:relative"><div style="font-size:330px;line-height:1">🔔</div>
        <div style="position:absolute;right:-60px;top:-40px;background:{RED};color:#fff;font-size:100px;font-weight:900;border-radius:999px;padding:4px 36px">99+</div></div>
      <div><div style="font-size:132px;font-weight:900;line-height:1.12">这个人<br>我<span class="b">回过</span>吗？</div>
      <div style="font-size:54px;color:{MUTED};margin-top:30px">X 社交打工人 · 上岗培训</div></div></div>""")

# ---------- 工具 ----------
def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write(" ".join(map(str, cmd)) + "\n" + r.stderr[-3000:])
        raise SystemExit(r.returncode)
    return r.stdout

def duration(p):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)]).strip())

def shoot(html_text, png, w=W, h=H):
    src = png.with_suffix(".html")
    src.write_text(html_text, encoding="utf-8")
    if png.exists():
        png.unlink()
    # 本机 Chrome 截图写完后进程不退出：等 PNG 写稳后主动结束
    p = subprocess.Popen([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                          f"--user-data-dir={BUILD / 'chrome-profile'}", "--allow-file-access-from-files", "--no-first-run",
                          "--virtual-time-budget=1500", f"--window-size={w},{h}", f"--screenshot={png}", src.as_uri()],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    last, stable = -1, 0
    for _ in range(300):
        if p.poll() is not None and png.exists():
            break
        size = png.stat().st_size if png.exists() else -1
        stable = stable + 1 if size > 0 and size == last else 0
        last = size
        if stable >= 3:
            break
        time.sleep(0.1)
    p.kill(); p.wait()
    subprocess.run(["pkill", "-f", str(BUILD / "chrome-profile")], capture_output=True)
    if not png.exists() or png.stat().st_size == 0:
        raise SystemExit(f"screenshot failed: {png}")

def ass_time(t):
    cs = int(round(t * 100)); h, cs = divmod(cs, 360000); m, cs = divmod(cs, 6000); s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"

def srt_time(t):
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def render_frames():
    pngs = {}
    for seg in SEGMENTS:
        for i, h in enumerate(frames(seg["id"])):
            png = BUILD / "frames" / f"{seg['id']}_{i}.png"
            png.parent.mkdir(parents=True, exist_ok=True)
            shoot(h, png)
            pngs[(seg["id"], i)] = png
    # contact sheet：所有分镜一张图，便于快速检查
    lst = list(pngs.values())
    cols = 4; rows = (len(lst) + cols - 1) // cols
    ins = sum((["-i", str(p)] for p in lst), [])
    fc = "".join(f"[{i}:v]scale=480:270[t{i}];" for i in range(len(lst)))
    pad = rows * cols - len(lst)
    fc += "".join(f"color=c=black:s=480x270:d=1[e{i}];" for i in range(pad))
    tiles = [f"[t{i}]" for i in range(len(lst))] + [f"[e{i}]" for i in range(pad)]
    layout = "|".join(f"{(k % cols) * 480}_{(k // cols) * 270}" for k in range(rows * cols))
    fc += "".join(tiles) + f"xstack=inputs={rows*cols}:layout={layout}[o]"
    run(["ffmpeg", "-y", "-v", "error", *ins, "-filter_complex", fc, "-map", "[o]", "-frames:v", "1", str(BUILD / "contact-sheet.jpg")])
    return pngs

# ---------- 主流程 ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default=VOICE)
    ap.add_argument("--rate", type=int)
    ap.add_argument("--cut", choices=sorted(CUTS), help="剪辑版本，如 x（X 短版）")
    ap.add_argument("--frames-only", action="store_true")
    a = ap.parse_args()
    a.rate = a.rate or (CUTS[a.cut]["rate"] if a.cut else RATE)
    name = f"ep02-{a.cut}" if a.cut else "ep02"
    tmp = BUILD / (a.cut or "full")
    BUILD.mkdir(exist_ok=True); OUT.mkdir(exist_ok=True)
    pngs = render_frames()
    if a.frames_only:
        shoot(cover_html(), OUT / "cover.png")
        print("frames ->", BUILD / "contact-sheet.jpg")
        return

    (tmp / "clips").mkdir(parents=True, exist_ok=True); (tmp / "voice").mkdir(exist_ok=True)
    clips, cues, t0 = [], [], 0.0
    for bid, sid, beat in cut_beats(a.cut):
        wav = tmp / "voice" / f"{bid}.aiff"
        run(["say", "-v", beat.get("voice", a.voice), "-r", str(a.rate), "-o", str(wav), beat["vo"]])
        vo = duration(wav)
        d = round(vo + beat.get("gap", GAP), 3)
        n = int(round(d * FPS))
        png = pngs[(sid, beat["f"])]
        mp4 = tmp / "clips" / f"{bid}.mp4"
        # 缓慢推近：先放大到 2 倍再缩回，减少 zoompan 抖动
        vf = (f"[0:v]scale={W*2}:{H*2},zoompan=z='1+0.035*on/{n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
              f":d={n}:s={W}x{H}:fps={FPS},format=yuv420p[v]")
        run(["ffmpeg", "-y", "-v", "error", "-i", str(png), "-i", str(wav),
             "-filter_complex", vf + f";[1:a]aresample=48000,apad=whole_dur={d}[a]",
             "-map", "[v]", "-map", "[a]", "-t", str(d), "-r", str(FPS),
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-ac", "2", str(mp4)])
        real = duration(mp4)
        # 字幕：按字数在本拍旁白时长内分配
        parts = [p for p in beat["sub"].split("|") if p]
        weights = [max(len(re.sub(r"\s", "", p)), 2) for p in parts]
        tot, acc = sum(weights), 0.0
        for p, w in zip(parts, weights):
            s = t0 + vo * acc / tot; acc += w; e = t0 + vo * acc / tot
            cues.append((s, min(e + (0.25 if p == parts[-1] else 0), t0 + real), p))
        clips.append(mp4); t0 += real
        print(f"{bid} f{beat['f']} {real:6.2f}s", flush=True)

    concat = tmp / "concat.txt"
    concat.write_text("".join(f"file '{c}'\n" for c in clips))
    raw = tmp / "raw.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(raw)])

    ass = tmp / "subs.ass"
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Hiragino Sans GB,60,&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,1,0,0,0,100,100,1,0,1,4,1,2,80,80,64,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ass.write_text(head + "".join(f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Default,,0,0,0,,{t}\n" for s, e, t in cues), encoding="utf-8")
    (OUT / f"{name}.srt").write_text("".join(f"{i}\n{srt_time(s)} --> {srt_time(e)}\n{t}\n\n" for i, (s, e, t) in enumerate(cues, 1)), encoding="utf-8")

    final = OUT / f"{name}.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-i", str(raw), "-vf", f"ass={ass}",
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:v", "libx264", "-preset", "slow", "-crf", "19",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final)])
    shoot(cover_html(), OUT / "cover.png")
    shutil.rmtree(BUILD / "chrome-profile", ignore_errors=True)
    commit = run(["git", "-C", str(REPO), "rev-parse", "HEAD"]).strip()
    (OUT / ("build_info.json" if not a.cut else f"build_info-{a.cut}.json")).write_text(json.dumps({
        "episode": name, "title": "X 社交打工人 · 上岗培训", "duration_s": round(duration(final), 2),
        "voice": a.voice, "rate": a.rate, "resolution": f"{W}x{H}@{FPS}",
        "segments": len(SEGMENTS), "beats": len(clips), "subtitle_cues": len(cues),
        "product_version": "0.17.1", "product_commit": commit,
        "real_screenshots": ["assets/readme/notifications.jpg（本地演示，虚构账号）", "assets/readme/notification-settings-0.15.3.png（扩展弹窗）"],
        "synthetic": ["HTML 分镜与功能示意（虚构账号与内容）", "macOS TTS 旁白（AI 配音）"],
        "music": "None", "publication": "Local deliverable only; not uploaded",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print("done", final, f"{duration(final):.1f}s")

if __name__ == "__main__":
    main()
