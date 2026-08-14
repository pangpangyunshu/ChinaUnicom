"use strict";

// ChinaUnicom V4 - Surge edition
// Clean rewrite. Existing BoxJs keys under @ChinaUnicom.10010v4.* remain valid.

var APP = {
  namespace: "ChinaUnicom",
  name: "10010v4",
  title: "联通余量",
  queryUrl:
    "https://m.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune",
  infoUrl:
    "https://m.client.10010.com/servicequerybusiness/query/myInformation",
  loginUrl: "https://m.client.10010.com/mobileService/login.htm",
  onlineUrl: "https://m.client.10010.com/mobileService/onLine.htm",
  defaultAppId: "ChinaunicomMobileBusiness",
  iosVersion: "iphone_c@9.0100",
  androidVersion: "android@11.0900",
  timeout: 20,
};

var RESOURCE_NAMES = {
  resources: "套餐内流量&流量包",
  unshared: "套餐内流量&流量包(非共享)",
  rzbresources: "日租宝",
  mlresources: "免流流量",
  twresources: "套外流量",
};

var GROUP_DEFINITIONS = {
  freeUnlimited: { name: "免流不限" },
  freeLimited: { name: "免流有限" },
  free: { name: "所有免流" },
  normalUnlimited: { name: "通用不限" },
  normalLimited: { name: "通用有限" },
  normal: { name: "所有通用" },
};

var INVALID_RESOURCE_KEYS = ["usepercent", "accountbar"];
var INVALID_RESOURCE_TYPES = [
  "voice",
  "smslist",
  "unsharedsmslist",
  "unsharedvoicelist",
];
var AUTH_CODES = ["999999", "999998"];
var MAINTENANCE_CODES = ["4114030182", "9999", "9998", "0001"];
var PANEL_ARGUMENTS = parseArguments(
  typeof $argument === "string" ? $argument : "",
);
var MODE = detectMode();
var STARTED_AT = Date.now();

main().then(finishSuccess).catch(finishFailure);

async function main() {
  log("开始执行，模式: " + MODE.kind);

  var credentials = readCredentials();
  debugLog("登录信息状态", {
    hasCookie: !!credentials.cookie,
    hasToken: !!credentials.tokenOnline,
    hasAppId: !!credentials.appId,
    hasMobile: !!credentials.mobile,
    hasPassword: !!credentials.password,
  });

  var queryResult = await queryWithRecovery(credentials);
  var parsed = await parseUsage(queryResult.data, queryResult.cookie);
  var configResult = updatePackageConfig(parsed.packages);
  parsed.config = configResult.config;

  if (
    MODE.kind === "query" &&
    !readBoolean("new_pkg_notify_disabled") &&
    configResult.newPackages.length > 0
  ) {
    await sendNotification(
      APP.title,
      "发现新流量包",
      configResult.newPackages.join("\n"),
    );
  }

  var result = await buildResult(parsed);
  result.authMethod = queryResult.authMethod || "unknown";
  result.elapsed = formatDuration((Date.now() - STARTED_AT) / 1000);
  log("执行完成，用时 " + result.elapsed);
  return result;
}

async function queryWithRecovery(credentials) {
  var recoveryErrors = [];

  if (credentials.cookie) {
    try {
      var direct = await queryUsage(credentials.cookie);
      return {
        data: direct,
        cookie: credentials.cookie,
        authMethod: "cookie",
      };
    } catch (error) {
      if (!isAuthError(error)) throw error;
      recoveryErrors.push(error);
      log("Cookie 已失效，尝试恢复登录");
    }
  }

  if (credentials.tokenOnline) {
    try {
      var refreshed = await refreshOnline(credentials);
      var tokenData = await queryUsage(refreshed.cookie);
      return {
        data: tokenData,
        cookie: refreshed.cookie,
        authMethod: "token",
      };
    } catch (error) {
      recoveryErrors.push(error);
      log("Token 刷新失败，继续检查服务密码登录");
    }
  }

  if (credentials.mobile && credentials.password) {
    try {
      var signedIn = await passwordLogin(credentials);
      var passwordData = await queryUsage(signedIn.cookie);
      return {
        data: passwordData,
        cookie: signedIn.cookie,
        authMethod: "password",
      };
    } catch (error) {
      recoveryErrors.push(error);
    }
  }

  var networkError = recoveryErrors.find(function (error) {
    return error && error.kind === "network";
  });
  if (networkError) throw networkError;

  throw new ScriptError(
    "登录信息不可用。请打开中国联通 App 触发一次抓包，或在 BoxJs 更新账号信息。",
    "auth",
    401,
  );
}

