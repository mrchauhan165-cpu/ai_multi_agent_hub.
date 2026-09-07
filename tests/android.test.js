// Guards the Android status-bar (edge-to-edge) setup.
//
// Android 15 (API 35) enforces edge-to-edge for SDK-35 apps: the Capacitor
// WebView starts at y=0 under the transparent status bar, which drew the
// topbar (hamburger, "New bill", "Draft" text) behind the clock. PR #5 tried
// to fix this with Capacitor's android.adjustMarginsForEdgeToEdge + CSS
// env(safe-area-inset-*) padding; the resulting APK (versionCode 1) still
// overlapped. This repo now uses a single mechanism: MainActivity pads the
// content view by the system-bar + display-cutout insets natively and
// consumes them, and the web layer is back to its pre-PR-#5 layout. These
// assertions pin both halves down so neither can silently regress: if the
// Capacitor flag or the safe-area CSS creeps back in alongside MainActivity,
// the insets would be applied twice and the header would sit too low.
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

test('MainActivity insets the WebView from the status bar natively', () => {
  const java = read('android', 'app', 'src', 'main', 'java', 'com', 'jewellerybill', 'generator', 'MainActivity.java');

  assert.match(java, /class MainActivity extends BridgeActivity/);
  for (const imp of [
    'import androidx.core.graphics.Insets;',
    'import androidx.core.view.ViewCompat;',
    'import androidx.core.view.WindowInsetsCompat;',
  ]) {
    assert.ok(java.includes(imp), 'MainActivity imports ' + imp);
  }

  // The listener must be attached to the window's content view, and only
  // after super.onCreate() has inflated the activity layout; attaching
  // earlier would find a null content view.
  const superIdx = java.search(/super\.onCreate\(savedInstanceState\);/);
  const attachIdx = java.search(/ViewCompat\.setOnApplyWindowInsetsListener\(\s*content\b/);
  assert.ok(superIdx !== -1, 'MainActivity calls super.onCreate(savedInstanceState)');
  assert.ok(java.includes('final View content = findViewById(android.R.id.content);'), 'listener target is android.R.id.content');
  assert.ok(attachIdx !== -1, 'a window-insets listener is set on the content view');
  assert.ok(superIdx < attachIdx, 'the listener is attached after super.onCreate()');

  // Status bars plus notch/cutout are the full set of things to avoid.
  assert.match(java, /WindowInsetsCompat\.Type\.systemBars\(\)\s*\|\s*WindowInsetsCompat\.Type\.displayCutout\(\)/);
  assert.match(java, /view\.setPadding\(\s*insets\.left,\s*insets\.top,\s*insets\.right,\s*insets\.bottom\s*\)/);

  // Returning CONSUMED stops the insets reaching the WebView's own handling,
  // which is what would otherwise double the spacing.
  assert.match(java, /return WindowInsetsCompat\.CONSUMED;/);

  // requestApplyInsets makes the dispatch happen even when the window state
  // did not change after the listener was installed.
  assert.match(java, /ViewCompat\.requestApplyInsets\(content\);/);
});

test('app module depends on androidx.core for the insets APIs', () => {
  // MainActivity needs ViewCompat/WindowInsetsCompat. capacitor-android uses
  // androidx.core internally but does not export it to consumers, so without
  // this explicit dependency the class fails to compile in CI.
  const gradle = read('android', 'app', 'build.gradle');
  assert.match(gradle, /implementation\s+"androidx\.core:core:\$androidxCoreVersion"/);

  const vars = read('android', 'variables.gradle');
  assert.match(vars, /androidxCoreVersion\s*=\s*'[^']+'/);
  assert.match(vars, /targetSdkVersion\s*=\s*35/);
});

test('build identifies as versionCode >= 2 so the installed APK is verifiable', () => {
  const gradle = read('android', 'app', 'build.gradle');
  const code = gradle.match(/versionCode\s+(\d+)/);
  assert.ok(code, 'build.gradle declares a versionCode');
  assert.ok(Number(code[1]) >= 2, 'versionCode must be >= 2 (the broken APK from PR #5 was versionCode 1)');
  assert.match(gradle, /versionName\s+"1\.1"/);
});

test('capacitor config does not enable a second inset mechanism', () => {
  // adjustMarginsForEdgeToEdge + the MainActivity listener would inset twice.
  // (It also demonstrably did nothing for this overlap on the device.)
  const raw = read('capacitor.config.json');
  assert.doesNotMatch(raw, /adjustMarginsForEdgeToEdge/);
  const config = JSON.parse(raw);
  assert.equal(config.android?.adjustMarginsForEdgeToEdge, undefined);
  assert.equal(config.android?.allowMixedContent, false, 'allowMixedContent stays off');
});

test('viewport meta is the plain one (no viewport-fit=cover)', () => {
  // Without viewport-fit=cover the browser keeps its own inset handling and
  // env(safe-area-inset-*) resolves to 0, i.e. the web layout is exactly what
  // it was before PR #5. The APK gets its insets from MainActivity instead.
  const html = read('index.html');
  assert.doesNotMatch(html, /viewport-fit/);
  const meta = html.match(/<meta name="viewport" content="([^"]*)">/);
  assert.ok(meta, 'index.html has a viewport meta tag');
  assert.equal(meta[1], 'width=device-width, initial-scale=1.0');
});

test('app.css has no safe-area padding left over from PR #5', () => {
  const css = read('css', 'app.css');

  // The top inset is now applied natively; a CSS one would double it.
  assert.doesNotMatch(css, /safe-area-inset-top/);
  assert.doesNotMatch(css, /--safe-(top|right|bottom|left)\b/);

  // Only the pre-existing bottom inset for in-browser mobile use remains.
  const envs = [...css.matchAll(/env\(safe-area-inset-[a-z]+/g)];
  assert.equal(envs.length, 1, 'exactly one env(safe-area-inset-*) use stays in app.css');
  assert.match(envs[0][0], /safe-area-inset-bottom/);
  const mobileBar = ruleBodies(css, '.mobile-bar')[0];
  assert.ok(mobileBar, '.mobile-bar base rule found');
  assert.match(mobileBar, /padding: 10px 14px calc\(10px \+ env\(safe-area-inset-bottom\)\);/);

  // Header/sidebar paddings are back to their pre-PR-#5 values.
  assert.match(ruleBodies(css, '.topbar')[0], /padding: 14px 24px;/);
  assert.match(ruleBodies(css, '.sidebar')[0], /padding: 20px 16px;/);
});

test('android theme keeps the bar strips white with dark icons', () => {
  // PR #5 additions we keep: the insets from MainActivity expose the window
  // background in the strips the bars used to occupy; these files make that
  // background white and the status-bar icons dark.
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
