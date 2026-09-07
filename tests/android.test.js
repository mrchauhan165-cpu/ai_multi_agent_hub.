// Guards the Android status-bar / safe-area setup.
//
// Android 15 (API 35) enforces edge-to-edge: the WebView extends under the
// status and navigation bars, so the topbar was drawn behind the clock. The
// fix has a native half (Capacitor insets the WebView from the system bars)
// and a web half (viewport-fit=cover plus env(safe-area-inset-*) padding for
// browsers and iOS). These assertions pin both halves down so a later edit to
// the theme, the config or the CSS cannot silently reintroduce the overlap.
//   npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** Every `selector { ... }` body for an exact selector, in source order. */
function ruleBodies(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[},])[ \\t\\r\\n]*' + escaped + '[ \\t\\r\\n]*\\{([^}]*)\\}', 'gm');
  return [...css.matchAll(re)].map((m) => m[1]);
}

test('capacitor config lets Capacitor inset the WebView from the system bars', () => {
  const config = JSON.parse(read('capacitor.config.json'));
  // "auto" = apply on API 35+ (where edge-to-edge is enforced) unless the
  // theme opts out. See CapacitorWebView.edgeToEdgeHandler() in
  // node_modules/@capacitor/android.
  assert.equal(config.android?.adjustMarginsForEdgeToEdge, 'auto');
});

test('viewport opts into the unsafe area so env(safe-area-inset-*) is reported', () => {
  const html = read('index.html');
  const meta = html.match(/<meta name="viewport"[^>]*>/);
  assert.ok(meta, 'index.html has a viewport meta tag');
  assert.match(meta[0], /viewport-fit=cover/);
});

test('app chrome pads itself clear of the status and navigation bars', () => {
  const css = read('css', 'app.css');

  for (const edge of ['top', 'right', 'bottom', 'left']) {
    assert.match(css, new RegExp('--safe-' + edge + ': env\\(safe-area-inset-' + edge + ', 0px\\);'), '--safe-' + edge + ' is defined from env()');
  }

  // Base rule and the <=820px override both need the top inset, otherwise the
  // phone layout drops the padding again on exactly the devices with a notch.
  const topbars = ruleBodies(css, '.topbar');
  assert.equal(topbars.length, 2, 'both .topbar rules are checked (base + <=820px)');
  for (const body of topbars) assert.match(body, /var\(--safe-top\)/);

  const sidebar = ruleBodies(css, '.sidebar')[0];
  assert.ok(sidebar, '.sidebar base rule found');
  assert.match(sidebar, /var\(--safe-top\)/);
  assert.match(sidebar, /var\(--safe-bottom\)/);

  const mobileBar = ruleBodies(css, '.mobile-bar')[0];
  assert.ok(mobileBar, '.mobile-bar base rule found');
  assert.match(mobileBar, /var\(--safe-bottom\)/);

  // The sticky summary must clear the (now taller) sticky topbar.
  assert.match(ruleBodies(css, '.editor-summary')[0], /top: calc\(76px \+ var\(--safe-top\)\)/);
});

test('android resource XML has no double hyphen inside a comment', () => {
  // The XML spec forbids "--" inside comments and aapt2 fails the build with
  // "The string \"--\" is not permitted within comments". This runs in the Node
  // suite so it is caught before :app:mergeDebugResources ever gets a chance to.
  const roots = [
    path.join(ROOT, 'android', 'app', 'src', 'main', 'res'),
    path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
  ];
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isFile()) return files.push(p);
    for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
  };
  roots.forEach(walk);

  const offenders = [];
  for (const file of files.filter((f) => f.endsWith('.xml'))) {
    for (const body of fs.readFileSync(file, 'utf8').matchAll(/<!--([\s\S]*?)-->/g)) {
      if (body[1].includes('--')) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.ok(files.length > 10, 'resource files were actually scanned (' + files.length + ')');
  assert.deepEqual(offenders, []);
});

test('android theme keeps the bars legible over the white window background', () => {
  const colors = read('android', 'app', 'src', 'main', 'res', 'values', 'colors.xml');
  assert.match(colors, /<color name="systemBarBackground">#FFFFFF<\/color>/);

  for (const dir of ['values', 'values-v27']) {
    const styles = read('android', 'app', 'src', 'main', 'res', dir, 'styles.xml');
    const theme = styles.match(/<style name="AppTheme\.NoActionBar"[\s\S]*?<\/style>/);
    assert.ok(theme, dir + '/styles.xml defines AppTheme.NoActionBar');
    assert.match(theme[0], /<item name="android:windowBackground">@color\/systemBarBackground<\/item>/);
    assert.match(theme[0], /<item name="android:windowLightStatusBar">true<\/item>/);
  }

  // windowLightNavigationBar needs API 27+, so it may only live in values-v27.
  const v27 = read('android', 'app', 'src', 'main', 'res', 'values-v27', 'styles.xml');
  assert.match(v27, /<item name="android:windowLightNavigationBar">true<\/item>/);
  const base = read('android', 'app', 'src', 'main', 'res', 'values', 'styles.xml');
  assert.doesNotMatch(base, /windowLightNavigationBar/);
});