async function queryUsage(cookie) {
  var result = await requestJson({
    method: "POST",
    url: APP.queryUrl,
    headers: {
      Accept: "application/json",
      Cookie: cookie,
    },
  });

  assertApiSuccess(result.data, ["0000", "0"], "查询余量");
  return result.data;
}

async function queryPackageName(cookie) {
  var result = await requestJson({
    method: "POST",
    url: APP.infoUrl,
    headers: {
      Accept: "application/json",
      Cookie: cookie,
    },
  });

  assertApiSuccess(result.data, ["0000", "0"], "查询套餐");
  return getPath(result.data, "data.myPackage.productname", "");
}

async function refreshOnline(credentials) {
  if (!credentials.appId) {
    throw new ScriptError(
      "缺少 appId，无法使用 token_online 刷新登录。",
      "auth",
      401,
    );
  }

  var result = await requestJson({
    method: "POST",
    url: APP.onlineUrl,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formEncode({
      appId: credentials.appId,
      token_online: credentials.tokenOnline,
      version: APP.iosVersion,
    }),
  });

  assertApiSuccess(result.data, ["0", "0000"], "刷新登录");

  var tokenOnline =
    getPath(result.data, "token_online", "") || credentials.tokenOnline;
  var cookie = mergeCookies(
    credentials.cookie,
    getHeader(result.response.headers, "set-cookie"),
  );

  if (!cookie) {
    throw new ScriptError("刷新登录未返回 Cookie。", "auth", 401);
  }

  writeValue("token_online", tokenOnline);
  writeValue("cookie", cookie);
  log("Token 登录已刷新");
  return { tokenOnline: tokenOnline, cookie: cookie };
}

async function passwordLogin(credentials) {
  var hasCapturedAppId = !!credentials.appId;
  var payload = {
    mobile: rsaEncrypt(credentials.mobile),
    password: rsaEncrypt(credentials.password),
    appId: hasCapturedAppId ? credentials.appId : APP.defaultAppId,
    version: hasCapturedAppId ? APP.iosVersion : APP.androidVersion,
  };

  if (!hasCapturedAppId) payload.isFirstInstall = 1;

  var headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (!hasCapturedAppId) {
    headers["User-Agent"] =
      "Dalvik/2.1.0 (Linux; U; Android 14);unicom{version:" +
      APP.androidVersion +
      "}";
  }

  var result = await requestJson({
    method: "POST",
    url: APP.loginUrl,
    headers: headers,
    body: formEncode(payload),
  });

  assertApiSuccess(result.data, ["0", "0000"], "服务密码登录");

  var tokenOnline = getPath(result.data, "token_online", "");
  var cookie = mergeCookies(
    "",
    getHeader(result.response.headers, "set-cookie"),
  );

  if (!tokenOnline || !cookie) {
    throw new ScriptError(
      "服务密码登录成功，但响应中缺少 Cookie 或 token_online。",
      "auth",
      401,
    );
  }

  writeValue("token_online", tokenOnline);
  writeValue("cookie", cookie);
  if (!credentials.appId) writeValue("appId", APP.defaultAppId);
  log("服务密码登录成功");
  return { tokenOnline: tokenOnline, cookie: cookie };
}

async function parseUsage(data, cookie) {
  var packages = [];
  var keys = Object.keys(data || {});

  keys.forEach(function (resourceKey) {
    var normalizedKey = String(resourceKey).toLowerCase();
    if (INVALID_RESOURCE_KEYS.indexOf(normalizedKey) >= 0) return;

    var resourceGroups = data[resourceKey];
    if (!Array.isArray(resourceGroups)) return;

    var resourceName =
      RESOURCE_NAMES[normalizedKey] || "未知资源: " + normalizedKey;

    resourceGroups.forEach(function (resourceGroup) {
      var resourceType = String(
        getPath(resourceGroup, "type", ""),
      ).toLowerCase();
      if (INVALID_RESOURCE_TYPES.indexOf(resourceType) >= 0) return;

      var details = getPath(resourceGroup, "details", []);
      if (!Array.isArray(details)) return;

      details.forEach(function (detail) {
        var item = normalizePackage(detail, resourceName, resourceType);
        if (item) packages.push(item);
      });
    });
  });

  var packageName = String(getPath(data, "packageName", "") || "");
  if (!packageName && cookie) {
    try {
      packageName = await queryPackageName(cookie);
    } catch (error) {
      debugLog("套餐名称查询失败", publicError(error));
    }
  }

  var sum = nonNegativeNumber(getPath(data, "summary.sum", 0));
  var freeFlow = nonNegativeNumber(getPath(data, "summary.freeFlow", 0));

  writeJson("pkgs", packages);
  return {
    packages: packages,
    packageName: packageName || "未知套餐",
    sourceTime: getPath(data, "time", ""),
    sum: sum,
    freeFlow: freeFlow,
  };
}

