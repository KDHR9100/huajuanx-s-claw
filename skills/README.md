# skills —— 可公开的技能母本

这个目录放 Rana 技能的**公开母本**：可以推 GitHub、可以在新机器上克隆安装。
运行中的技能住在 `<OpenClaw状态目录>/skills/`（那边是隐私区，被 .gitignore 挡住，不进仓库）。
两边关系：**这里改完 → 拷贝过去生效**。

## 安装 daily-report（收日报）

1. 把 `daily-report/` 整个文件夹拷到 `<OpenClaw状态目录>/skills/` 下
2. 在 `<OpenClaw状态目录>/secrets/` 下创建 `smtp.json`（参考 `daily-report/smtp.example.json`，
   填真实邮箱和授权码——授权码不是QQ密码，在QQ邮箱「设置 → 账号 → IMAP/SMTP服务」里生成）
3. 先测通不通：`python <技能目录>/check_mail.py --check`；然后开个新会话，喊"看日报"即可

> 状态目录在哪：家里本机是 `K:\OpenClaw\.openclaw\.openclaw\`；其他机器看各自的
> OPENCLAW_STATE_DIR / 安装布局。脚本按自己所在位置自动找配置，放对层级就能跑。

## 公司端（发日报的一侧）

初期零配置：下班在QQ邮箱网页版手动把日报发到 Rana 的信箱，**主题带「日报」二字**即可。
以后要在公司部署 Rana 本体时：克隆本仓库 → 按上面步骤装技能 → 配同一个 `smtp.json`
（她要能发信，发件人就是她自己）。

## 红线

- `secrets/`、`memory/`、`.openclaw/` 的任何内容不进仓库
- 授权码只存在运行机的 `secrets/smtp.json`，示例文件只留字段名和占位文字
