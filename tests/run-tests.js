"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const MAIN = path.join(ROOT, "10010.js");
const CAPTURE = path.join(ROOT, "10010_capture.js");

function usageFixture() {
  return {
    code: "0000",
    time: "2026-08-14 12:00:00",
    packageName: "测试套餐",
    summary: { sum: "5120", freeFlow: "1024" },
    resources: [
      {
        type: "flow",
        details: [
          {
            limited: "0",
            feePolicyId: "normal-1",
            feePolicyName: "国内通用流量",
            total: "10240",
            remain: "6144",
            use: "4096",
            endDate: "2026-08-31",
          },
        ],
      },
    ],
    mlresources: [
      {
        type: "flow",
        details: [
          {
            limited: "0",
            feePolicyId: "free-1",
            feePolicyName: "专属免流",
            addupItemCode: "40008",
            total: "2048",
            remain: "1024",
            use: "1024",
            endDate: "2026-08-31",
          },
        ],
      },
    ],
  };
}

function createRoot(values) {
  return JSON.stringify({ "10010v4": Object.assign({}, values) });
}

function readAppStore(storage) {
  return JSON.parse(storage.get("ChinaUnicom") || "{}")["10010v4"] || {};
}

function executeScript(file, options) {
  options = options || {};
  const source = fs.readFileSync(file, "utf8");
  const storage = new Map(Object.entries(options.storage || {}));
  const logs = [];
  const notifications = [];
  const requests = [];

  return new Promise((resolve, reject) => {
    let finished = false;
    const deadline = setTimeout(() => {
      if (!finished) reject(new Error("Script did not call $done: " + file));
    }, 3000);

    const sandbox = {
      console: {
        log() {
          logs.push(Array.from(arguments).join(" "));
        },
      },
      setTimeout,
      clearTimeout,
      encodeURIComponent,
      decodeURIComponent,
      unescape,
      Uint8Array,
      BigInt,
      Math,
      Date,
      JSON,
      Promise,
      $persistentStore: {
        read(key) {
          return storage.has(key) ? storage.get(key) : null;
        },
        write(value, key) {
          storage.set(key, value);
          return true;
        },
      },
      $notification: {
        post(title, subtitle, body) {
          notifications.push({ title, subtitle, body });
        },
      },
      $httpClient: {},
      $done(value) {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        resolve({ value, storage, logs, notifications, requests });
      },
    };

    ["GET", "POST"].forEach((method) => {
      sandbox.$httpClient[method.toLowerCase()] = (request, callback) => {
        requests.push({ method, request });
        Promise.resolve()
          .then(() => {
            if (!options.route) {
              throw new Error("Unexpected request: " + request.url);
            }
            return options.route(method, request, requests.length);
          })
          .then((response) => {
            response = response || {};
            const body =
              typeof response.body === "string"
                ? response.body
                : JSON.stringify(response.body || {});
            callback(
              null,
              {
                statusCode: response.status || 200,
                headers: response.headers || {},
              },
              body,
            );
          })
          .catch((error) => callback(error));
      };
    });

    ["$argument", "$input", "$request", "$response", "$environment"].forEach(
      (key) => {
        if (Object.prototype.hasOwnProperty.call(options, key)) {
          sandbox[key] = options[key];
        }
      },
    );

    try {
      vm.runInNewContext(source, sandbox, {
        filename: file,
        timeout: 1000,
      });
    } catch (error) {
      clearTimeout(deadline);
      reject(error);
    }
  });
}

async function testCaptureManualRun() {
  const result = await executeScript(CAPTURE);
  assert.match(result.logs.join("\n"), /安全跳过/);
  assert.strictEqual(result.notifications.length, 0);
}

async function testCaptureStoresCredentials() {
  const result = await executeScript(CAPTURE, {
    $request: { headers: { Cookie: "sid=old; account=one" } },
    $response: {
      headers: {
        "Set-Cookie": ["sid=new; Path=/; HttpOnly", "extra=value; Path=/"],
      },
      body: JSON.stringify({
        code: "0",
        appId: "captured-app",
        token_online: "captured-token",
      }),
    },
  });

  const store = readAppStore(result.storage);
  assert.strictEqual(store.appId, "captured-app");
  assert.strictEqual(store.token_online, "captured-token");
  assert.match(store.cookie, /sid=new/);
  assert.match(store.cookie, /account=one/);
  assert.match(store.cookie, /extra=value/);
  assert.doesNotMatch(result.logs.join("\n"), /captured-token|sid=new/);
}

async function testPanelQueryAndNullArgument() {
  const result = await executeScript(MAIN, {
    storage: {
      ChinaUnicom: createRoot({ cookie: "sid=valid" }),
    },
    $argument: null,
    $input: { purpose: "panel" },
    route(_method, request) {
      assert.match(request.url, /queryOcsPackage/);
      return { body: usageFixture() };
    },
  });

  assert.strictEqual(result.value.title, "测试套餐");
  assert.match(result.value.content, /通用剩/);
  assert.strictEqual(result.notifications.length, 0);
  assert.ok(readAppStore(result.storage).vars);
}

