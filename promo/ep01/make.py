#!/usr/bin/env python3
"""Render a local, narrated promo. No browser control, uploads or repository writes outside ep01."""
import argparse
import hashlib
import json
import math
import subprocess
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
BUILD, OUT, ASSETS = HERE / "build", HERE / "out", HERE / "assets"
W, H, FPS = 1920, 1080, 30
BG, CARD, LINE = "#111820", "#1c2733", "#344353"
FG, MUTED = "#f0f4f8", "#9eafbf"
ORANGE, BLUE, PURPLE = "#ffad5a", "#39a9f5", "#b198f1"
PINK, GREEN, YELLOW = "#f383a7", "#70d8b2", "#ffdc73"


def run(args):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result.stdout


def duration(path):
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                      "-of", "csv=p=0", path]).strip())


@lru_cache(maxsize=64)
def font(size, bold=False, mono=False):
    name = "Menlo.ttc" if mono else "Hiragino Sans GB.ttc"
    return ImageFont.truetype(f"/System/Library/Fonts/{name}", size, index=2 if bold and not mono else 0)


def width(text, size, bold=False, mono=False):
    return font(size, bold, mono).getlength(text)


def text(draw, xy, value, size=48, color=FG, bold=False, mono=False):
    draw.text(xy, value, fill=color, font=font(size, bold, mono), anchor="lt")


def center(draw, y, value, size=72, color=FG, bold=True, cx=W / 2):
    text(draw, (cx - width(value, size, bold) / 2, y), value, size, color, bold)


def lines(value, max_width, size, bold=False):
    result, current = [], ""
    for character in value:
        if character == "\n":
            result.append(current)
            current = ""
        elif current and width(current + character, size, bold) > max_width:
            result.append(current)
            current = character
        else:
            current += character
    if current:
        result.append(current)
    return result


def block(draw, xy, value, size=64, color=FG, bold=True, max_width=1600, gap=20):
    for index, line in enumerate(lines(value, max_width, size, bold)):
        text(draw, (xy[0], xy[1] + index * (size + gap)), line, size, color, bold)


def panel(draw, box, fill=CARD, outline=LINE, radius=24, stroke=2):
    draw.rounded_rectangle(box, radius, fill=fill, outline=outline, width=stroke)


def pill(draw, xy, label, fill=BLUE, color=BG, size=38, padding=22):
    length = int(width(label, size, True)) + padding * 2
    panel(draw, (xy[0], xy[1], xy[0]+length, xy[1]+size+padding), fill, fill, 12)
    text(draw, (xy[0]+padding, xy[1]+padding/2), label, size, color, True)
    return length


def arrow(draw, start, end, color=BLUE, stroke=6):
    draw.line([start, end], fill=color, width=stroke)
    angle = math.atan2(end[1]-start[1], end[0]-start[0])
    tip = [(end[0], end[1])]
    for delta in [-0.5, 0.5]:
        tip.append((end[0]-24*math.cos(angle+delta), end[1]-24*math.sin(angle+delta)))
    draw.polygon(tip, fill=color)


def check(draw, x, y, color=GREEN, scale=1):
    draw.line([(x, y+22*scale), (x+22*scale, y+44*scale), (x+62*scale, y)],
              fill=color, width=max(3, int(8*scale)))


def heart(draw, cx, cy, scale=4, color=PINK):
    points = []
    for index in range(120):
        t = index * 2*math.pi/120
        points.append((cx+scale*16*math.sin(t)**3,
                       cy-scale*(13*math.cos(t)-5*math.cos(2*t)-2*math.cos(3*t)-math.cos(4*t))))
    draw.polygon(points, fill=color)


@lru_cache(maxsize=4)
def shot(name):
    return Image.open(ASSETS / name).convert("RGB")


