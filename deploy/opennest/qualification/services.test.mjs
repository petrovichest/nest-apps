import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createQualificationServices } from "./services.mjs";

const execute = promisify(execFile);
async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "open-services-"));
  const home = join(root, "home"),
    inputDirectory = join(root, "input"),
    privateDirectory = join(root, "private");
  await Promise.all([home, inputDirectory, privateDirectory].map((path) => mkdir(path)));
  await writeFile(
    join(home, ".opennest-qualification"),
    "OpenNest synthetic qualification fixture v1\n",
  );
  const cert = join(privateDirectory, "fixture-cert.pem"),
    key = join(privateDirectory, "fixture-key.pem");
  await execute("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=model.openrouter.fixture",
    "-addext",
    "subjectAltName=DNS:model.openrouter.fixture,DNS:github.com,IP:127.0.0.2",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  const services = await createQualificationServices({
    home,
    inputDirectory,
    privateDirectory,
    cert,
    key,
    modelPort: 0,
    registryPort: 0,
    proxyPort: 0,
    controlPort: 0,
  });
  const control = async (value) => {
    const response = await fetch(
      `http://127.0.0.1:${services.controlPort}/${value ? "control" : "state"}`,
      {
        ...(value
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(value),
            }
          : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  return {
    ...services,
    home,
    root,
    inputDirectory,
    privateDirectory,
    ca: await readFile(cert),
    certPath: cert,
    control,
    async close() {
      await services.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
function modelRequest(fixture, marker) {
  return JSON.stringify({
    model: "qualification/fixture",
    messages: [{ role: "user", content: `QUALIFICATION_REQUEST:${marker}` }],
  });
}
async function direct(fixture, marker, key = "fixture-openrouter-key-1") {
  return new Promise((resolve, reject) => {
    const body = modelRequest(fixture, marker);
    const outgoing = request(
      {
        host: "127.0.0.2",
        port: fixture.modelPort,
        servername: "model.openrouter.fixture",
        ca: fixture.ca,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, raw }));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
async function proxied(fixture, marker) {
  const socket = connect(fixture.proxyPort, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const handshake = new Promise((resolve, reject) => {
    socket.once("data", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `CONNECT model.openrouter.fixture:${fixture.modelPort} HTTP/1.1\r\nHost: model.openrouter.fixture:${fixture.modelPort}\r\nProxy-Authorization: Basic ${Buffer.from("fixture-user:fixture-proxy-password").toString("base64")}\r\n\r\n`,
  );
  const result = String(await handshake);
  if (!result.startsWith("HTTP/1.1 200")) {
    socket.destroy();
    return result;
  }
  const secure = tlsConnect({ socket, servername: "model.openrouter.fixture", ca: fixture.ca });
  await new Promise((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  const body = modelRequest(fixture, marker),
    completed = new Promise((resolve, reject) => {
      let raw = "";
      secure.on("data", (chunk) => {
        raw += chunk;
      });
      secure.once("end", () => resolve(raw));
      secure.once("error", reject);
    });
  secure.write(
    `POST /v1/chat/completions HTTP/1.1\r\nHost: model.openrouter.fixture:${fixture.modelPort}\r\nAuthorization: Bearer fixture-openrouter-key-1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
  return completed;
}

test("fixture measures actual proxy traversal, direct model attempts and upstream failure", async () => {
  const fixture = await makeFixture();
  try {
    assert.match(await proxied(fixture, "via-proxy"), /QUALIFICATION_OK:via-proxy/);
    let state = (await fixture.control()).body;
    assert.equal(state.proxiedModelRequests, 1);
    assert.equal(state.directModelRequests, 0);
    assert.equal((await direct(fixture, "direct")).status, 200);
    state = (await fixture.control()).body;
    assert.equal(state.directModelRequests, 1);
    assert.equal(state.requests.direct, 1);
    await fixture.control({ proxyDown: true });
    assert.match(await proxied(fixture, "blocked"), /503 Service Unavailable/);
    assert.equal((await fixture.control()).body.requests.blocked, undefined);
  } finally {
    await fixture.close();
  }
});

test("registry serves exact private artifacts and rejects paths outside fixture roots", async () => {
  const fixture = await makeFixture();
  try {
    const path = join(fixture.inputDirectory, "installer.sh");
    await writeFile(path, "exact qualified bytes\n");
    const url = "/petrovichest/nest-apps/releases/download/qualification/OpenNest-install.sh";
    assert.equal(
      (await fixture.control({ files: { [url]: path }, manifest: { schemaVersion: 2 } })).status,
      200,
    );
    assert.equal((await fixture.control({ files: { [url]: "/etc/passwd" } })).status, 400);
    const content = await new Promise((resolve, reject) => {
      request(
        {
          host: "127.0.0.2",
          port: fixture.registryPort,
          servername: "github.com",
          ca: fixture.ca,
          path: url,
        },
        (response) => {
          let raw = "";
          response.on("data", (chunk) => {
            raw += chunk;
          });
          response.on("end", () => resolve(raw));
        },
      )
        .once("error", reject)
        .end();
    });
    assert.equal(content, "exact qualified bytes\n");
  } finally {
    await fixture.close();
  }
});

test("registry runs real smart HTTP Git so the actual installer can shallow-fetch an exact SHA", async () => {
  const fixture = await makeFixture();
  try {
    const source = join(fixture.root, "git-source"),
      checkout = join(fixture.root, "git-checkout");
    await execute("git", ["init", "-q", source]);
    const identity = [
      "-C",
      source,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=50870093+petrovichest@users.noreply.github.com",
    ];
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_EMAIL: "50870093+petrovichest@users.noreply.github.com",
      GIT_COMMITTER_EMAIL: "50870093+petrovichest@users.noreply.github.com",
    };
    await execute("git", [...identity, "commit", "--allow-empty", "-qm", "fixture baseline"], {
      env: gitEnv,
    });
    await execute("git", [...identity, "commit", "--allow-empty", "-qm", "fixture candidate"], {
      env: gitEnv,
    });
    const commit = (await execute("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
    await execute("git", [
      "clone",
      "--bare",
      "--no-hardlinks",
      source,
      join(fixture.inputDirectory, "nest-apps.git"),
    ]);
    await execute("git", ["init", "-q", checkout]);
    await execute("git", [
      "-C",
      checkout,
      "-c",
      "http.sslCAInfo=" + fixture.certPath,
      "fetch",
      "--depth=1",
      `https://127.0.0.2:${fixture.registryPort}/petrovichest/nest-apps.git`,
      commit,
    ]);
    assert.equal(
      (await execute("git", ["-C", checkout, "rev-parse", "FETCH_HEAD"])).stdout.trim(),
      commit,
    );
    assert.equal(
      (await execute("git", ["-C", checkout, "rev-list", "--count", "FETCH_HEAD"])).stdout.trim(),
      "1",
    );
    assert.equal((await fixture.state()).gitFailures, 0);
    assert.ok((await fixture.state()).gitRequests >= 2);
  } finally {
    await fixture.close();
  }
});

test("model accepts surviving previous auth contexts while proving new-key use after rotation", async () => {
  const fixture = await makeFixture();
  try {
    const oldKey = "fixture-openrouter-key-1",
      newKey = "fixture-openrouter-key-rotated";
    assert.equal(
      (await fixture.control({ authKey: newKey, acceptedAuthKeys: [oldKey, newKey] })).status,
      200,
    );
    assert.equal((await direct(fixture, "old-context", oldKey)).status, 200);
    assert.equal((await direct(fixture, "fresh-context", newKey)).status, 200);
    const state = (await fixture.control()).body;
    assert.deepEqual(state.authUsed["old-context"], { current: 0, previous: 1 });
    assert.deepEqual(state.authUsed["fresh-context"], { current: 1, previous: 0 });
    assert.ok(!JSON.stringify(state).includes(oldKey) && !JSON.stringify(state).includes(newKey));
    await fixture.control({ authKey: newKey });
    assert.equal((await direct(fixture, "rejected-old", oldKey)).status, 401);
  } finally {
    await fixture.close();
  }
});
