/**
 * Cloudflare Access service token, checked on the wire.
 *
 * test/utils/cloudflare-access.test.ts covers the resolver and BASE_HEADERS.
 * This suite covers the two requests that build their own headers and so do
 * not inherit BASE_HEADERS: the `doctor --probe` request and the download proxy.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { MockGitLabServer, findMockServerPort } from "./utils/mock-gitlab-server.js";
import {
  HOST,
  TransportMode,
  findAvailablePort,
  launchServer,
  type ServerInstance,
} from "./utils/server-launcher.js";

const SERVER_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../build/index.js"
);

// Obvious placeholders: no real Cloudflare or GitLab value belongs in this repository.
const DUMMY_PAT = "glpat-dummy-cloudflare-access-test";
const DUMMY_CF_TOKEN = "dummy-cf-token";
const DUMMY_CLIENT_ID = "dummy-client-id.access";
const DUMMY_CLIENT_SECRET = "dummy-client-secret";

const CLOUDFLARE_HEADER_NAMES = [
  "cf-access-token",
  "cf-access-client-id",
  "cf-access-client-secret",
] as const;

type CloudflareHeaders = Partial<Record<(typeof CLOUDFLARE_HEADER_NAMES)[number], string>>;

function cloudflareHeadersOf(headers: http.IncomingHttpHeaders): CloudflareHeaders {
  const found: CloudflareHeaders = {};
  for (const name of CLOUDFLARE_HEADER_NAMES) {
    const value = headers[name];
    if (typeof value === "string") {
      found[name] = value;
    }
  }
  return found;
}

interface ProbeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Cloudflare headers of each request the fake GitLab received. */
  readonly received: readonly CloudflareHeaders[];
}

describe("doctor --probe with a Cloudflare Access service token", { timeout: 60_000 }, () => {
  let fakeGitLab: http.Server;
  let elsewhere: http.Server;
  let apiUrl: string;
  let redirectingApiUrl: string;
  let received: CloudflareHeaders[] = [];
  let receivedElsewhere: CloudflareHeaders[] = [];

  const listen = (server: http.Server): Promise<string> =>
    new Promise(resolve =>
      server.listen(0, "127.0.0.1", () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      )
    );

  before(async () => {
    elsewhere = http.createServer((req, res) => {
      receivedElsewhere.push(cloudflareHeadersOf(req.headers));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 1, username: "dummy" }));
    });
    const elsewhereOrigin = await listen(elsewhere);

    fakeGitLab = http.createServer((req, res) => {
      received.push(cloudflareHeadersOf(req.headers));
      if (req.url?.startsWith("/redirecting/")) {
        res.writeHead(302, { Location: `${elsewhereOrigin}/api/v4/user` });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: 1, username: "dummy" }));
    });
    const origin = await listen(fakeGitLab);
    apiUrl = `${origin}/api/v4`;
    redirectingApiUrl = `${origin}/redirecting/api/v4`;
  });

  after(async () => {
    for (const server of [fakeGitLab, elsewhere]) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  function probe(
    cloudflareEnv: Record<string, string>,
    targetApiUrl: string = apiUrl
  ): Promise<ProbeRun> {
    received = [];
    receivedElsewhere = [];
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("GITLAB_") || key.startsWith("CF_")) {
        delete env[key];
      }
    }
    Object.assign(env, cloudflareEnv, {
      GITLAB_API_URL: targetApiUrl,
      GITLAB_PERSONAL_ACCESS_TOKEN: DUMMY_PAT,
      GITLAB_DISABLE_VERSION_CHECK: "true",
      LOG_FORMAT: "json",
      NO_PROXY: "127.0.0.1",
    });

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SERVER_ENTRY, "doctor", "--probe"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => (stdout += String(chunk)));
      child.stderr.on("data", chunk => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", code => resolve({ code, stdout, stderr, received: [...received] }));
    });
  }

  function assertNoValueInOutput(run: ProbeRun): void {
    for (const value of [DUMMY_CF_TOKEN, DUMMY_CLIENT_ID, DUMMY_CLIENT_SECRET]) {
      assert.ok(!run.stdout.includes(value), "stdout must not carry a Cloudflare value");
      assert.ok(!run.stderr.includes(value), "stderr must not carry a Cloudflare value");
    }
  }

  test("sends no Cloudflare header when no variable is set", async () => {
    const run = await probe({});

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.received, [{}]);
  });

  test("sends cf-access-token alone for CF_TOKEN alone", async () => {
    const run = await probe({ CF_TOKEN: DUMMY_CF_TOKEN });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.received, [{ "cf-access-token": DUMMY_CF_TOKEN }]);
    assertNoValueInOutput(run);
  });

  test("sends both service token headers when both variables are set", async () => {
    const run = await probe({
      CF_ACCESS_CLIENT_ID: DUMMY_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.received, [
      { "cf-access-client-id": DUMMY_CLIENT_ID, "cf-access-client-secret": DUMMY_CLIENT_SECRET },
    ]);
    assertNoValueInOutput(run);
  });

  test("sends all three headers when CF_TOKEN and the service token are set", async () => {
    const run = await probe({
      CF_TOKEN: DUMMY_CF_TOKEN,
      CF_ACCESS_CLIENT_ID: DUMMY_CLIENT_ID,
      CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.received, [
      {
        "cf-access-token": DUMMY_CF_TOKEN,
        "cf-access-client-id": DUMMY_CLIENT_ID,
        "cf-access-client-secret": DUMMY_CLIENT_SECRET,
      },
    ]);
    assertNoValueInOutput(run);
  });

  test("sends neither service token header when only the secret is set, and warns on stderr", async () => {
    const run = await probe({ CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.received, [{}]);
    assert.match(
      run.stderr,
      /Ignoring CF_ACCESS_CLIENT_SECRET because CF_ACCESS_CLIENT_ID is not set/
    );
    assert.ok(!run.stdout.includes("CF_ACCESS_CLIENT"), "the warning must stay off stdout");
    assertNoValueInOutput(run);
  });

  test("does not follow a redirect to another origin with the service token", async () => {
    const run = await probe(
      { CF_ACCESS_CLIENT_ID: DUMMY_CLIENT_ID, CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET },
      redirectingApiUrl
    );

    assert.equal(run.code, 1, "the probe reports the redirect as a failure");
    assert.match(run.stdout, /GET \/user 302/);
    assert.equal(run.received.length, 1);
    assert.deepEqual(receivedElsewhere, []);
    assertNoValueInOutput(run);
  });

  test("follows a redirect exactly as before for CF_TOKEN alone", async () => {
    const run = await probe({ CF_TOKEN: DUMMY_CF_TOKEN }, redirectingApiUrl);

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.received, [{ "cf-access-token": DUMMY_CF_TOKEN }]);
    assert.deepEqual(receivedElsewhere, [{ "cf-access-token": DUMMY_CF_TOKEN }]);
  });
});

