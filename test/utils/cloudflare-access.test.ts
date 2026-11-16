import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";

import {
  guardCloudflareAccessServiceToken,
  resolveCloudflareAccessServiceTokenHeaders,
  type CloudflareAccessServiceTokenSource,
} from "../../cloudflare-access.js";

// Obvious placeholders: no real Cloudflare value belongs in this repository.
const DUMMY_CF_TOKEN = "dummy-cf-token";
const DUMMY_CLIENT_ID = "dummy-client-id.access";
const DUMMY_CLIENT_SECRET = "dummy-client-secret";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REQUEST_CONTEXT_URL = pathToFileURL(
  path.join(REPO_ROOT, "server/gitlab-request-context.ts")
).href;

const BASE_HEADERS_TODAY = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

interface Resolved {
  readonly headers: Readonly<Record<string, string>>;
  readonly warnings: readonly string[];
}

function resolveFrom(source: Omit<CloudflareAccessServiceTokenSource, "warn">): Resolved {
  const warnings: string[] = [];
  const headers = resolveCloudflareAccessServiceTokenHeaders({
    ...source,
    warn(message: string): void {
      warnings.push(message);
    },
  });
  return { headers, warnings };
}

interface ChildRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * config.ts reads the environment once at import, so each case needs its own
 * process, started without any GitLab or Cloudflare variable of the caller.
 */
function runWithRequestContext(
  script: string,
  cloudflareEnv: Record<string, string>
): Promise<ChildRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GITLAB_") || key.startsWith("CF_")) {
      delete env[key];
    }
  }
  Object.assign(env, cloudflareEnv, { LOG_FORMAT: "json", NO_PROXY: "127.0.0.1" });

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script],
      { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += String(chunk)));
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

/** The child prints the real BASE_HEADERS, built from the real config. */
function printBaseHeaders(cloudflareEnv: Record<string, string>): Promise<ChildRun> {
  return runWithRequestContext(
    `const context = await import(${JSON.stringify(REQUEST_CONTEXT_URL)});
process.stdout.write(JSON.stringify(context.BASE_HEADERS));`,
    cloudflareEnv
  );
}

/** Two origins on the loopback: `gitlab` answers or redirects, `elsewhere` only answers. */
interface RedirectFixture {
  readonly gitlabOrigin: string;
  readonly elsewhereOrigin: string;
  /** Requests received since the last reset, as "<server> <path>" to lowercased headers. */
  readonly received: Map<string, http.IncomingHttpHeaders>;
  close(): Promise<void>;
}