async function testDataEndpoint() {
  const result = await executeScript(MAIN, {
    storage: {
      ChinaUnicom: createRoot({ cookie: "sid=valid" }),
    },
    $request: { url: "http://10010v4.com/data", headers: null },
    route() {
      return { body: usageFixture() };
    },
  });

  assert.strictEqual(result.value.response.status, 200);
  const body = JSON.parse(result.value.response.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.title, "测试套餐");
  assert.strictEqual(result.notifications.length, 0);
}

async function testPanelDoesNotAdvanceBaseline() {
  const baseline = {
    pkgs: [
      {
        id: "normal-1",
        use: 3000,
        remain: 7240,
        total: 10240,
      },
      {
        id: "free-1",
        use: 500,
        remain: 1548,
        total: 2048,
      },
    ],
    time: Date.now() - 3600000,
    sum: 3500,
    freeFlow: 500,
  };
  const baselineText = JSON.stringify(baseline);
  const result = await executeScript(MAIN, {
    storage: {
      ChinaUnicom: createRoot({
        cookie: "sid=valid",
        last: baselineText,
      }),
    },
    $input: { purpose: "panel" },
    route() {
      return { body: usageFixture() };
    },
  });

  const store = readAppStore(result.storage);
  assert.strictEqual(store.last, baselineText);
  assert.strictEqual(result.notifications.length, 0);
}

async function testTokenRecovery() {
  let queryCount = 0;
  const result = await executeScript(MAIN, {
    storage: {
      ChinaUnicom: createRoot({
        cookie: "sid=expired",
        appId: "captured-app",
        token_online: "old-token",
      }),
    },
    route(_method, request) {
      if (/queryOcsPackage/.test(request.url)) {
        queryCount += 1;
        return {
          body:
            queryCount === 1
              ? { code: "999998", desc: "Cookie 无效" }
              : usageFixture(),
        };
      }
      if (/onLine\.htm/.test(request.url)) {
        return {
          headers: { "Set-Cookie": "sid=fresh; Path=/; HttpOnly" },
          body: { code: "0", token_online: "fresh-token" },
        };
      }
      throw new Error("Unexpected URL: " + request.url);
    },
  });

  const store = readAppStore(result.storage);
  assert.strictEqual(queryCount, 2);
  assert.strictEqual(store.token_online, "fresh-token");
  assert.match(store.cookie, /sid=fresh/);
  assert.ok(JSON.parse(store.last).packages);
  assert.strictEqual(result.value.ok, true);
  assert.strictEqual(result.value.authMethod, "token");
  assert.strictEqual(result.value.packageCount, 2);
  assert.ok(result.value.elapsed);
  assert.doesNotMatch(result.logs.join("\n"), /fresh-token|sid=fresh/);
}

async function testPasswordRecovery() {
  let queryCount = 0;
  let loginBody = "";
  const result = await executeScript(MAIN, {
    storage: {
      ChinaUnicom: createRoot({
        cookie: "sid=expired",
        mobile: "13000000000",
        password: "example-password",
      }),
    },
    route(_method, request) {
      if (/queryOcsPackage/.test(request.url)) {
        queryCount += 1;
        return {
          body:
            queryCount === 1
              ? { code: "999998", desc: "Cookie 无效" }
              : usageFixture(),
        };
      }
      if (/login\.htm/.test(request.url)) {
        loginBody = request.body;
        return {
          headers: { "Set-Cookie": "sid=password-login; Path=/" },
          body: { code: "0", token_online: "password-token" },
        };
      }
      throw new Error("Unexpected URL: " + request.url);
    },
  });

  assert.strictEqual(queryCount, 2);
  assert.doesNotMatch(loginBody, /13000000000|example-password/);
  assert.match(loginBody, /mobile=[A-Za-z0-9%+/]+/);
  assert.match(readAppStore(result.storage).cookie, /sid=password-login/);
  assert.strictEqual(result.value.ok, true);
  assert.strictEqual(result.value.authMethod, "password");
}

async function testMissingCredentialsIsHandled() {
  const result = await executeScript(MAIN);
  assert.strictEqual(result.notifications.length, 1);
  assert.match(result.notifications[0].body, /登录信息不可用/);
  assert.strictEqual(result.value.ok, false);
  assert.strictEqual(result.value.kind, "auth");
  assert.strictEqual(result.value.status, 401);
  [
    "hasCookie",
    "hasToken",
    "hasAppId",
    "hasMobile",
    "hasPassword",
    "hasRootStore",
    "hasAppStore",
  ].forEach((key) => assert.strictEqual(result.value[key], false));
}

const tests = [
  testCaptureManualRun,
  testCaptureStoresCredentials,
  testPanelQueryAndNullArgument,
  testDataEndpoint,
  testPanelDoesNotAdvanceBaseline,
  testTokenRecovery,
  testPasswordRecovery,
  testMissingCredentialsIsHandled,
];

(async () => {
  for (const test of tests) {
    await test();
    process.stdout.write("PASS " + test.name + "\n");
  }
  process.stdout.write("All " + tests.length + " tests passed.\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