function normalizePackage(detail, resourceName, resourceType) {
  if (!detail || typeof detail !== "object") return null;

  var feePolicyId = String(getPath(detail, "feePolicyId", "") || "");
  var addupItemCode = String(getPath(detail, "addupItemCode", "") || "");
  var feePolicyName = String(getPath(detail, "feePolicyName", "") || "");
  var addUpItemName = String(getPath(detail, "addUpItemName", "") || "");
  var id = feePolicyId + (addupItemCode ? "（" + addupItemCode + "）" : "");
  var name = feePolicyName + (addUpItemName ? "（" + addUpItemName + "）" : "");

  if (!id) id = feePolicyName || addUpItemName;
  if (!id) return null;
  if (!name) name = id;
  if (resourceType === "unsharedflowlist") id += "[unsharedFlowList]";

  var use = getPath(detail, "use", 0);
  var viceCards = getPath(detail, "viceCardlist", []);
  if (Array.isArray(viceCards) && viceCards.length > 1) {
    var currentCard = viceCards.find(function (card) {
      return String(getPath(card, "currentLoginFlag", "")) === "1";
    });
    if (currentCard && getPath(currentCard, "use", "") !== "") {
      use = getPath(currentCard, "use", use);
    }
  }

  use = nonNegativeNumber(use);
  var exceed = nonNegativeNumber(getPath(detail, "xexceedvalue", 0));
  if (use <= 0 && exceed > 0) use = exceed;

  return {
    id: id,
    name: name,
    use: use,
    total: nonNegativeNumber(getPath(detail, "total", 0)),
    remain: nonNegativeNumber(getPath(detail, "remain", 0)),
    unlimited: String(getPath(detail, "limited", "")) === "1",
    endDate:
      getPath(detail, "endDate", "") || getPath(detail, "endXsbDate", ""),
    type: resourceName,
    resourceType: resourceType,
    addupItemCode: addupItemCode,
    addUpItemName: addUpItemName,
    feePolicyName: feePolicyName,
    feePolicyId: feePolicyId,
  };
}

function updatePackageConfig(packages) {
  var existing = readJson("config", {});
  var firstConfig =
    !existing ||
    typeof existing !== "object" ||
    Object.keys(existing).length === 0;
  if (firstConfig) existing = {};

  var detected = {};
  Object.keys(GROUP_DEFINITIONS).forEach(function (key) {
    detected[key] = [];
  });

  packages.forEach(function (item) {
    var isFree =
      item.addupItemCode === "40008" ||
      item.addUpItemName === "套餐内专享免费流量" ||
      item.type === "免流流量" ||
      /（免流）|\(免流\)|畅视/.test(item.feePolicyName);

    if (isFree) {
      detected.free.push(item.id);
      detected[item.unlimited ? "freeUnlimited" : "freeLimited"].push(item.id);
    } else {
      detected.normal.push(item.id);
      detected[item.unlimited ? "normalUnlimited" : "normalLimited"].push(
        item.id,
      );
    }
  });

  var nextConfig = {};
  var newPackages = [];

  Object.keys(GROUP_DEFINITIONS).forEach(function (key) {
    var previous = existing[key] || {};
    var currentIds = unique(detected[key]);
    var previousDetected = Array.isArray(previous._pkgIds)
      ? previous._pkgIds
      : [];
    var selected = Array.isArray(previous.pkgIds)
      ? previous.pkgIds.filter(function (id) {
          return currentIds.indexOf(id) >= 0;
        })
      : currentIds.slice();

    currentIds.forEach(function (id) {
      if (previousDetected.indexOf(id) < 0 && selected.indexOf(id) < 0) {
        selected.push(id);
      }
      if (
        !firstConfig &&
        previousDetected.indexOf(id) < 0 &&
        ["free", "normal"].indexOf(key) < 0
      ) {
        var pkg = packages.find(function (item) {
          return item.id === id;
        });
        if (pkg)
          newPackages.push(GROUP_DEFINITIONS[key].name + ": " + pkg.name);
      }
    });

    nextConfig[key] = Object.assign({}, previous, {
      name: GROUP_DEFINITIONS[key].name,
      disabled:
        typeof previous.disabled === "boolean" ? previous.disabled : true,
      pkgIds: unique(selected),
      _pkgIds: currentIds,
    });
  });

  writeJson("config", nextConfig);
  return { config: nextConfig, newPackages: unique(newPackages) };
}