describe("download proxy with a Cloudflare Access service token", { timeout: 60_000 }, () => {
  const PROJECT_ID = "123";
  const JOB_ID = "456";
  let mockGitLab: MockGitLabServer;
  let server: ServerInstance;
  let serverPort: number;
  const received: CloudflareHeaders[] = [];

  before(async () => {
    mockGitLab = new MockGitLabServer({
      port: await findMockServerPort(),
      validTokens: [DUMMY_PAT],
    });
    mockGitLab.addMockHandler(
      "get",
      `/projects/${PROJECT_ID}/jobs/${JOB_ID}/artifacts`,
      (req, res) => {
        received.push(cloudflareHeadersOf(req.headers));
        res.set("Content-Type", "application/zip");
        res.send(Buffer.from("dummy-artifact"));
      }
    );
    await mockGitLab.start();

    serverPort = await findAvailablePort(3620);
    server = await launchServer({
      mode: TransportMode.STREAMABLE_HTTP,
      port: serverPort,
      timeout: 10_000,
      env: {
        STREAMABLE_HTTP: "true",
        REMOTE_AUTHORIZATION: "true",
        MCP_TRUST_PROXY: "false",
        MCP_SERVER_URL: "",
        GITLAB_API_URL: `${mockGitLab.getUrl()}/api/v4`,
        GITLAB_TOOLSETS: "core,pipelines",
        GITLAB_DISABLE_VERSION_CHECK: "true",
        CF_TOKEN: DUMMY_CF_TOKEN,
        CF_ACCESS_CLIENT_ID: DUMMY_CLIENT_ID,
        CF_ACCESS_CLIENT_SECRET: DUMMY_CLIENT_SECRET,
      },
    });
  });

  after(async () => {
    if (server) server.kill();
    if (mockGitLab) await mockGitLab.stop();
  });

  test("forwards all three headers to GitLab and returns none of them", async () => {
    const res = await fetch(
      `http://${HOST}:${serverPort}/downloads/job-artifacts?project_id=${PROJECT_ID}&job_id=${JOB_ID}`,
      { headers: { "Private-Token": DUMMY_PAT } }
    );

    assert.equal(res.status, 200);
    assert.equal(await res.text(), "dummy-artifact");
    assert.deepEqual(received, [
      {
        "cf-access-token": DUMMY_CF_TOKEN,
        "cf-access-client-id": DUMMY_CLIENT_ID,
        "cf-access-client-secret": DUMMY_CLIENT_SECRET,
      },
    ]);
    for (const name of CLOUDFLARE_HEADER_NAMES) {
      assert.equal(res.headers.get(name), null);
    }
  });
});