def screenshot(canvas, name, box, crop=None):
    source = shot(name)
    if crop:
        source = source.crop(crop)
    fitted = ImageOps.contain(source, (box[2]-box[0], box[3]-box[1]), Image.Resampling.LANCZOS)
    x, y = box[0]+(box[2]-box[0]-fitted.width)//2, box[1]+(box[3]-box[1]-fitted.height)//2
    canvas.paste(fitted, (x, y))
    ImageDraw.Draw(canvas).rounded_rectangle((x-2, y-2, x+fitted.width+2, y+fitted.height+2),
                                             8, outline=LINE, width=3)


def base(scene, progress):
    canvas = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(canvas)
    text(draw, (72, 47), scene["chapter"], 34, ORANGE, True)
    note = scene["note"]
    text(draw, (W-72-width(note, 26), 52), note, 26, MUTED)
    draw.line([(72, 108), (W-72, 108)], fill=LINE, width=2)
    draw.line([(72, 1040), (W-72, 1040)], fill=LINE, width=3)
    draw.line([(72, 1040), (72+(W-144)*progress, 1040)], fill=ORANGE, width=4)
    return canvas, draw


def render(scene, beat, progress):
    canvas, d = base(scene, progress)
    visual = scene["visual"]
    if visual == "memory":
        block(d, (110, 180), "发现一个\n性能瓶颈", 108, max_width=740, gap=28)
        text(d, (118, 510), "回消息之前，先查一下自己", 40, MUTED)
        panel(d, (990, 185, 1790, 720))
        for index, label in enumerate(["网络", "浏览器", "我的记忆"]):
            y = 250 + index*145
            text(d, (1040, y), label, 56, bold=True)
            if index < 2:
                check(d, 1660, y+4)
            elif beat >= 2:
                text(d, (1570, y-12), "404", 102, ORANGE, True, True)
            else:
                text(d, (1650, y), "?", 72, MUTED, True)
        if beat >= 2:
            center(d, 790, "问题不大，主要是我。", 64, ORANGE)
    elif visual == "loop":
        entries = [(200, 170, "他", "谢谢支持。", BLUE),
                   (700, 360, "我", "谢谢你的支持。", ORANGE),
                   (200, 550, "他", "也谢谢你的支持。", BLUE)]
        for index, (x, y, author, message, color) in enumerate(entries):
            if index == 2 and beat == 0:
                continue
            pill(d, (x, y), author, color, size=38)
            panel(d, (x+130, y-2, x+1100, y+132))
            text(d, (x+170, y+35), message, 66, bold=True)
        if beat >= 2:
            center(d, 778, "两个人，聊出一台永动机。", 74, ORANGE)
            arrow(d, (150, 670), (150, 240), PURPLE)
    elif visual == "reveal":
        panel(d, (150, 265, 480, 595), fill="#153042", outline=BLUE, stroke=4)
        check(d, 215, 370, BLUE, 2.7)
        text(d, (585, 260), "回过了", 158, FG, True)
        text(d, (598, 472), "X 通知助手", 66, BLUE, True)
        if beat >= 1:
            pill(d, (596, 610), "给记性，外接一个硬盘。", ORANGE, size=49)
        text(d, (154, 790), "Chrome 扩展  /  当前版本 0.4.1", 32, MUTED)
    elif visual == "origin":
        for x, label, color, root in [(140, "我原帖", "#0969da", "我发的原帖"),
                                      (1010, "别人原帖", "#7540b5", "别人发的原帖")]:
            panel(d, (x, 170, x+760, 695))
            pill(d, (x+60, 214), label, color, FG, 60)
            text(d, (x+65, 350), root, 52, bold=True)
            if beat >= 1:
                for y, t in [(470, "一层回复"), (570, "再套一层回复")]:
                    arrow(d, (x+90, y-40), (x+90, y), color)
                    text(d, (x+145, y-15), t, 43, MUTED)
        if beat >= 2:
            center(d, 770, "社交可以套娃，原帖不能认错。", 62, ORANGE)
    elif visual == "status":
        screenshot(canvas, "notifications.jpg", (130, 175, 1790, 660), (106, 366, 725, 551))
        if beat >= 1:
            pill(d, (430, 705), "文字-已回", "#183d35", GREEN, 50)
            text(d, (955, 710), "≠", 78, FG, True)
            pill(d, (1110, 705), "红心-已点", "#3a2638", PINK, 50)
        else:
            center(d, 740, "同一原帖 · 同一个人 · 两项独立", 56, BLUE)
    elif visual == "count":
        pill(d, (185, 185), "我评他  2", BLUE, BG, 72)
        pill(d, (1090, 185), "他评我  1", PURPLE, BG, 72)
        center(d, 340, "单位：评论过几篇对方的原帖", 58, MUTED, False)
        if beat >= 1:
            for index in range(3):
                panel(d, (220+index*270, 490, 450+index*270, 650))
                center(d, 531, "夸夸", 54, BLUE, cx=335+index*270)
            text(d, (1050, 505), "=", 106, MUTED, True)
            text(d, (1240, 465), "1", 184, ORANGE, True)
            text(d, (1390, 550), "篇原帖", 66, FG, True)
        if beat >= 2:
            center(d, 775, "夸得多，不加学分。", 62, ORANGE)
    elif visual == "new":
        panel(d, (150, 165, 1770, 540))
        d.ellipse((210, 235, 380, 405), fill="#253f52")
        text(d, (257, 270), "C", 90, BLUE, True)
        text(d, (435, 220), "Carol", 60, FG, True)
        text(d, (435, 310), "第一次评论我的原帖", 64, bold=True)
        text(d, (435, 418), "我评他 = 0", 50, MUTED)
        if beat >= 1:
            pill(d, (1340, 280), "NEW", YELLOW, BG, 78)
        if beat >= 2:
            center(d, 668, "头像看着眼熟？", 84, ORANGE)
            center(d, 780, "别急着认亲，先看记录。", 58, MUTED, False)
    elif visual == "next":
        screenshot(canvas, "continuous-reply.jpg", (630, 170, 1810, 850), (340, 108, 940, 484))
        block(d, (110, 220), "回完一条\n接着下一条", 77, max_width=490, gap=22)
        pill(d, (115, 498), "跳过", CARD, FG, 48)
        if beat >= 1:
            block(d, (115, 620), "当前页已加载\n同帖同人已回的略过", 39, BLUE, max_width=475, gap=18)
        if beat >= 2:
            pill(d, (114, 790), "每条由你确认", ORANGE, BG, 36)
    elif visual == "bug":
        center(d, 170, "两边都有证据，只有我很困惑。", 67, FG)
        for x, title, number, color in [(150, "后台记账", "1", GREEN), (1040, "页面显示", "0", ORANGE)]:
            panel(d, (x, 300, x+730, 720))
            center(d, 352, title, 56, MUTED, cx=x+365)
            center(d, 445, number if beat >= 1 else "?", 180, color, cx=x+365)
            if beat >= 2:
                center(d, 650, "我加了。" if x == 150 else "我不说。", 42, color, cx=x+365)
        if beat >= 3:
            center(d, 785, "那倒是让我看见啊。", 70, ORANGE)
    elif visual == "privacy":
        if beat == 0:
            pill(d, (615, 175), "0.4.1：显示滞后已修复", GREEN, BG, 40)
        panel(d, (310, 320, 1610, 670))
        center(d, 355, "待确认", 128, FG)
        center(d, 515, "≠ 从来没回复过", 85, ORANGE)
        center(d, 740, "本机记录  /  随浏览积累  /  有据可查", 44, MUTED, False)
        if beat >= 2:
            center(d, 820, "这里是记事本，不是判官。", 52, BLUE)
    elif visual == "outro":
        center(d, 170, "回过了", 150, FG)
        center(d, 370, "该回的回，该停的停。", 82, ORANGE)
        panel(d, (200, 550, 1720, 730), fill="#183046", outline=BLUE, stroke=3)
        center(d, 578, "项目链接见简介", 49, BLUE)
        text(d, (W/2-width("github.com/ChenYilei2016/x-reply-context", 36, mono=True)/2, 660),
             "github.com/ChenYilei2016/x-reply-context", 36, FG, mono=True)
        center(d, 805, "让「谢谢」，停在该停的地方。" if beat >= 3 else "Chrome 安装后，刷新 X 通知页", 50, MUTED, False)
    else:
        raise ValueError(visual)
    return canvas