async function buildResult(parsed) {
  var now = Date.now();
  var current = createSnapshot(parsed, now);
  var last = readJson("last", null);
  var today = readJson("today", null);
  var firstSnapshot = !isValidSnapshot(last);

  if (firstSnapshot || looksLikeMonthlyReset(current.packages, last.packages)) {
    last = current;
    writeJson("last", current);
  }

  if (!isValidSnapshot(today) || !isSameDay(today.time, now)) {
    today = current;
    writeJson("today", current);
  }

  var vars = buildVariables(parsed, last, today, now);
  var titleTemplate = readValue("title") || "[套餐]";
  var subtitleTemplate =
    readValue("subt") || "[时长] 跳 [所有通用.用量] 免 [所有免流.用量]";
  var descriptionTemplate =
    readValue("desc") || "通用剩 [通用有限.剩余] 免流剩 [免流有限.剩余]";

  var title = renderTemplate(titleTemplate, vars) || APP.title;
  var subtitle = renderTemplate(subtitleTemplate, vars);
  var description = renderTemplate(descriptionTemplate, vars);
  var result = {
    ok: true,
    title: title,
    subt: subtitle,
    desc: description,
    updatedAt: now,
    sourceTime: parsed.sourceTime || "",
    packageCount: parsed.packages.length,
    vars: vars,
  };

  vars.title = title;
  vars.subt = subtitle;
  vars.desc = description;
  vars.updatedAt = now;
  writeJson("vars", vars);

  if (
    MODE.kind === "query" &&
    shouldNotify(titleTemplate, subtitleTemplate, descriptionTemplate, vars)
  ) {
    await sendNotification(title, subtitle, description);
  }

  if (MODE.kind === "query") writeJson("last", current);
  return result;
}

function buildVariables(parsed, last, today, now) {
  var vars = {};
  var negativeDeltas = [];

  Object.keys(parsed.config).forEach(function (key) {
    var group = parsed.config[key] || {};
    var name = group.name || GROUP_DEFINITIONS[key].name;
    var ids = Array.isArray(group.pkgIds) ? group.pkgIds : [];
    var currentTotals = sumPackages(parsed.packages, ids);
    var lastTotals = sumPackages(last.packages, ids);
    var todayTotals = sumPackages(today.packages, ids);
    var intervalUse = currentTotals.use - lastTotals.use;
    var todayUse = currentTotals.use - todayTotals.use;

    if (intervalUse < 0) {
      negativeDeltas.push(name);
      intervalUse = 0;
    }
    if (todayUse < 0) todayUse = 0;

    setMetricVariables(vars, name, currentTotals, intervalUse, todayUse);
  });

  var currentGeneral = Math.max(0, parsed.sum - parsed.freeFlow);
  var lastGeneral = Math.max(0, last.sum - last.freeFlow);
  var todayGeneral = Math.max(0, today.sum - today.freeFlow);
  setRawUsageVariables(
    vars,
    "原始通用",
    currentGeneral,
    Math.max(0, currentGeneral - lastGeneral),
    Math.max(0, currentGeneral - todayGeneral),
  );
  setRawUsageVariables(
    vars,
    "原始免流",
    parsed.freeFlow,
    Math.max(0, parsed.freeFlow - last.freeFlow),
    Math.max(0, parsed.freeFlow - today.freeFlow),
  );

  vars["[时长]"] = formatDuration(Math.max(0, now - last.time) / 1000);
  vars["[套餐]"] = parsed.packageName;
  vars["[联通时间]"] = parsed.sourceTime || "";
  vars["[日期时间]"] = new Date(now).toLocaleString("zh-CN");
  vars["[时间]"] = new Date(now).toLocaleTimeString("zh-CN");
  if (negativeDeltas.length > 0) {
    debugLog("检测到流量包计数回退", unique(negativeDeltas));
  }
  return vars;
}

function setMetricVariables(vars, name, totals, intervalUse, todayUse) {
  vars["[" + name + ".已用]"] = formatFlow(totals.use);
  vars["[" + name + ".剩余]"] = formatFlow(totals.remain);
  vars["[" + name + ".总]"] = formatFlow(totals.total);
  vars["[" + name + ".用量]"] = formatFlow(intervalUse);
  vars["[" + name + ".今日用量]"] = formatFlow(todayUse);
  vars["[" + name + ".已用].raw"] = totals.use;
  vars["[" + name + ".剩余].raw"] = totals.remain;
  vars["[" + name + ".总].raw"] = totals.total;
  vars["[" + name + ".用量].raw"] = intervalUse;
  vars["[" + name + ".今日用量].raw"] = todayUse;
}

function setRawUsageVariables(vars, name, used, intervalUse, todayUse) {
  vars["[" + name + ".已用]"] = formatFlow(used);
  vars["[" + name + ".用量]"] = formatFlow(intervalUse);
  vars["[" + name + ".今日用量]"] = formatFlow(todayUse);
  vars["[" + name + ".已用].raw"] = used;
  vars["[" + name + ".用量].raw"] = intervalUse;
  vars["[" + name + ".今日用量].raw"] = todayUse;
}

