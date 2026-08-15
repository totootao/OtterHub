var assert = require("assert");

const API_URL = "http://localhost:8788";
const PASSWORD = "123456";
const API_TOKEN = "123456";

const basicAuth = (user, pass) =>
  "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>';

function davFetch(path, options = {}) {
  return fetch(`${API_URL}/dav${path}`, options);
}

function authed(path, options = {}) {
  const headers = {
    Authorization: basicAuth("admin", PASSWORD),
    ...(options.headers || {}),
  };
  return davFetch(path, { ...options, headers });
}

// 生成确定性的测试数据（便于分片后校验内容）
function makePatternBuffer(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (i * 7 + 13) % 251;
  }
  return buf;
}

describe("WebDAV", function () {
  this.timeout(120000);

  const SMALL_NAME = "webdav-test.txt";
  const SMALL_BODY = Buffer.from("hello webdav, this is otterhub!");

  // ---------- 认证 ----------
  describe("Authentication", function () {
    it("should reject unauthenticated PROPFIND with 401 + WWW-Authenticate", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 401);
      assert.ok(res.headers.get("www-authenticate").includes("Basic"));
    });

    it("should reject wrong password with 401", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: {
          Depth: "0",
          Authorization: basicAuth("admin", "wrong-password"),
        },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 401);
    });

    it("should reject wrong Bearer token with 401", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: {
          Depth: "0",
          Authorization: "Bearer invalid-token",
        },
      });
      assert.equal(res.status, 401);
    });

    it("should accept correct API_TOKEN as Bearer", async function () {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: {
          Depth: "0",
          Authorization: `Bearer ${API_TOKEN}`,
        },
      });
      assert.equal(res.status, 207);
    });

    it("should answer OPTIONS without auth (capability discovery)", async function () {
      const res = await davFetch("/", { method: "OPTIONS" });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("dav").includes("1"));
      assert.ok(res.headers.get("allow").includes("PROPFIND"));
      assert.ok(res.headers.get("allow").includes("PUT"));
    });
  });

  // ---------- PROPFIND ----------
  describe("PROPFIND", function () {
    it("should list root with four virtual collections (depth 1)", async function () {
      const res = await authed("/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      assert.ok(
        (res.headers.get("content-type") || "").includes("application/xml")
      );

      const xml = await res.text();
      for (const dir of ["img", "video", "audio", "doc"]) {
        assert.ok(
          xml.includes(`<D:href>/dav/${dir}/</D:href>`),
          `missing collection ${dir}`
        );
      }
      assert.ok(xml.includes("<D:collection/>"));
    });

    it("should return root itself for depth 0", async function () {
      const res = await authed("/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes("<D:href>/dav/</D:href>"));
      assert.ok(!xml.includes("<D:href>/dav/img/</D:href>"));
    });

    it("should return 404 for unknown path", async function () {
      const res = await authed("/nonexistent/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 404);
    });

    it("should return 404 for path traversal", async function () {
      const res = await authed("/img/..%2f..%2fetc", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 404);
    });
  });

  // ---------- PUT / GET / HEAD / DELETE ----------
  describe("PUT / GET / HEAD / DELETE", function () {
    it("should PUT a small file (201) and read it back verbatim", async function () {
      const put = await authed(`/doc/${SMALL_NAME}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: SMALL_BODY,
      });
      assert.equal(put.status, 201);

      const get = await authed(`/doc/${SMALL_NAME}`);
      assert.equal(get.status, 200);
      assert.equal(await get.text(), SMALL_BODY.toString());
    });

    it("should overwrite existing file (204) with new content", async function () {
      const newBody = Buffer.from("overwritten content v2");
      const put = await authed(`/doc/${SMALL_NAME}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: newBody,
      });
      assert.equal(put.status, 204);

      const get = await authed(`/doc/${SMALL_NAME}`);
      assert.equal(await get.text(), newBody.toString());
    });

    it("should support HEAD with metadata headers", async function () {
      const res = await authed(`/doc/${SMALL_NAME}`, { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("etag"));
      assert.ok(res.headers.get("last-modified"));
      assert.equal(
        parseInt(res.headers.get("content-length"), 10),
        "overwritten content v2".length
      );
    });

    it("should support Range requests (206)", async function () {
      const res = await authed(`/doc/${SMALL_NAME}`, {
        headers: { Range: "bytes=0-10" },
      });
      assert.equal(res.status, 206);
      const text = await res.text();
      assert.equal(text, "overwritten".slice(0, 11));
    });

    it("should show the file in collection PROPFIND", async function () {
      const res = await authed("/doc/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes(`<D:displayname>${SMALL_NAME}</D:displayname>`));
      assert.ok(xml.includes("<D:resourcetype/>"));
    });

    it("should DELETE file (204) then GET returns 404", async function () {
      const del = await authed(`/doc/${SMALL_NAME}`, { method: "DELETE" });
      assert.equal(del.status, 204);

      const get = await authed(`/doc/${SMALL_NAME}`);
      assert.equal(get.status, 404);
    });

    it("should PUT to collection path fail with 405", async function () {
      const res = await authed("/doc/", {
        method: "PUT",
        body: "x",
      });
      assert.equal(res.status, 405);
    });
  });

  // ---------- 大文件分片上传 ----------
  describe("Chunked PUT (21MB, 2 chunks)", function () {
    const BIG_NAME = "webdav-big-test.bin";
    const BIG_SIZE = 21 * 1024 * 1024; // 21MB -> 20MB + 1MB 两个分片
    let pattern;

    before(function () {
      pattern = makePatternBuffer(BIG_SIZE);
    });

    it("should upload via chunked path and return 201", async function () {
      const put = await authed(`/doc/${BIG_NAME}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: pattern,
      });
      assert.equal(put.status, 201);
    });

    it("should report correct size in PROPFIND", async function () {
      const res = await authed(`/doc/${BIG_NAME}`, {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: PROPFIND_BODY,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(
        xml.includes(`<D:getcontentlength>${BIG_SIZE}</D:getcontentlength>`)
      );
    });

    it("should stream back full content with correct bytes", async function () {
      const res = await authed(`/doc/${BIG_NAME}`);
      assert.equal(res.status, 200);

      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, BIG_SIZE);
      // 抽查首、中、尾与分片边界
      for (const offset of [
        0,
        1024,
        10 * 1024 * 1024,
        20 * 1024 * 1024 - 1,
        BIG_SIZE - 1,
      ]) {
        assert.equal(
          buf[offset],
          pattern[offset],
          `byte mismatch at offset ${offset}`
        );
      }
    });

    it("should serve Range requests across chunk boundary (206)", async function () {
      const start = 20 * 1024 * 1024 - 4;
      const end = 20 * 1024 * 1024 + 3;
      const res = await authed(`/doc/${BIG_NAME}`, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      assert.equal(res.status, 206);
      assert.ok(
        res.headers.get("content-range").startsWith(`bytes ${start}-${end}/`)
      );

      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(buf.length, end - start + 1);
      for (let i = 0; i < buf.length; i++) {
        assert.equal(buf[i], pattern[start + i], "range byte mismatch");
      }
    });

    it("should delete big file afterwards", async function () {
      const del = await authed(`/doc/${BIG_NAME}`, { method: "DELETE" });
      assert.equal(del.status, 204);
    });
  });

  // ---------- MOVE / COPY ----------
  describe("MOVE / COPY", function () {
    const srcName = "webdav-move-src.txt";
    const renamed = "webdav-move-dst.txt";
    const copied = "webdav-copy-dst.txt";

    before(async function () {
      const put = await authed(`/doc/${srcName}`, {
        method: "PUT",
        body: Buffer.from("move-copy source content"),
      });
      assert.equal(put.status, 201);
    });

    it("should MOVE (rename) file within collection", async function () {
      const res = await authed(`/doc/${srcName}`, {
        method: "MOVE",
        headers: {
          Destination: `/dav/doc/${renamed}`,
          Overwrite: "F",
        },
      });
      assert.equal(res.status, 201);

      const old = await authed(`/doc/${srcName}`);
      assert.equal(old.status, 404);

      const now = await authed(`/doc/${renamed}`);
      assert.equal(now.status, 200);
      assert.equal(await now.text(), "move-copy source content");
    });

    it("should COPY file and keep both", async function () {
      const res = await authed(`/doc/${renamed}`, {
        method: "COPY",
        headers: {
          Destination: `/dav/doc/${copied}`,
          Overwrite: "F",
        },
      });
      assert.equal(res.status, 201);

      const a = await authed(`/doc/${renamed}`);
      const b = await authed(`/doc/${copied}`);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.equal(await b.text(), "move-copy source content");
    });

    it("should reject MOVE onto existing destination without Overwrite: T (412)", async function () {
      const res = await authed(`/doc/${renamed}`, {
        method: "MOVE",
        headers: {
          Destination: `/dav/doc/${copied}`,
          Overwrite: "F",
        },
      });
      assert.equal(res.status, 412);
    });

    it("should allow cross-directory MOVE with fallback resolution", async function () {
      // 移动到 /dav/img/ 目录：仅重命名，文件仍归属 doc 类型，但可通过目标路径访问
      const res = await authed(`/doc/${copied}`, {
        method: "MOVE",
        headers: {
          Destination: `/dav/img/${copied}`,
          Overwrite: "T",
        },
      });
      assert.equal(res.status, 201);

      const viaImg = await authed(`/img/${copied}`);
      assert.equal(viaImg.status, 200);
    });

    it("should MOVE to same resource return 403", async function () {
      const res = await authed(`/img/${copied}`, {
        method: "MOVE",
        headers: { Destination: `/dav/img/${copied}` },
      });
      assert.equal(res.status, 403);
    });

    it("should MOVE without Destination return 400", async function () {
      const res = await authed(`/img/${copied}`, { method: "MOVE" });
      assert.equal(res.status, 400);
    });

    after(async function () {
      await authed(`/doc/${renamed}`, { method: "DELETE" }).catch(() => {});
      await authed(`/img/${copied}`, { method: "DELETE" }).catch(() => {});
      await authed(`/doc/${copied}`, { method: "DELETE" }).catch(() => {});
    });
  });

  // ---------- 其他方法 ----------
  describe("MKCOL / PROPPATCH / LOCK / UNLOCK", function () {
    it("should reject MKCOL with 405 (virtual collections only)", async function () {
      const res = await authed("/newfolder/", { method: "MKCOL" });
      assert.equal(res.status, 405);
    });

    it("should accept PROPPATCH with 207 multistatus", async function () {
      const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:propertyupdate xmlns:D="DAV:" xmlns:Z="urn:schemas-microsoft-com:">' +
        "<D:set><D:prop><Z:Win32LastModifiedTime>test</Z:Win32LastModifiedTime></D:prop></D:set>" +
        "</D:propertyupdate>";
      const res = await authed("/doc/", {
        method: "PROPPATCH",
        body,
      });
      assert.equal(res.status, 207);
      const xml = await res.text();
      assert.ok(xml.includes("HTTP/1.1 200 OK"));
      assert.ok(xml.includes("Win32LastModifiedTime"));
    });

    it("should grant LOCK with token (200)", async function () {
      const body =
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope>' +
        "<D:locktype><D:write/></D:locktype><D:owner>test</D:owner></D:lockinfo>";
      const res = await authed("/doc/locktest.txt", {
        method: "LOCK",
        headers: { Timeout: "Second-600" },
        body,
      });
      assert.equal(res.status, 200);
      const token = res.headers.get("lock-token");
      assert.ok(token && token.startsWith("<opaquelocktoken:"));

      const xml = await res.text();
      assert.ok(xml.includes("lockdiscovery"));

      const unlock = await authed("/doc/locktest.txt", {
        method: "UNLOCK",
        headers: { "Lock-Token": token },
      });
      assert.equal(unlock.status, 204);
    });

    it("should return 405 for unknown methods on /dav", async function () {
      const res = await authed("/doc/", { method: "SEARCH" });
      assert.ok([404, 405].includes(res.status));
    });
  });

  // ---------- 中文文件名与 HTML 索引 ----------
  describe("Unicode filenames & directory listing", function () {
    const cnName = "中文文件名测试.txt";

    it("should handle URL-encoded unicode filenames", async function () {
      const put = await authed(`/doc/${encodeURIComponent(cnName)}`, {
        method: "PUT",
        body: Buffer.from("中文内容 hello"),
      });
      assert.equal(put.status, 201);

      const propfind = await authed("/doc/", {
        method: "PROPFIND",
        headers: { Depth: "1" },
        body: PROPFIND_BODY,
      });
      const xml = await propfind.text();
      assert.ok(xml.includes(encodeURIComponent(cnName)));
      assert.ok(xml.includes(`<D:displayname>${cnName}</D:displayname>`));

      const del = await authed(`/doc/${encodeURIComponent(cnName)}`, {
        method: "DELETE",
      });
      assert.equal(del.status, 204);
    });

    it("should render HTML index for collections", async function () {
      const res = await authed("/doc/");
      assert.equal(res.status, 200);
      assert.ok((res.headers.get("content-type") || "").includes("text/html"));
      const html = await res.text();
      assert.ok(html.includes("OtterHub WebDAV"));
    });
  });
});
