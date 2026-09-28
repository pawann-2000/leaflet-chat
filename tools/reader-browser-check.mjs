import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = await mkdtemp(join(tmpdir(), "leaflet-reader-"));
const connections = [];
const checks = [];
let chrome;

async function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const entry of (await readdir(cache).catch(() => [])).sort()) {
    if (entry.startsWith("chromium_headless_shell-")) {
      candidates.push(
        join(
          cache,
          entry,
          "chrome-headless-shell-linux64/chrome-headless-shell"
        )
      );
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try the next installed browser. */
    }
  }
  throw new Error("Set CHROMIUM_PATH to an installed Chromium executable.");
}

class CDP {
  pending = new Map();
  listeners = new Map();
  counter = 0;
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params);
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      message.error
        ? pending.reject(new Error(JSON.stringify(message.error)))
        : pending.resolve(message.result);
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CDP(socket);
  }
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, callback) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(callback);
    this.listeners.set(method, listeners);
  }
  async eval(expression) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text
      );
    }
    return result.result.value;
  }
  close() {
    this.socket.close();
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(60);
  }
  throw new Error(message);
}

const server = await createServer({
  root,
  mode: "web",
  logLevel: "error",
  server: { host: "127.0.0.1", port: 1431, strictPort: true },
});
try {
  await server.listen();
  chrome = spawn(
    await chromiumPath(),
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  let debug;
  await until(async () => {
    debug = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(
      () => ""
    );
    return !!debug;
  }, "Chromium did not start.");
  const [port, browserPath] = debug.trim().split("\n");
  const browser = await CDP.connect(`ws://127.0.0.1:${port}${browserPath}`);
  connections.push(browser);

  async function page() {
    const { browserContextId } = await browser.call(
      "Target.createBrowserContext"
    );
    const { targetId } = await browser.call("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    let target;
    await until(async () => {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
        (response) => response.json()
      );
      target = targets.find((item) => item.id === targetId);
      return !!target?.webSocketDebuggerUrl;
    }, "Browser page did not start.");
    const connection = await CDP.connect(target.webSocketDebuggerUrl);
    connections.push(connection);
    await connection.call("Page.enable");
    await connection.call("Runtime.enable");
    connection.on("Runtime.exceptionThrown", (event) => {
      checks.push({
        check: "unhandled exception",
        error:
          event.exceptionDetails.exception?.description ??
          event.exceptionDetails.text,
        result: "fail",
      });
    });
    await connection.call("Page.addScriptToEvaluateOnNewDocument", {
      source:
        "window.readerErrors = []; window.addEventListener('error', event => window.readerErrors.push(event.message)); window.addEventListener('unhandledrejection', event => window.readerErrors.push(String(event.reason)));",
    });
    await connection.call("Page.navigate", { url: "http://127.0.0.1:1431/" });
    await until(
      () => connection.eval('!!document.querySelector(".book-stage")'),
      "The library stage did not load."
    );
    return connection;
  }

  const first = await page();
  await first.eval(`(async () => {
    const { buildEpub } = await import('/src/lib/epub/test-fixtures.ts');
    const pixel = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,120,156,99,248,207,192,240,31,0,5,0,1,255,137,153,61,29,0,0,0,0,73,69,78,68,174,66,96,130]);
    const opf = '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">browser-fixture</dc:identifier><dc:title>Page Turn Garden</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="first" href="text/first.xhtml" media-type="application/xhtml+xml"/><item id="second" href="text/second.xhtml" media-type="application/xhtml+xml"/><item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/><item id="image" href="images/pixel.png" media-type="image/png"/></manifest><spine><itemref idref="first"/><itemref idref="second"/></spine></package>';
    const nav = '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/first.xhtml">A beginning</a></li><li><a href="text/second.xhtml#next">Another leaf</a></li><li><a href="text/notes.xhtml">A hidden note</a></li></ol></nav></body></html>';
    const firstText = '<html xmlns="http://www.w3.org/1999/xhtml"><body><p id="beginning">The garden starts here. A reader can keep this sentence.</p><img src="../images/pixel.png" alt="A pixel"/>' + Array.from({length: 40}, (_, i) => '<p>Page turn ' + i + ' has words to make the chapter long enough to flip.</p>').join('') + '</body></html>';
    const secondText = '<html xmlns="http://www.w3.org/1999/xhtml"><body><h2 id="next">A second section</h2><p>Another leaf turns.</p></body></html>';
    const bytes = buildEpub({ 'EPUB/content.opf': opf, 'EPUB/nav.xhtml': nav, 'EPUB/text/first.xhtml': firstText, 'EPUB/text/second.xhtml': secondText, 'EPUB/text/notes.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>A secret garden appendix lives here.</p></body></html>', 'EPUB/images/pixel.png': pixel });
    const transfer = new DataTransfer(); transfer.items.add(new File([bytes], 'page-turn-garden.epub', { type: 'application/epub+zip' }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
  })()`);
  await until(
    () =>
      first.eval(
        '!!document.querySelector(".curl-book--reading .chapter-page__copy")?.textContent.includes("The garden starts here")'
      ),
    "The imported EPUB did not render.",
    30_000
  );
  const source = await first.eval(`(() => ({
    text: [...document.querySelectorAll('.curl-book--reading .chapter-page__copy')].map(node => node.textContent).join(''),
    headings: document.querySelectorAll('.curl-book--reading h1').length,
    image: [...document.querySelectorAll('.curl-book--reading img')].some(image => image.complete && image.naturalWidth > 0),
    notes: !!document.querySelector('[aria-label="Open notes and bookmarks"]')
  }))()`);
  assert.ok(
    source.text.startsWith("The garden starts here."),
    "Reader changed the source opening."
  );
  assert.equal(source.headings, 0, "Reader injected a chapter heading.");
  assert.equal(source.image, true, "The EPUB image did not decode.");
  assert.equal(source.notes, true, "Notes are not reachable in the reader.");
  checks.push({
    check: "source text, no synthetic heading, real EPUB image",
    result: "pass",
  });

  await first.call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(300);
  const mobile = await first.eval(`(() => {
    const frame = document.querySelector('.curl-book--reading').getBoundingClientRect();
    const controls = [...document.querySelectorAll('.chapter-book-stage .book-controls button')].map(button => button.getBoundingClientRect());
    return { width: innerWidth, scroll: document.documentElement.scrollWidth, frame: { left: frame.left, right: frame.right, bottom: frame.bottom }, height: innerHeight, controls: controls.map(r => ({ left: r.left, right: r.right, bottom: r.bottom })) };
  })()`);
  assert.ok(mobile.scroll <= mobile.width + 1, JSON.stringify(mobile));
  assert.ok(
    mobile.frame.left >= 0 &&
      mobile.frame.right <= mobile.width + 1 &&
      mobile.frame.bottom <= mobile.height + 1,
    JSON.stringify(mobile)
  );
  assert.ok(
    mobile.controls.every(
      (r) =>
        r.left >= 0 &&
        r.right <= mobile.width + 1 &&
        r.bottom <= mobile.height + 1
    ),
    JSON.stringify(mobile)
  );
  const before = await first.eval(
    'document.querySelector(".book-controls span")?.textContent'
  );
  await first.eval(
    'document.querySelector("[aria-label=\\"Next page\\"]").click()'
  );
  await until(
    () =>
      first.eval(
        `document.querySelector('.book-controls span')?.textContent !== ${JSON.stringify(before)}`
      ),
    "The page-turn control did not advance."
  );
  checks.push({ check: "phone layout and page turn", result: "pass" });
  const screenshot = await first.call("Page.captureScreenshot", {
    format: "png",
  });
  const screenshotPath = join(tmpdir(), "leaflet-reader-phone.png");
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

  await first.eval(`(() => {
    const paragraph = [...document.querySelectorAll('.curl-book--reading p')].find(p => p.textContent.includes('Page turn'));
    const node = paragraph?.firstChild; if (!node) throw new Error('No paragraph to select');
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(12, node.length));
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    document.querySelector('[aria-label="Open notes and bookmarks"]').click();
  })()`);
  await until(
    () =>
      first.eval(
        'document.querySelector("[aria-label=\\"Highlight\\"]") !== null'
      ),
    "Notes drawer did not open."
  );
  await until(
    () =>
      first.eval(
        '!document.querySelector("[aria-label=\\"Highlight\\"]")?.disabled'
      ),
    "Reading session did not become editable."
  );
  await first.eval(
    'document.querySelector("[aria-label=\\"Highlight\\"]").click()'
  );
  await until(
    () =>
      first.eval(
        'document.querySelector("[id=\\"saved-notes-heading\\"]")?.textContent.includes("1")'
      ),
    "Highlight was not saved."
  );
  checks.push({
    check: "UI selection to persistent Yjs highlight",
    result: "pass",
  });
  await first.call("Page.reload", { ignoreCache: true });
  await until(
    () =>
      first.eval(
        `!![...document.querySelectorAll('ul[aria-label="Library"] button')].find(button => button.textContent.includes('Page Turn Garden'))`
      ),
    "The saved book did not return to the shelf."
  );
  await first.eval(
    `([...document.querySelectorAll('ul[aria-label="Library"] button')].find(button => button.textContent.includes('Page Turn Garden'))).click()`
  );
  await until(
    () =>
      first.eval(
        '!!document.querySelector(".curl-book--reading .chapter-page__copy")?.textContent.includes("The garden starts here")'
      ),
    "The saved book did not reopen.",
    30_000
  );
  await first.eval(
    'document.querySelector("[aria-label=\\"Open notes and bookmarks\\"]").click()'
  );
  await until(
    () =>
      first.eval(
        'document.querySelector("[id=\\"saved-notes-heading\\"]")?.textContent.includes("1")'
      ),
    "The highlight did not survive reopening."
  );
  checks.push({
    check: "Yjs note survives reload and library reopen",
    result: "pass",
  });
  await first.eval(
    'document.querySelector("[aria-label=\\"Close notes\\"]").click()'
  );
  await first.call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    () =>
      first.eval(
        `!![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'A hidden note')`
      ),
    "The publisher table of contents was not available."
  );
  await first.eval(
    `([...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'A hidden note')).click()`
  );
  await until(
    () =>
      first.eval(
        'document.querySelector(".curl-book--reading .chapter-page__copy")?.textContent.includes("A secret garden appendix")'
      ),
    "The supplementary TOC section did not open."
  );
  checks.push({
    check: "publisher TOC opens an off-spine section",
    result: "pass",
  });
  assert.deepEqual(
    await first.eval("window.readerErrors"),
    [],
    "Browser reported runtime errors."
  );
  assert.equal(
    checks.some((item) => item.result === "fail"),
    false,
    "Browser reported an unhandled exception."
  );
  console.log(
    JSON.stringify({ status: "pass", checks, screenshotPath }, null, 2)
  );
} finally {
  for (const connection of connections) {
    connection.close();
  }
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await exited;
  }
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