def cover():
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    text(d, (120, 95), "程序员的小工具 / X 通知助手", 42, BLUE, True)
    text(d, (110, 250), "回个消息", 164, FG, True)
    text(d, (110, 460), "回成了死循环", 150, ORANGE, True)
    for x, y, label, color in [(1260, 260, "谢谢", BLUE), (1430, 480, "谢谢", PURPLE), (1200, 690, "谢谢", BLUE)]:
        pill(d, (x, y), label, CARD, color, 70, 35)
    arrow(d, (1580, 375), (1620, 460), ORANGE, 8)
    arrow(d, (1520, 625), (1430, 700), ORANGE, 8)
    arrow(d, (1160, 720), (1200, 350), ORANGE, 8)
    pill(d, (120, 785), "于是，我做了个插件：回过了", GREEN, BG, 54, 28)
    text(d, (123, 930), "分清原帖  ·  记住互动  ·  连续回复", 40, MUTED)
    return canvas


def ass_time(value):
    centiseconds = round(value*100)
    hours, centiseconds = divmod(centiseconds, 360000)
    minutes, centiseconds = divmod(centiseconds, 6000)
    seconds, centiseconds = divmod(centiseconds, 100)
    return f"{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}"


def srt_time(value):
    milliseconds = round(value*1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def prepare(story):
    for directory in [BUILD/"voice", BUILD/"frames", BUILD/"clips", OUT]:
        directory.mkdir(parents=True, exist_ok=True)
    timeline, offset = [], 0.0
    total_cues = sum(len(scene["cues"]) for scene in story["scenes"])
    for scene in story["scenes"]:
        scene_start, scene_entries = offset, []
        for beat, cue in enumerate(scene["cues"]):
            name = f"{scene['id']}-{beat+1:02}"
            spoken = cue.get("voice", cue["text"])
            voice_key = hashlib.sha256(f"{story['voice']}|{story['rate']}|{spoken}".encode()).hexdigest()[:12]
            voice = BUILD/"voice"/f"{name}-{voice_key}.aiff"
            if not voice.exists():
                script = voice.with_suffix(".txt")
                script.write_text(spoken, encoding="utf-8")
                run(["say", "-v", story["voice"], "-r", story["rate"], "-f", script, "-o", voice])
            seconds = duration(voice)
            frames = math.ceil((seconds+cue.get("pause", 0.16))*FPS)
            length = frames/FPS
            frame = BUILD/"frames"/f"{name}.png"
            render(scene, beat, (len(timeline)+1)/total_cues).save(frame)
            entry = dict(name=name, scene=scene["id"], beat=beat, text=cue["text"], start=offset,
                         speech=seconds, length=length, frames=frames, voice=str(voice), frame=str(frame),
                         scene_offset=offset-scene_start)
            scene_entries.append(entry)
            timeline.append(entry)
            offset += length
        for entry in scene_entries:
            entry["scene_length"] = offset-scene_start
        print(f"prepared {scene['id']}: {offset-scene_start:.2f}s", flush=True)
    cover().save(OUT/"cover.png")
    sheet = Image.new("RGB", (1920, math.ceil(len(story["scenes"])/3)*360), BG)
    for index, scene in enumerate(story["scenes"]):
        entry = [item for item in timeline if item["scene"] == scene["id"]][-1]
        picture = Image.open(entry["frame"]).convert("RGB")
        d = ImageDraw.Draw(picture)
        subtitle = lines(entry["text"], 1700, 56, True)
        for line_index, line in enumerate(subtitle):
            center(d, 925-(len(subtitle)-1-line_index)*65, line, 56, FG)
        sheet.paste(picture.resize((640, 360), Image.Resampling.LANCZOS), ((index%3)*640, (index//3)*360))
    sheet.save(BUILD/"contact-sheet.jpg", quality=91)
    (BUILD/"timeline.json").write_text(json.dumps(timeline, ensure_ascii=False, indent=2), encoding="utf-8")
    return timeline


def encode(timeline):
    clips, actual_start, subtitles = [], 0.0, []
    for index, item in enumerate(timeline):
        clip = BUILD/"clips"/f"{item['name']}.mp4"
        zoom = f"1+0.015*(on/{FPS}+{item['scene_offset']})/{item['scene_length']}"
        filters = (f"[0:v]scale=2560:1440,zoompan=z='{zoom}':x='iw/2-iw/zoom/2':"
                   f"y='ih/2-ih/zoom/2':d={item['frames']}:s={W}x{H}:fps={FPS},format=yuv420p[v];"
                   f"[1:a]aresample=48000,apad=whole_dur={item['length']}[a]")
        run(["ffmpeg", "-y", "-v", "error", "-filter_complex_threads", "2", "-i", item["frame"],
             "-i", item["voice"], "-filter_complex", filters, "-map", "[v]", "-map", "[a]",
             "-t", f"{item['length']:.6f}", "-c:v", "libx264", "-threads", "2", "-preset", "fast",
             "-crf", "19", "-c:a", "aac", "-b:a", "192k", "-ac", "2", clip])
        actual_length = duration(clip)
        subtitles.append((actual_start, actual_start+min(item["speech"]+0.12, actual_length), item["text"]))
        actual_start += actual_length
        clips.append(clip)
        print(f"rendered {index+1:02}/{len(timeline)} {item['name']}", flush=True)
    concat = BUILD/"concat.txt"
    concat.write_text("".join(f"file '{clip}'\n" for clip in clips), encoding="utf-8")
    raw = BUILD/"raw.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", concat, "-c", "copy", raw])
    ass = BUILD/"subtitles.ass"
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Hiragino Sans GB,58,&H00F8F4F0,&H00FFFFFF,&H00201811,&H00000000,1,0,0,0,100,100,1,0,1,3,0,2,90,90,74,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for start, end, value in subtitles:
        wrapped = "\\N".join(lines(value, 1700, 58, True))
        events.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{wrapped}\n")
    ass.write_text(header+"".join(events), encoding="utf-8")
    (OUT/"promo.srt").write_text("".join(f"{i}\n{srt_time(start)} --> {srt_time(end)}\n{value}\n\n"
                                         for i, (start, end, value) in enumerate(subtitles, 1)), encoding="utf-8")
    final = OUT/"x-reply-context-promo-v01.mp4"
    print("finishing: subtitles and audio normalization", flush=True)
    run(["ffmpeg", "-y", "-v", "error", "-filter_threads", "2", "-i", raw, "-vf", f"ass='{ass}'",
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:v", "libx264", "-threads", "2", "-preset", "fast",
         "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
         "-ac", "2", "-movflags", "+faststart", final])
    return final


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true", help="Generate voices, artwork and timing for inspection")
    args = parser.parse_args()
    story = json.loads((HERE/"storyboard.json").read_text(encoding="utf-8"))
    timeline = prepare(story)
    print(f"planned runtime: {sum(item['length'] for item in timeline):.2f}s", flush=True)
    if args.prepare:
        return
    final = encode(timeline)
    info = dict(title=story["title"], duration_s=round(duration(final), 3), resolution=f"{W}x{H}", fps=FPS,
                voice=story["voice"], rate=story["rate"], scenes=len(story["scenes"]), cues=len(timeline),
                product_version="0.4.1", product_commit="29cdfbdd2a5687403a9cebaeef14f85a231f7fc6",
                material="Original scripted cards and local demo screenshots with fictional accounts",
                narration="Synthetic macOS speech; subtitles burned into video", music="None",
                publication="Local deliverable only; not uploaded or submitted")
    (OUT/"build_info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print("DONE", final, info["duration_s"], flush=True)


if __name__ == "__main__":
    main()