function shouldNotify(
  titleTemplate,
  subtitleTemplate,
  descriptionTemplate,
  vars,
) {
  var minUsage = nonNegativeNumber(readValue("min_usage") || 0);
  if (minUsage <= 0) return true;

  if (readBoolean("normal_limited_only")) {
    return Number(vars["[通用有限.用量].raw"] || 0) >= minUsage;
  }

  var template = [titleTemplate, subtitleTemplate, descriptionTemplate].join(
    " ",
  );
  var matches = template.match(/\[[^\]]+\.用量\]/g) || [];
  if (matches.length === 0) return true;
  return matches.some(function (key) {
    return Number(vars[key + ".raw"] || 0) >= minUsage;
  });
}

async function sendNotification(title, subtitle, description) {
  if (MODE.kind !== "query") return;

  var barkTemplate = readValue("bark");
  if (barkTemplate) {
    var barkUrl = replaceAllLiteral(
      replaceAllLiteral(
        String(barkTemplate),
        "[推送标题]",
        encodeURIComponent(title),
      ),
      "[推送内容]",
      encodeURIComponent((subtitle ? subtitle + "\n" : "") + description),
    );

    try {
      var barkResponse = await request({
        method: "GET",
        url: barkUrl,
        headers: { Accept: "application/json" },
      });
      var barkBody = safeJson(barkResponse.body, null);
      if (
        barkResponse.status >= 400 ||
        (barkBody && String(barkBody.code) !== "200")
      ) {
        throw new ScriptError("Bark 返回异常。", "network", 502);
      }
      return;
    } catch (error) {
      log("Bark 推送失败，改用 Surge 本地通知");
    }
  }

  localNotification(title, subtitle, description);
}

function localNotification(title, subtitle, description) {
  if (typeof $notification !== "undefined" && $notification) {
    $notification.post(
      String(title || APP.title),
      String(subtitle || ""),
      String(description || ""),
    );
  }
}

async function finishSuccess(result) {
  if (MODE.kind === "panel") {
    var panel = Object.assign({}, PANEL_ARGUMENTS, {
      title: result.title || APP.title,
      content:
        (result.subt || "") +
        (result.desc ? "\n" + result.desc : "") +
        "\n更新 " +
        formatClock(result.updatedAt),
    });
    return done(panel);
  }

  if (MODE.kind === "data") {
    return done(jsonResponse(200, result));
  }

  return done({
    ok: result.ok !== false,
    title: result.title || APP.title,
    subt: result.subt || "",
    desc: result.desc || "",
    authMethod: result.authMethod || "unknown",
    packageCount: Number(result.packageCount) || 0,
    sourceTime: result.sourceTime || "",
    elapsed: result.elapsed || formatDuration((Date.now() - STARTED_AT) / 1000),
  });
}

async function finishFailure(error) {
  var message = publicError(error);
  log("执行失败: " + message);

  if (MODE.kind === "panel") {
    var cached = readJson("vars", {});
    var cachedDescription =
      cached && cached.desc ? "\n上次: " + cached.desc : "";
    var panel = Object.assign({}, PANEL_ARGUMENTS, {
      title: (cached && cached.title) || APP.title,
      content: "更新失败\n" + message + cachedDescription,
    });
    return done(panel);
  }

  if (MODE.kind === "data") {
    return done(
      jsonResponse(error && error.status ? error.status : 502, {
        ok: false,
        error: message,
      }),
    );
  }

  localNotification(APP.title, "执行失败", message);
  return done(
    Object.assign(
      {
        ok: false,
        error: message,
        kind: error && error.kind ? error.kind : "runtime",
        status: error && error.status ? Number(error.status) : 502,
      },
      credentialDiagnostics(),
    ),
  );
}

function requestJson(options) {
  return request(options).then(function (response) {
    var data = safeJson(response.body, null);
    if (!data || typeof data !== "object") {
      throw new ScriptError(
        "接口返回的不是有效 JSON。",
        "network",
        response.status || 502,
      );
    }
    return { data: data, response: response };
  });
}