async function startRedirectFixture(): Promise<RedirectFixture> {
  const received = new Map<string, http.IncomingHttpHeaders>();
  const listen = (server: http.Server): Promise<string> =>
    new Promise(resolve =>
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      )
    );

  const elsewhere = http.createServer((req, res) => {
    received.set(`elsewhere ${req.url}`, req.headers);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const elsewhereOrigin = await listen(elsewhere);

  const gitlab = http.createServer((req, res) => {
    received.set(`gitlab ${req.url}`, req.headers);
    if (req.url === "/api/v4/to-elsewhere") {
      res.writeHead(302, { Location: `${elsewhereOrigin}/landing` });
      res.end();
      return;
    }
    if (req.url === "/api/v4/to-self") {
      res.writeHead(302, { Location: "/api/v4/landing" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const gitlabOrigin = await listen(gitlab);

  return {
    gitlabOrigin,
    elsewhereOrigin,
    received,
    async close(): Promise<void> {
      for (const server of [gitlab, elsewhere]) {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  };
}

async function baseHeadersFor(cloudflareEnv: Record<string, string>): Promise<{
  readonly headers: Record<string, string>;
  readonly run: ChildRun;
}> {
  const run = await printBaseHeaders(cloudflareEnv);
  assert.equal(run.code, 0, run.stderr);
  // stdout carries the MCP protocol in stdio mode: nothing but the JSON may land there,
  // so the parse fails if a warning is written to it.
  return { headers: JSON.parse(run.stdout) as Record<string, string>, run };
}

describe("resolveCloudflareAccessServiceTokenHeaders", () => {
  it("returns no header and no warning when neither variable is set", () => {
    for (const source of [
      { clientId: undefined, clientSecret: undefined },
      { clientId: "", clientSecret: "" },
      { clientId: "  ", clientSecret: undefined },
    ]) {
      assert.deepEqual(resolveFrom(source), { headers: {}, warnings: [] });
    }
  });

  it("returns both headers when both variables are set", () => {
    const { headers, warnings } = resolveFrom({
      clientId: DUMMY_CLIENT_ID,
      clientSecret: DUMMY_CLIENT_SECRET,
    });

    assert.deepEqual(headers, {
      "CF-Access-Client-Id": DUMMY_CLIENT_ID,
      "CF-Access-Client-Secret": DUMMY_CLIENT_SECRET,
    });
    assert.deepEqual(warnings, []);
  });

  it("trims the whitespace a launcher may leave around a value", () => {
    const { headers } = resolveFrom({
      clientId: ` ${DUMMY_CLIENT_ID}\n`,
      clientSecret: `${DUMMY_CLIENT_SECRET}\r\n`,
    });

    assert.deepEqual(headers, {
      "CF-Access-Client-Id": DUMMY_CLIENT_ID,
      "CF-Access-Client-Secret": DUMMY_CLIENT_SECRET,
    });
  });

  it("returns no header and warns without the value when only the client ID is set", () => {
    for (const clientSecret of [undefined, "", "   "]) {
      const { headers, warnings } = resolveFrom({ clientId: DUMMY_CLIENT_ID, clientSecret });

      assert.deepEqual(headers, {});
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /CF_ACCESS_CLIENT_ID\b.*CF_ACCESS_CLIENT_SECRET is not set/);
      assert.ok(!warnings[0].includes(DUMMY_CLIENT_ID));
    }
  });

  it("returns no header and warns without the value when only the client secret is set", () => {
    const { headers, warnings } = resolveFrom({
      clientId: undefined,
      clientSecret: DUMMY_CLIENT_SECRET,
    });

    assert.deepEqual(headers, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /CF_ACCESS_CLIENT_SECRET\b.*CF_ACCESS_CLIENT_ID is not set/);
    assert.ok(!warnings[0].includes(DUMMY_CLIENT_SECRET));
  });

  it("refuses a value fetch() would reject, without quoting it", () => {
    const multiLineSecret = `${DUMMY_CLIENT_SECRET}\ninjected: header`;
    const { headers, warnings } = resolveFrom({
      clientId: DUMMY_CLIENT_ID,
      clientSecret: multiLineSecret,
    });

    assert.deepEqual(headers, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /CF_ACCESS_CLIENT_SECRET is not a valid HTTP header value/);
    assert.ok(!warnings[0].includes(DUMMY_CLIENT_SECRET));
    assert.ok(!warnings[0].includes(DUMMY_CLIENT_ID));
  });
});

describe("BASE_HEADERS built from the process environment", () => {
  it("is unchanged when no Cloudflare variable is set", async () => {
    const { headers, run } = await baseHeadersFor({});

    assert.deepEqual(headers, BASE_HEADERS_TODAY);
    assert.doesNotMatch(run.stderr, /CF_ACCESS_CLIENT/);
  });

  it("is unchanged for CF_TOKEN alone", async () => {
    const { headers, run } = await baseHeadersFor({ CF_TOKEN: DUMMY_CF_TOKEN });

    assert.deepEqual(headers, { ...BASE_HEADERS_TODAY, "cf-access-token": DUMMY_CF_TOKEN });
    assert.doesNotMatch(run.stderr, /CF_ACCESS_CLIENT/);
  });

  it("carries both service token headers when both variables are set", async () => {
    const { headers, run } = await baseHeadersFor({
      CF_ACCESS_CLIENT_ID: DUMMY_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET,
    });

    assert.deepEqual(headers, {
      ...BASE_HEADERS_TODAY,
      "CF-Access-Client-Id": DUMMY_CLIENT_ID,
      "CF-Access-Client-Secret": DUMMY_CLIENT_SECRET,
    });
    assert.doesNotMatch(run.stderr, /CF_ACCESS_CLIENT/);
  });

  it("carries all three headers when CF_TOKEN and the service token are set", async () => {
    const { headers } = await baseHeadersFor({
      CF_TOKEN: DUMMY_CF_TOKEN,
      CF_ACCESS_CLIENT_ID: DUMMY_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET,
    });

    assert.deepEqual(headers, {
      ...BASE_HEADERS_TODAY,
      "cf-access-token": DUMMY_CF_TOKEN,
      "CF-Access-Client-Id": DUMMY_CLIENT_ID,
      "CF-Access-Client-Secret": DUMMY_CLIENT_SECRET,
    });
  });

  for (const [present, value] of [
    ["CF_ACCESS_CLIENT_ID", DUMMY_CLIENT_ID],
    ["CF_ACCESS_CLIENT_SECRET", DUMMY_CLIENT_SECRET],
  ] as const) {
    it(`carries neither service token header when only ${present} is set, and warns on stderr`, async () => {
      const { headers, run } = await baseHeadersFor({ CF_TOKEN: DUMMY_CF_TOKEN, [present]: value });

      // CF_TOKEN keeps working on its own.
      assert.deepEqual(headers, { ...BASE_HEADERS_TODAY, "cf-access-token": DUMMY_CF_TOKEN });
      assert.match(run.stderr, new RegExp(`Ignoring ${present} because`));
      assert.ok(!run.stderr.includes(value), "the warning must not carry the value");
    });
  }
});

describe("guardCloudflareAccessServiceToken", () => {
  const SERVICE_TOKEN_HEADERS = {
    "CF-Access-Client-Id": DUMMY_CLIENT_ID,
    "CF-Access-Client-Secret": DUMMY_CLIENT_SECRET,
  };
  const REQUEST_HEADERS = {
    Accept: "application/json",
    "cf-access-token": DUMMY_CF_TOKEN,
    ...SERVICE_TOKEN_HEADERS,
  };
  let fixture: RedirectFixture;
  let agent: Agent;

  before(async () => {
    fixture = await startRedirectFixture();
    agent = new Agent();
  });

  after(async () => {
    await agent.close();
    await fixture.close();
  });

  function serviceTokenOf(headers: http.IncomingHttpHeaders | undefined): unknown {
    assert.ok(headers, "the request was not received");
    return {
      id: headers["cf-access-client-id"],
      secret: headers["cf-access-client-secret"],
    };
  }

  it("returns the dispatcher itself when no service token is configured", () => {
    assert.equal(guardCloudflareAccessServiceToken(agent, fixture.gitlabOrigin, {}), agent);
  });

  it("returns the same guarded dispatcher for the same origin", () => {
    const apiUrl = `${fixture.gitlabOrigin}/api/v4`;
    const guarded = guardCloudflareAccessServiceToken(agent, apiUrl, SERVICE_TOKEN_HEADERS);

    assert.notEqual(guarded, agent);
    assert.equal(guardCloudflareAccessServiceToken(agent, apiUrl, SERVICE_TOKEN_HEADERS), guarded);
  });

  it("documents the leak it closes: fetch() forwards custom headers to another origin", async () => {
    fixture.received.clear();
    await undiciFetch(`${fixture.gitlabOrigin}/api/v4/to-elsewhere`, {
      headers: REQUEST_HEADERS,
      dispatcher: agent,
    });

    assert.deepEqual(serviceTokenOf(fixture.received.get("elsewhere /landing")), {
      id: DUMMY_CLIENT_ID,
      secret: DUMMY_CLIENT_SECRET,
    });
  });

  it("drops the service token on a redirect to another origin, and nothing else", async () => {
    fixture.received.clear();
    const response = await undiciFetch(`${fixture.gitlabOrigin}/api/v4/to-elsewhere`, {
      headers: REQUEST_HEADERS,
      dispatcher: guardCloudflareAccessServiceToken(
        agent,
        `${fixture.gitlabOrigin}/api/v4`,
        SERVICE_TOKEN_HEADERS
      ),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(serviceTokenOf(fixture.received.get("gitlab /api/v4/to-elsewhere")), {
      id: DUMMY_CLIENT_ID,
      secret: DUMMY_CLIENT_SECRET,
    });
    const landing = fixture.received.get("elsewhere /landing");
    assert.deepEqual(serviceTokenOf(landing), { id: undefined, secret: undefined });
    // Only the two service token headers are removed: CF_TOKEN behaves as before.
    assert.equal(landing?.accept, "application/json");
    assert.equal(landing?.["cf-access-token"], DUMMY_CF_TOKEN);
  });

  it("keeps the service token on a same-origin redirect", async () => {
    fixture.received.clear();
    await undiciFetch(`${fixture.gitlabOrigin}/api/v4/to-self`, {
      headers: REQUEST_HEADERS,
      dispatcher: guardCloudflareAccessServiceToken(
        agent,
        `${fixture.gitlabOrigin}/api/v4`,
        SERVICE_TOKEN_HEADERS
      ),
    });

    assert.deepEqual(serviceTokenOf(fixture.received.get("gitlab /api/v4/landing")), {
      id: DUMMY_CLIENT_ID,
      secret: DUMMY_CLIENT_SECRET,
    });
  });

  it("drops the service token everywhere when the API URL cannot be parsed", async () => {
    fixture.received.clear();
    await undiciFetch(`${fixture.gitlabOrigin}/api/v4/landing`, {
      headers: REQUEST_HEADERS,
      dispatcher: guardCloudflareAccessServiceToken(agent, "not a url", SERVICE_TOKEN_HEADERS),
    });

    assert.deepEqual(serviceTokenOf(fixture.received.get("gitlab /api/v4/landing")), {
      id: undefined,
      secret: undefined,
    });
  });
});

describe("getFetchConfig() with a service token in the environment", () => {
  let fixture: RedirectFixture;

  before(async () => {
    fixture = await startRedirectFixture();
  });

  after(async () => {
    await fixture.close();
  });

  it("sends the service token to GitLab and not to the origin GitLab redirects to", async () => {
    const script = `const context = await import(${JSON.stringify(REQUEST_CONTEXT_URL)});
const { Agent, fetch } = await import("undici");
const agent = new Agent();
context.configureGitLabRequestContext({
  logger: { debug() {}, warn() {} },
  getDefaultApiUrl: () => ${JSON.stringify(`${fixture.gitlabOrigin}/api/v4`)},
  getDefaultAllowedProjectIds: () => [],
  getDispatcherForUrl: () => agent,
  getOAuthAccessToken: () => null,
});
const response = await fetch(${JSON.stringify(`${fixture.gitlabOrigin}/api/v4/to-elsewhere`)}, context.getFetchConfig());
process.stdout.write(String(response.status));
await agent.close();`;

    const run = await runWithRequestContext(script, {
      GITLAB_PERSONAL_ACCESS_TOKEN: "glpat-dummy-cloudflare-access-test",
      CF_ACCESS_CLIENT_ID: DUMMY_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "200");
    const first = fixture.received.get("gitlab /api/v4/to-elsewhere");
    assert.equal(first?.["cf-access-client-id"], DUMMY_CLIENT_ID);
    assert.equal(first?.["cf-access-client-secret"], DUMMY_CLIENT_SECRET);
    const landing = fixture.received.get("elsewhere /landing");
    assert.ok(landing, "the redirect was not followed");
    assert.equal(landing["cf-access-client-id"], undefined);
    assert.equal(landing["cf-access-client-secret"], undefined);
  });
});
