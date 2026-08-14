# 联通余量 V4（Surge 重构版）

这是面向 Surge + BoxJs 的清晰重构版本。它兼容原来的
@ChinaUnicom.10010v4.\* 存储键，因此更新模块后通常不需要重新填写已有配置。

## 安装

在 Surge 中安装以下模块：

```text
https://raw.githubusercontent.com/pangpangyunshu/ChinaUnicom/main/10010.sgmodule
```

更新已有模块时，建议先在模块页面执行“更新”，再确认脚本详情中的第一行是
"use strict";。如果仍显示旧的 // cron ...，说明 Surge 还在使用缓存脚本。

## 文件

- 10010.js：定时查询、Surge Panel 和 BoxJs 数据接口。
- 10010_capture.js：登录响应抓取，只在联通 App 登录/在线刷新时保存登录信息。
- 10010.sgmodule：Surge 模块配置。
- tests/run-tests.js：不连接联通接口的本地模拟测试。

## 登录恢复顺序

主脚本按以下顺序工作：

1. 使用现有 Cookie 查询。
2. Cookie 失效时，使用 token_online 刷新登录。
3. Token 也不可用时，使用手机号和服务密码登录。
4. 仍无法登录时，提示打开中国联通 App 重新触发抓包。

抓包脚本被手动测试时没有 $request/$response，现在会安全跳过，不会再出现
Object.entries requires that input parameter not be null or undefined。

## BoxJs 与 Surge HTTP API

BoxJs 中的 Surge API 地址仍使用：

```text
密码@127.0.0.1:6171
```

不要填写 http://，也不要混用远程控制器端口。若日志出现 invalid key，
这是 BoxJs 调用 Surge HTTP API 时的认证错误，应核对 BoxJs 中保存的密码。
重构后的联通脚本本身不再读取或拼接 X-Key。

## 主要改进

- 删除混淆代码和无关的 Node、Loon、Quantumult X 兼容层。
- 不再全局改写 Object.entries、Object.keys 或 Object.fromEntries。
- Panel、定时任务、抓包脚本和 /data 接口有明确独立的运行分支。
- Panel 与 BoxJs 数据查询不会覆盖定时任务的流量差值基线。
- Cookie、Token、手机号和服务密码不会写入普通日志。
- Cron 输出会返回成功摘要；失败时返回错误类型、状态码和非敏感的配置读取诊断，不再用空对象掩盖原因。
- Cookie 合并兼容大小写 Header、数组形式的 Set-Cookie 和空 Header。
- Cookie 失效码判断、HTTP 状态、超时和非 JSON 响应均有明确错误信息。
- 服务密码登录只保留所需的 RSA 实现，大幅缩小脚本体积。
- 保留原有套餐分组、自定义通知模板、通知阈值和 Bark 模板配置。

## 本地测试

使用 Node.js 运行：

```powershell
node .\tests\run-tests.js
```

测试覆盖抓包手动执行、真实抓包、Panel、BoxJs /data、Token 续登、
服务密码登录和缺少登录信息等场景，不会访问真实联通接口。

## 隐私

不要把手机号、服务密码、验证码、Cookie、token_online 或 Surge API 密码
提交到 GitHub。仓库内脚本只包含公开接口地址和联通客户端使用的公钥。

本项目根据
[ChinaTelecomOperators/ChinaUnicom](https://github.com/ChinaTelecomOperators/ChinaUnicom)
的既有行为和存储格式进行兼容重构；使用前请阅读上游仓库的许可证与免责声明。
