"use strict";

// ChinaUnicom V4 credential capture - Surge http-response script.

var APP = {
  namespace: "ChinaUnicom",
  name: "10010v4",
  title: "联通余量",
};

capture()
  .then(function () {
    done({});
  })
  .catch(function (error) {
    var message = publicError(error);
    log("抓取失败: " + message);
    localNotification(APP.title, "抓取失败", message);
    done({});
  });

async function capture() {
  if (
    typeof $request === "undefined" ||
    !$request ||
    typeof $response === "undefined" ||
    !$response
  ) {
    log("这是响应抓包脚本，手动测试时没有请求/响应数据，已安全跳过。");
    return;
  }

  var body = safeJson($response.body, null);
  if (!body || typeof body !== "object") {
    throw new Error("登录响应不是有效 JSON。");
  }

  var code = String(getPath(body, "code", ""));
  var appId =
    getPath(body, "appId", "") ||
    getPath(body, "data.appId", "") ||
    readValue("appId");
  var tokenOnline =
    getPath(body, "token_online", "") || getPath(body, "data.token_online", "");
  var requestCookie = getHeader($request.headers, "cookie");
  var responseCookie = getHeader($response.headers, "set-cookie");
  var cookie = mergeCookies(requestCookie, responseCookie);

  if (!tokenOnline || !cookie) {
    var reason =
      getPath(body, "dsc", "") ||
      getPath(body, "desc", "") ||
      getPath(body, "message", "");
    throw new Error(
      "响应中缺少 token_online 或 Cookie" +
        (code ? " (" + code + ")" : "") +
        (reason ? ": " + reason : ""),
    );
  }

  if (appId) writeValue("appId", appId);
  writeValue("token_online", tokenOnline);
  writeValue("cookie", cookie);

  log("登录信息已保存");
  localNotification(
    APP.title,
    "已保存",
    appId
      ? "appId、token_online 和 Cookie"
      : "token_online 和 Cookie（沿用原 appId）",
  );
}

function readValue(name) {
  if (typeof $persistentStore === "undefined" || !$persistentStore) return null;
  var direct = $persistentStore.read(
    "@" + APP.namespace + "." + APP.name + "." + name,
  );
  if (direct !== null && direct !== undefined) return direct;
  var root = readRoot();
  var appStore = root[APP.name];
  return appStore && appStore[name] !== undefined ? appStore[name] : null;
}

function writeValue(name, value) {
  if (typeof $persistentStore === "undefined" || !$persistentStore) {
    throw new Error("Surge 持久化存储不可用。");
  }

  var root = readRoot();
  if (!root[APP.name] || typeof root[APP.name] !== "object") {
    root[APP.name] = {};
  }
  root[APP.name][name] = String(value);

  if (!$persistentStore.write(JSON.stringify(root), APP.namespace)) {
    throw new Error("写入 Surge 持久化存储失败。");
  }
}

function readRoot() {
  var raw =
    typeof $persistentStore !== "undefined" && $persistentStore
      ? $persistentStore.read(APP.namespace)
      : null;
  var parsed = safeJson(raw, {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
}

function getPath(object, path, fallback) {
  if (object === null || object === undefined) return fallback;
  var value = object;
  var parts = String(path).split(".");
  for (var index = 0; index < parts.length; index += 1) {
    if (value === null || value === undefined) return fallback;
    value = value[parts[index]];
  }
  return value === undefined ? fallback : value;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  var target = String(name).toLowerCase();
  var key = Object.keys(headers).find(function (candidate) {
    return String(candidate).toLowerCase() === target;
  });
  return key === undefined ? "" : headers[key];
}

function mergeCookies(existing, incoming) {
  var values = {};
  collectCookies(existing, values);
  collectCookies(incoming, values);
  return Object.keys(values)
    .map(function (name) {
      return name + "=" + values[name];
    })
    .join("; ");
}

function collectCookies(input, output) {
  if (!input) return;
  var items = Array.isArray(input) ? input : [input];
  var attributes = [
    "domain",
    "path",
    "expires",
    "max-age",
    "samesite",
    "secure",
    "httponly",
    "priority",
  ];

  items.forEach(function (item) {
    String(item)
      .replace(/,\s*(?=[^;,=\s]+=)/g, ";")
      .split(";")
      .forEach(function (part) {
        var separator = part.indexOf("=");
        if (separator <= 0) return;
        var name = part.slice(0, separator).trim();
        var value = part.slice(separator + 1).trim();
        if (!name || attributes.indexOf(name.toLowerCase()) >= 0) return;
        output[name] = value;
      });
  });
}

function safeJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch (_error) {
    return fallback;
  }
}

function publicError(error) {
  var message =
    error && error.message
      ? error.message
      : error && error.error
        ? error.error
        : String(error || "未知错误");
  return redact(message).slice(0, 300);
}

function redact(value) {
  return String(value || "")
    .replace(/\b1\d{10}\b/g, "1**********")
    .replace(
      /((?:token_online|tokenOnline|password|cookie|appId)\s*[:=]\s*)[^\s,;&}]+/gi,
      "$1***",
    );
}

function log(message) {
  console.log("[ChinaUnicom Capture] " + redact(message));
}

function localNotification(title, subtitle, description) {
  if (typeof $notification !== "undefined" && $notification) {
    $notification.post(title, subtitle, description);
  }
}

function done(value) {
  if (typeof $done === "function") $done(value || {});
}