function request(options) {
  return new Promise(function (resolve, reject) {
    if (typeof $httpClient === "undefined" || !$httpClient) {
      reject(
        new ScriptError("当前环境没有 Surge HTTP 客户端。", "runtime", 500),
      );
      return;
    }

    var method = String(options.method || "GET").toLowerCase();
    var clientMethod = $httpClient[method];
    if (typeof clientMethod !== "function") {
      reject(new ScriptError("不支持的请求方法: " + method, "runtime", 500));
      return;
    }

    var requestOptions = Object.assign({}, options);
    delete requestOptions.method;
    requestOptions.timeout = Number(
      options.timeout || readValue("http_timeout") || APP.timeout,
    );
    requestOptions.headers = Object.assign({}, options.headers || {});
    delete requestOptions.headers["Content-Length"];
    delete requestOptions.headers["content-length"];

    debugLog("请求", method.toUpperCase() + " " + safeUrl(options.url));

    var settled = false;
    var timeoutMs = Math.max(1, requestOptions.timeout) * 1000;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new ScriptError("请求超时。", "network", 504));
    }, timeoutMs + 1000);

    clientMethod.call(
      $httpClient,
      requestOptions,
      function (error, response, body) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (error) {
          reject(
            new ScriptError(
              "网络请求失败: " + publicError(error),
              "network",
              502,
            ),
          );
          return;
        }

        response = response || {};
        var status = parseStatus(response.statusCode || response.status);
        var responseBody =
          body !== undefined && body !== null ? body : response.body || "";
        if (status >= 400) {
          reject(
            new ScriptError("接口 HTTP 状态异常: " + status, "network", status),
          );
          return;
        }

        resolve({
          status: status,
          headers: response.headers || {},
          body: responseBody,
        });
      },
    );
  });
}

function assertApiSuccess(data, successCodes, operation) {
  var code = String(getPath(data, "code", ""));
  if (successCodes.indexOf(code) >= 0) return;

  var description =
    getPath(data, "desc", "") ||
    getPath(data, "dsc", "") ||
    getPath(data, "message", "") ||
    "未知错误";
  var combined = code + " " + description + " " + safeStringify(data);

  if (
    AUTH_CODES.indexOf(code) >= 0 ||
    /Cookie\s*无效|未登录|登录失效|身份验证|请重新登录/i.test(combined)
  ) {
    throw new ScriptError(operation + ": 登录已失效。", "auth", 401);
  }

  if (MAINTENANCE_CODES.indexOf(code) >= 0) {
    throw new ScriptError(
      operation + ": 联通系统维护中 (" + code + ")。",
      "maintenance",
      503,
    );
  }

  if (/沃妹陪着您一起等待/.test(combined)) {
    throw new ScriptError(
      operation + ": 联通服务暂时不可用。",
      "maintenance",
      503,
    );
  }

  throw new ScriptError(
    operation +
      ": " +
      redact(String(description)) +
      (code ? " (" + code + ")" : ""),
    "api",
    502,
  );
}

function readCredentials() {
  return {
    appId: String(readValue("appId") || ""),
    mobile: String(readValue("mobile") || ""),
    password: String(readValue("password") || ""),
    cookie: String(readValue("cookie") || ""),
    tokenOnline: String(readValue("token_online") || ""),
  };
}

function credentialDiagnostics() {
  var credentials = readCredentials();
  var root = readRoot();
  var appStore = root[APP.name];
  return {
    hasCookie: !!credentials.cookie,
    hasToken: !!credentials.tokenOnline,
    hasAppId: !!credentials.appId,
    hasMobile: !!credentials.mobile,
    hasPassword: !!credentials.password,
    hasRootStore: Object.keys(root).length > 0,
    hasAppStore: !!(appStore && typeof appStore === "object"),
  };
}

function readValue(name) {
  if (typeof $persistentStore === "undefined" || !$persistentStore) return null;

  var directKey = "@" + APP.namespace + "." + APP.name + "." + name;
  var direct = $persistentStore.read(directKey);
  if (direct !== null && direct !== undefined) return direct;

  var root = readRoot();
  var appStore = root[APP.name];
  if (!appStore || typeof appStore !== "object") return null;
  return appStore[name] !== undefined ? appStore[name] : null;
}

function writeValue(name, value) {
  if (typeof $persistentStore === "undefined" || !$persistentStore)
    return false;
  var root = readRoot();
  if (!root[APP.name] || typeof root[APP.name] !== "object") {
    root[APP.name] = {};
  }
  root[APP.name][name] =
    value === null || value === undefined ? "" : String(value);
  return $persistentStore.write(JSON.stringify(root), APP.namespace);
}

function readRoot() {
  if (typeof $persistentStore === "undefined" || !$persistentStore) return {};
  var raw = $persistentStore.read(APP.namespace);
  var root = safeJson(raw, {});
  return root && typeof root === "object" && !Array.isArray(root) ? root : {};
}

function readJson(name, fallback) {
  var value = readValue(name);
  if (value && typeof value === "object") return value;
  return safeJson(value, fallback);
}

function writeJson(name, value) {
  return writeValue(name, JSON.stringify(value));
}

function readBoolean(name) {
  return String(readValue(name) || "").toLowerCase() === "true";
}

