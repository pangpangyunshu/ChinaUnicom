# ChinaUnicom V4 for Surge + BoxJs

这是给你自己 GitHub 仓库用的一套文件：

- `10010.js`：联通余量 V4 主脚本，用于定时、Panel、BoxJs 请求桥。
- `10010_capture.js`：联通 App 登录抓包脚本，只用于 `http-response`。
- `10010.sgmodule`：已经改成自有 GitHub Raw 地址的 Surge 模块模板。

## 使用方式

1. 在 GitHub 建一个公开仓库，例如 `ChinaUnicom`。
2. 上传这 3 个文件到仓库根目录。
3. Surge 里导入模块地址：

```text
https://raw.githubusercontent.com/pangpangyunshu/ChinaUnicom/main/10010.sgmodule
```

## 关键检查点

- `10010v4-panel` 必须指向 `10010.js`，不能指向 `10010_capture.js`。
- `10010v4-cron` 必须指向 `10010.js`。
- `10010v4-capture` 必须指向 `10010_capture.js`。
- BoxJs 的 Surge API 地址仍然填写 `密码@127.0.0.1:6171`。
- 不要把手机号、服务密码、cookie、token 写进这个仓库。

## 私有仓库说明

Surge 在 iOS 上拉取 `raw.githubusercontent.com` 文件时，公开仓库最稳定。私有仓库通常需要额外认证，Raw 链接也可能带临时签名，不适合作为 Surge 模块长期订阅地址。
