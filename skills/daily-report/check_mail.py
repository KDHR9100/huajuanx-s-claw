#!/usr/bin/env python3
"""daily-report 收信脚本（只读）。

登录 Rana 的 QQ 邮箱 IMAP，把匹配的邮件整理成纯文字输出。
- 账号密码复用 state 目录下已有的 secrets/smtp.json（SMTP 域名自动换成 IMAP）
- 全程 readonly 模式：不删信、不标已读、不发信、不改任何状态
- 默认只显示未读；--since N 看最近 N 天（含已读）；--check 只测连通性
"""
import argparse
import datetime
import html
import imaplib
import json
import re
import sys
from email import policy
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
STATE_DIR = SCRIPT_DIR.parents[1]  # .../.openclaw/.openclaw
SECRET = STATE_DIR / "secrets" / "smtp.json"
BODY_LIMIT = 2000  # 每封正文最多显示多少字


def log(msg):
    print(msg, flush=True)


def load_account():
    if not SECRET.exists():
        raise SystemExit(f"找不到配置文件：{SECRET}")
    cfg = json.loads(SECRET.read_text(encoding="utf-8"))
    user, pwd = cfg.get("user"), cfg.get("pass")
    if not user or not pwd:
        raise SystemExit("配置里缺少 user 或 pass 字段")
    smtp_host = cfg.get("host", "smtp.qq.com")
    imap_host = re.sub(r"^[^.]+", "imap", smtp_host, count=1)
    return imap_host, user, pwd


def decode_mime(value):
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def decode_payload(payload, charset):
    for enc in (charset, "utf-8", "gb18030"):
        if not enc:
            continue
        try:
            return payload.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return payload.decode("utf-8", errors="replace")


def body_text(msg):
    """优先取 text/plain，其次 text/html 去标签，附件不算正文。"""
    plain, rich = None, None
    parts = msg.walk() if msg.is_multipart() else [msg]
    for part in parts:
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html") or part.get_filename():
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            continue
        text = decode_payload(payload, part.get_content_charset())
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
        if ctype == "text/html":
            text = html.unescape(re.sub(r"<[^>]+>", " ", text))
        text = re.sub(r"[ \t\r]+", " ", text)
        text = re.sub(r"\n\s*\n+", "\n", text).strip()
        if ctype == "text/plain" and plain is None:
            plain = text
        elif ctype == "text/html" and rich is None:
            rich = text
    return plain or rich or "（没有可显示的正文）"


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="只读方式查收日报邮件")
    ap.add_argument("--check", action="store_true", help="只登录数未读，不显示内容")
    ap.add_argument("--since", type=int, default=None, help="改看最近N天的信（含已读）")
    ap.add_argument("--limit", type=int, default=10, help="最多显示几封")
    args = ap.parse_args()

    host, user, pwd = load_account()
    try:
        mail = imaplib.IMAP4_SSL(host, 993)
    except OSError as e:
        raise SystemExit(f"连不上 {host}：{e}")
    try:
        mail.login(user, pwd)
    except imaplib.IMAP4.error:
        raise SystemExit("登录被拒：授权码不对，或邮箱没开 IMAP 服务")
    try:  # 国内邮箱常要求客户端先报身份
        mail.xatom('ID', '("name" "daily-report" "version" "1.0.0")')
    except Exception:
        pass

    mail.select("INBOX", readonly=True)  # 只读打开：任何情况下都不会改动邮箱

    if args.since:
        since = (datetime.date.today() - datetime.timedelta(days=args.since)).strftime("%d-%b-%Y")
        typ, data = mail.search(None, f'(SINCE "{since}")')
    else:
        typ, data = mail.search(None, "UNSEEN")
    all_ids = data[0].split() if typ == "OK" else []
    ids = all_ids[-args.limit:]  # 取最新的几封，从旧到新

    if args.check:
        log(f"IMAP登录成功：{host} / {user}")
        log(f"匹配邮件：{len(all_ids)} 封（--check 模式不显示内容）")
        mail.logout()
        return

    if not ids:
        log("收件箱没有未读邮件。（想翻最近几天的旧信可加 --since 7）")
        mail.logout()
        return

    parser = BytesParser(policy=policy.default)
    log(f"共 {len(ids)} 封，从旧到新：")
    for i, num in enumerate(ids, 1):
        typ, got = mail.fetch(num, "(RFC822)")
        raw = got[0][1] if typ == "OK" and got and isinstance(got[0], tuple) else None
        if raw is None:
            log(f"\n=== 第{i}封：拉取失败 ===")
            continue
        msg = parser.parsebytes(raw)
        subj = decode_mime(msg.get("Subject"))
        frm = decode_mime(msg.get("From"))
        date = msg.get("Date", "")
        try:
            date = parsedate_to_datetime(date).strftime("%Y-%m-%d %H:%M")
        except Exception:
            pass
        body = body_text(msg)
        if len(body) > BODY_LIMIT:
            body = body[:BODY_LIMIT] + f"\n…（正文过长已截断，原信约{len(body)}字）"
        log(f"\n=== 第{i}封 / 主题：{subj}")
        log(f"发件人：{frm}    时间：{date}")
        log("-" * 40)
        log(body)
    log("\n（完毕。全程只读，邮箱里什么都没动）")
    mail.logout()


if __name__ == "__main__":
    main()