function getPath(object, path, fallback) {
  if (object === null || object === undefined) return fallback;
  var parts = Array.isArray(path) ? path : String(path).split(".");
  var value = object;
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

function formEncode(values) {
  return Object.keys(values)
    .filter(function (key) {
      return values[key] !== null && values[key] !== undefined;
    })
    .map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(values[key]);
    })
    .join("&");
}

function createSnapshot(parsed, time) {
  return {
    packages: parsed.packages,
    pkgs: parsed.packages,
    time: time,
    sum: parsed.sum,
    freeFlow: parsed.freeFlow,
  };
}

function isValidSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  if (!Number(snapshot.time)) return false;
  if (!Array.isArray(snapshot.packages) && Array.isArray(snapshot.pkgs)) {
    snapshot.packages = snapshot.pkgs;
  }
  return Array.isArray(snapshot.packages);
}

function looksLikeMonthlyReset(currentPackages, previousPackages) {
  if (!Array.isArray(currentPackages) || !Array.isArray(previousPackages)) {
    return false;
  }
  var matched = 0;
  var decreased = 0;
  currentPackages.forEach(function (current) {
    var previous = previousPackages.find(function (item) {
      return item.id === current.id;
    });
    if (!previous) return;
    matched += 1;
    if (Number(current.use) + 1 < Number(previous.use)) decreased += 1;
  });
  return matched > 0 && decreased >= Math.max(1, Math.ceil(matched / 2));
}

function sumPackages(packages, ids) {
  return ids.reduce(
    function (totals, id) {
      var item = packages.find(function (candidate) {
        return candidate.id === id;
      });
      if (!item) return totals;
      totals.use += nonNegativeNumber(item.use);
      totals.remain += nonNegativeNumber(item.remain);
      totals.total += nonNegativeNumber(item.total);
      return totals;
    },
    { use: 0, remain: 0, total: 0 },
  );
}

function renderTemplate(template, variables) {
  var rendered = String(template || "");
  Object.keys(variables)
    .sort(function (left, right) {
      return right.length - left.length;
    })
    .forEach(function (key) {
      rendered = replaceAllLiteral(rendered, key, variables[key]);
    });
  return rendered
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function replaceAllLiteral(input, search, replacement) {
  return String(input).split(String(search)).join(String(replacement));
}

function nonNegativeNumber(value) {
  var number = Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatFlow(value) {
  var number = Number(value);
  if (!Number.isFinite(number)) number = 0;
  var absolute = Math.abs(number);
  if (absolute < 1024) return round(number, 2) + "M";
  if (absolute < 1024 * 1024) return round(number / 1024, 2) + "G";
  if (absolute < 1024 * 1024 * 1024)
    return round(number / 1024 / 1024, 2) + "T";
  return round(number / 1024 / 1024 / 1024, 2) + "P";
}

function formatDuration(seconds) {
  var value = Number(seconds) || 0;
  if (value < 60) return round(value, 0) + "秒";
  if (value < 3600) return round(value / 60, 1) + "分钟";
  if (value < 86400) return round(value / 3600, 1) + "小时";
  return round(value / 86400, 1) + "天";
}

function round(value, digits) {
  var factor = Math.pow(10, digits || 0);
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function isSameDay(left, right) {
  var a = new Date(Number(left));
  var b = new Date(Number(right));
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function parseArguments(input) {
  var result = {};
  if (typeof input !== "string" || !input.trim()) return result;
  input.split("&").forEach(function (part) {
    var separator = part.indexOf("=");
    var key = separator < 0 ? part : part.slice(0, separator);
    var value = separator < 0 ? "" : part.slice(separator + 1);
    if (!key) return;
    try {
      result[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch (_error) {
      result[key] = value;
    }
  });
  return result;
}

function detectMode() {
  var panel =
    typeof $input !== "undefined" &&
    $input &&
    String($input.purpose || "").toLowerCase() === "panel";
  var requestUrl =
    typeof $request !== "undefined" && $request
      ? String($request.url || "")
      : "";
  var data = /^https?:\/\/10010v4\.com\/data(?:[/?#]|$)/i.test(requestUrl);
  return { kind: panel ? "panel" : data ? "data" : "query" };
}

function jsonResponse(status, body) {
  return {
    response: {
      status: status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(body),
    },
  };
}

function done(value) {
  if (typeof $done === "function") $done(value || {});
}

function parseStatus(value) {
  var match = String(value || "").match(/\d{3}/);
  return match ? Number(match[0]) : 200;
}

function safeJson(value, fallback) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch (_error) {
    return fallback;
  }
}

function safeStringify(value) {
  try {
    return redact(JSON.stringify(value));
  } catch (_error) {
    return "";
  }
}

function safeUrl(value) {
  return String(value || "")
    .replace(/([?&](?:token|key|password|mobile|cookie)[^=]*=)[^&]*/gi, "$1***")
    .replace(/\/[^/?#]{20,}(?=\/|$)/g, "/***");
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

function log() {
  var parts = Array.prototype.slice.call(arguments).map(function (item) {
    return typeof item === "string" ? redact(item) : safeStringify(item);
  });
  console.log("[ChinaUnicom] " + parts.join(" "));
}

function debugLog() {
  if (!readBoolean("debug")) return;
  log.apply(null, arguments);
}

function formatClock(time) {
  var date = new Date(Number(time) || Date.now());
  return [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join(":");
}

function pad2(value) {
  return String(value).length < 2 ? "0" + value : String(value);
}

function unique(values) {
  return values.filter(function (value, index, list) {
    return value && list.indexOf(value) === index;
  });
}

function isAuthError(error) {
  return !!(error && error.kind === "auth");
}

function ScriptError(message, kind, status) {
  this.name = "ScriptError";
  this.message = message;
  this.kind = kind || "runtime";
  this.status = status || 500;
  if (Error.captureStackTrace) Error.captureStackTrace(this, ScriptError);
}
ScriptError.prototype = Object.create(Error.prototype);
ScriptError.prototype.constructor = ScriptError;

// PKCS#1 v1.5 RSA encryption for the public key used by the official client.
// BigInt is only touched when service-password fallback is actually required.
function rsaEncrypt(text) {
  if (typeof BigInt !== "function") {
    throw new ScriptError(
      "当前 Surge JavaScript 环境不支持服务密码登录，请打开中国联通 App 重新抓取登录信息。",
      "auth",
      401,
    );
  }

  var modulusHex =
    "dcf8264af5b040f4853e81950e73a1541aeef23bd5a94cd0743f39a014187de8" +
    "c8355aba2f0f5a2a67e7881782e3bf129718e748efd25176f7bd34f850a34efe" +
    "baa190804e229b0367471ecf16d091af288811c5286afb8db6e455a01026eaa7" +
    "41d12adcb606aa19f2e02af6473a7c138f236a8c1531ccc7909440b673310c4b";
  var keyLength = 128;
  var message = utf8Bytes(String(text));
  if (message.length > keyLength - 11) {
    throw new ScriptError("服务密码登录字段过长。", "auth", 400);
  }

  var padding = randomNonZeroBytes(keyLength - message.length - 3);
  var block = [0, 2].concat(padding, [0], message);
  var value = bytesToBigInt(block);
  var encrypted = modPow(value, BigInt(65537), BigInt("0x" + modulusHex));
  return bytesToBase64(bigIntToBytes(encrypted, keyLength));
}

function modPow(base, exponent, modulus) {
  var result = BigInt(1);
  var value = base % modulus;
  var power = exponent;
  while (power > BigInt(0)) {
    if (power % BigInt(2) === BigInt(1)) {
      result = (result * value) % modulus;
    }
    power = power / BigInt(2);
    value = (value * value) % modulus;
  }
  return result;
}

function bytesToBigInt(bytes) {
  var hex = bytes
    .map(function (byte) {
      var value = Number(byte).toString(16);
      return value.length < 2 ? "0" + value : value;
    })
    .join("");
  return BigInt("0x" + hex);
}

function bigIntToBytes(value, length) {
  var hex = value.toString(16);
  while (hex.length < length * 2) hex = "0" + hex;
  var bytes = [];
  for (var index = 0; index < hex.length; index += 2) {
    bytes.push(parseInt(hex.slice(index, index + 2), 16));
  }
  return bytes.slice(-length);
}

function utf8Bytes(value) {
  var encoded = unescape(encodeURIComponent(value));
  var bytes = [];
  for (var index = 0; index < encoded.length; index += 1) {
    bytes.push(encoded.charCodeAt(index));
  }
  return bytes;
}

function randomNonZeroBytes(length) {
  var bytes = new Array(length);
  var secure = null;
  try {
    if (
      typeof crypto !== "undefined" &&
      crypto &&
      typeof crypto.getRandomValues === "function"
    ) {
      secure = new Uint8Array(length);
      crypto.getRandomValues(secure);
    }
  } catch (_error) {}

  for (var index = 0; index < length; index += 1) {
    var value = secure ? secure[index] : Math.floor(Math.random() * 255) + 1;
    bytes[index] = value === 0 ? 1 : value;
  }
  return bytes;
}

function bytesToBase64(bytes) {
  var alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var output = "";
  for (var index = 0; index < bytes.length; index += 3) {
    var a = bytes[index];
    var b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    var c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    var triple = (a << 16) | (b << 8) | c;
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? alphabet[triple & 63] : "=";
  }
  return output;
}
