'use strict';

/* exported
  CHROME_POPUP_BORDER_BUG
  RX_META
  UA
  capitalize
  clamp
  closeCurrentTab
  deepEqual
  download
  getActiveTab
  getOwnTab
  getTab
  ignoreChromeError
  isEmptyObj
  mapObj
  onTabReady
  openURL
  sessionStore
  stringAsRegExp
  tryCatch
  tryRegExp
  tryURL
  waitForTabUrl
*/

let FIREFOX;
const [CHROME, UA] = (() => {
  const uad = navigator.userAgentData;
  const ua = uad || navigator.userAgent;
  const brands = uad ? uad.brands.map(_ => `${_.brand}/${_.version}`).join(' ') : ua;
  const getVer = name => Number(brands.match(new RegExp(name + '\\w*/(\\d+)|$'))[1]) || false;
  FIREFOX = !chrome.app && getVer('Firefox');
  return [
    getVer('Chrom'),
    {
      mobile: uad ? uad.mobile : /Android/.test(ua),
      windows: /Windows/.test(uad ? uad.platform : ua),
      opera: getVer('(Opera|OPR)'),
      vivaldi: getVer('Vivaldi'),
    },
  ];
})();

// see PR #781
const CHROME_POPUP_BORDER_BUG = CHROME >= 62 && CHROME <= 74;

if (FIREFOX && !chrome.browserAction.openPopup) {
  // in FF pre-57 legacy addons can override useragent so we assume the worst
  // until we know for sure in the async getBrowserInfo()
  // (browserAction.openPopup was added in 57)
  FIREFOX = 55; // from strict_min_version
  browser.runtime.getBrowserInfo().then(info => {
    FIREFOX = parseFloat(info.version);
  });
}

const URLS = {
  ownOrigin: chrome.runtime.getURL(''),

  configureCommands:
    UA.opera ? 'opera://settings/configureCommands'
          : 'chrome://extensions/configureCommands',

  installUsercss: chrome.runtime.getURL('install-usercss.html'),

  // CWS cannot be scripted in chromium, see ChromeExtensionsClient::IsScriptableURL
  // https://cs.chromium.org/chromium/src/chrome/common/extensions/chrome_extensions_client.cc
  browserWebStore:
    FIREFOX ? 'https://addons.mozilla.org/' :
    UA.opera ? 'https://addons.opera.com/' :
      'https://chrome.google.com/webstore/',

  emptyTab: [
    // Chrome and simple forks
    'chrome://newtab/',
    // Opera
    'chrome://startpage/',
    // Vivaldi
    'chrome-extension://mpognobbkildjkofajifpdfhcoklimli/components/startpage/startpage.html',
    // Firefox
    'about:home',
    'about:newtab',
  ],

  favicon: host => `https://icons.duckduckgo.com/ip3/${host}.ico`,

  // Chrome 61.0.3161+ doesn't run content scripts on NTP https://crrev.com/2978953002/
  // TODO: remove when "minimum_chrome_version": "61" or higher
  chromeProtectsNTP: CHROME >= 61,

  uso: 'https://userstyles.org/',
  usoJson: 'https://userstyles.org/styles/chrome/',

  usoArchive: 'https://uso.kkx.one/',
  usoArchiveRaw: [
    'https://cdn.jsdelivr.net/gh/33kk/uso-archive@flomaster/data/',
    'https://raw.githubusercontent.com/33kk/uso-archive/flomaster/data/',
  ],

  usw: 'https://userstyles.world/',

  extractUsoArchiveId: url =>
    url &&
    URLS.usoArchiveRaw.some(u => url.startsWith(u)) &&
    Number(url.match(/\/(\d+)\.user\.css|$/)[1]),
  extractUsoArchiveInstallUrl: url => {
    const id = URLS.extractUsoArchiveId(url);
    return id ? `${URLS.usoArchive}style/${id}` : '';
  },
  makeUsoArchiveCodeUrl: id => `${URLS.usoArchiveRaw[0]}usercss/${id}.user.css`,

  extractGreasyForkInstallUrl: url =>
    /^(https:\/\/(?:greasy|sleazy)fork\.org\/scripts\/\d+)[^/]*\/code\/[^/]*\.user\.css$|$/.exec(url)[1],

  extractUSwId: url =>
    url &&
    url.startsWith(URLS.usw) &&
    Number(url.match(/\/(\d+)\.user\.css|$/)[1]),
  extractUSwInstallUrl: url => {
    const id = URLS.extractUSwId(url);
    return id ? `${URLS.usw}style/${id}` : '';
  },
  makeUswCodeUrl: id => `${URLS.usw}api/style/${id}.user.css`,

  supported: url => (
    url.startsWith('http') ||
    url.startsWith('ftp') ||
    url.startsWith('file') ||
    url.startsWith(URLS.ownOrigin) ||
    !URLS.chromeProtectsNTP && url.startsWith('chrome://newtab/')
  ),

  isLocalhost: url => /^file:|^https?:\/\/(localhost|127\.0\.0\.1)\//.test(url),
};

const RX_META = /\/\*!?\s*==userstyle==[\s\S]*?==\/userstyle==\s*\*\//i;

if (FIREFOX || UA.opera || UA.vivaldi) {
  document.documentElement.classList.add(
    FIREFOX && 'firefox' ||
    UA.opera && 'opera' ||
    UA.vivaldi && 'vivaldi');
}

// FF57+ supports openerTabId, but not in Android
// (detecting FF57 by the feature it added, not navigator.ua which may be spoofed in about:config)
const openerTabIdSupported = (!FIREFOX || window.AbortController) && chrome.windows != null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getOwnTab() {
  return browser.tabs.getCurrent();
}

async function getActiveTab() {
  return (await browser.tabs.query({currentWindow: true, active: true}))[0];
}

/**
 * Opens a tab or activates an existing one,
 * reuses the New Tab page or about:blank if it's focused now
 * @param {Object} _
 * @param {string} _.url - if relative, it's auto-expanded to the full extension URL
 * @param {number} [_.index] move the tab to this index in the tab strip, -1 = last
 * @param {number} [_.openerTabId] defaults to the active tab
 * @param {Boolean} [_.active=true] `true` to activate the tab
 * @param {Boolean|null} [_.currentWindow=true] `null` to check all windows
 * @param {chrome.windows.CreateData} [_.newWindow] creates a new window with these params if specified
 * @param {boolean} [_.newTab] `true` to force a new tab instead of switching to an existing tab
 * @returns {Promise<chrome.tabs.Tab>} Promise -> opened/activated tab
 */
async function openURL({
  url,
  index,
  openerTabId,
  active = true,
  currentWindow = true,
  newWindow,
  newTab,
}) {
  if (!url.includes('://')) {
    url = chrome.runtime.getURL(url);
  }
  let tab = !newTab && (await browser.tabs.query({url: url.split('#')[0], currentWindow}))[0];
  if (tab) {
    return activateTab(tab, {
      index,
      openerTabId,
      // when hash is different we can only set `url` if it has # otherwise the tab would reload
      url: url !== (tab.pendingUrl || tab.url) && url.includes('#') ? url : undefined,
    });
  }
  if (newWindow && browser.windows) {
    return (await browser.windows.create(Object.assign({url}, newWindow))).tabs[0];
  }
  tab = await getActiveTab() || {url: ''};
  if (isTabReplaceable(tab, url)) {
    return activateTab(tab, {url, openerTabId});
  }
  const id = openerTabId == null ? tab.id : openerTabId;
  const opener = id != null && !tab.incognito && openerTabIdSupported && {openerTabId: id};
  return browser.tabs.create(Object.assign({url, index, active}, opener));
}

/**
 * Replaces empty tab (NTP or about:blank)
 * except when new URL is chrome:// or chrome-extension:// and the empty tab is in incognito
 */
function isTabReplaceable(tab, newUrl) {
  return tab &&
    URLS.emptyTab.includes(tab.pendingUrl || tab.url) &&
    !(tab.incognito && newUrl.startsWith('chrome'));
}

async function activateTab(tab, {url, index, openerTabId} = {}) {
  const options = {active: true};
  if (url) {
    options.url = url;
  }
  if (openerTabId != null && openerTabIdSupported) {
    options.openerTabId = openerTabId;
  }
  await Promise.all([
    browser.tabs.update(tab.id, options),
    browser.windows && browser.windows.update(tab.windowId, {focused: true}),
    index != null && browser.tabs.move(tab.id, {index}),
  ]);
  return tab;
}

function stringAsRegExp(s, flags, asString) {
  s = s.replace(/[{}()[\]\\.+*?^$|]/g, '\\$&');
  return asString ? s : new RegExp(s, flags);
}

function ignoreChromeError() {
  // eslint-disable-next-line no-unused-expressions
  chrome.runtime.lastError;
}

function isEmptyObj(obj) {
  if (obj) {
    for (const k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * @param {?Object} obj
 * @param {function(val:?, key:string, obj:Object):T} [fn]
 * @param {string[]} [keys]
 * @returns {?Object<string,T>}
 * @template T
 */
function mapObj(obj, fn, keys) {
  if (!obj) return obj;
  const res = {};
  for (const k of keys || Object.keys(obj)) {
    if (!keys || k in obj) {
      res[k] = fn ? fn(obj[k], k, obj) : obj[k];
    }
  }
  return res;
}

/**
 * js engine can't optimize the entire function if it contains try-catch
 * so we should keep it isolated from normal code in a minimal wrapper
 * 2020 update: probably fixed at least in V8
 */
function tryCatch(func, ...args) {
  try {
    return func(...args);
  } catch (e) {}
}

function tryRegExp(regexp, flags) {
  try {
    return new RegExp(regexp, flags);
  } catch (e) {}
}

function tryJSONparse(jsonString) {
  try {
    return JSON.parse(jsonString);
  } catch (e) {}
}

function tryURL(url) {
  try {
    return new URL(url);
  } catch (e) {
    return {
      hash: '',
      host: '',
      hostname: '',
      href: '',
      origin: '',
      password: '',
      pathname: '',
      port: '',
      protocol: '',
      search: '',
      searchParams: new URLSearchParams(),
      username: '',
    };
  }
}

function debounce(fn, delay, ...args) {
  clearTimeout(debounce.timers.get(fn));
  debounce.timers.set(fn, setTimeout(debounce.run, delay, fn, ...args));
}

Object.assign(debounce, {
  timers: new Map(),
  run(fn, ...args) {
    debounce.timers.delete(fn);
    fn(...args);
  },
  unregister(fn) {
    clearTimeout(debounce.timers.get(fn));
    debounce.timers.delete(fn);
  },
});

function deepMerge(src, dst, mergeArrays) {
  if (!src || typeof src !== 'object') {
    return src;
  }
  if (Array.isArray(src)) {
    // using `Array` that belongs to this `window`; not using Array.from as it's slower
    if (!dst || !mergeArrays) dst = Array.prototype.map.call(src, deepCopy);
    else for (const v of src) dst.push(deepMerge(v));
  } else {
    // using an explicit {} that belongs to this `window`
    if (!dst) dst = {};
    for (const [k, v] of Object.entries(src)) {
      dst[k] = deepMerge(v, dst[k]);
    }
  }
  return dst;
}

/** Useful in arr.map(deepCopy) to ignore the extra parameters passed by map() */
function deepCopy(src) {
  return deepMerge(src);
}

function deepEqual(a, b, ignoredKeys) {
  if (!a || !b) return a === b;
  const type = typeof a;
  if (type !== typeof b) return false;
  if (type !== 'object') return a === b;
  if (Array.isArray(a)) {
    return Array.isArray(b) &&
           a.length === b.length &&
           a.every((v, i) => deepEqual(v, b[i], ignoredKeys));
  }
  for (const key in a) {
    if (!Object.hasOwnProperty.call(a, key) ||
        ignoredKeys && ignoredKeys.includes(key)) continue;
    if (!Object.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], ignoredKeys)) return false;
  }
  for (const key in b) {
    if (!Object.hasOwnProperty.call(b, key) ||
        ignoredKeys && ignoredKeys.includes(key)) continue;
    if (!Object.hasOwnProperty.call(a, key)) return false;
  }
  return true;
}

/* A simple polyfill in case DOM storage is disabled in the browser */
const sessionStore = new Proxy({}, {
  get(target, name) {
    try {
      return sessionStorage[name];
    } catch (e) {
      Object.defineProperty(window, 'sessionStorage', {value: target});
    }
  },
  set(target, name, value, proxy) {
    try {
      sessionStorage[name] = `${value}`;
    } catch (e) {
      proxy[name]; // eslint-disable-line no-unused-expressions
      target[name] = `${value}`;
    }
    return true;
  },
  deleteProperty(target, name) {
    return delete target[name];
  },
});

/**
 * @param {String} url
 * @param {Object} params
 * @param {String} [params.method]
 * @param {String|Object} [params.body]
 * @param {'arraybuffer'|'blob'|'document'|'json'|'text'} [params.responseType]
 * @param {Number} [params.requiredStatusCode] resolved when matches, otherwise rejected
 * @param {Number} [params.timeout] ms
 * @param {Object} [params.headers] {name: value}
 * @param {string[]} [params.responseHeaders]
 * @returns {Promise}
 */
function download(url, {
  method = 'GET',
  body,
  responseType = 'text',
  requiredStatusCode = 200,
  timeout = 60e3, // connection timeout, USO is that bad
  loadTimeout = 2 * 60e3, // data transfer timeout (counted from the first remote response)
  headers,
  responseHeaders,
} = {}) {
  /* USO can't handle POST requests for style json and XHR/fetch can't handle super long URL
   * so we need to collapse all long variables and expand them in the response */
  const queryPos = url.startsWith(URLS.uso) ? url.indexOf('?') : -1;
  if (queryPos >= 0) {
    if (body === undefined) {
      method = 'POST';
      body = url.slice(queryPos);
      url = url.slice(0, queryPos);
    }
    if (headers === undefined) {
      headers = {
        'Content-type': 'application/x-www-form-urlencoded',
      };
    }
  }
  const usoVars = [];
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const u = new URL(collapseUsoVars(url), location);
    const onTimeout = () => {
      xhr.abort();
      reject(new Error('Timeout fetching ' + u.href));
    };
    let timer = setTimeout(onTimeout, timeout);
    xhr.onreadystatechange = () => {
      if (xhr.readyState >= XMLHttpRequest.HEADERS_RECEIVED) {
        xhr.onreadystatechange = null;
        clearTimeout(timer);
        timer = loadTimeout && setTimeout(onTimeout, loadTimeout);
      }
    };
    xhr.onload = () => {
      if (xhr.status === requiredStatusCode || !requiredStatusCode || u.protocol === 'file:') {
        const response = expandUsoVars(xhr.response);
        if (responseHeaders) {
          const headers = {};
          for (const h of responseHeaders) headers[h] = xhr.getResponseHeader(h);
          resolve({headers, response});
        } else {
          resolve(response);
        }
      } else {
        reject(xhr.status);
      }
    };
    xhr.onerror = () => reject(xhr.status);
    xhr.onloadend = () => clearTimeout(timer);
    xhr.responseType = responseType;
    xhr.open(method, u.href);
    for (const [name, value] of Object.entries(headers || {})) {
      xhr.setRequestHeader(name, value);
    }
    xhr.send(body);
  });

  function collapseUsoVars(url) {
    if (queryPos < 0 ||
        url.length < 2000 ||
        !url.startsWith(URLS.usoJson) ||
        !/^get$/i.test(method)) {
      return url;
    }
    const params = new URLSearchParams(url.slice(queryPos + 1));
    for (const [k, v] of params.entries()) {
      if (v.length < 10 || v.startsWith('ik-')) continue;
      usoVars.push(v);
      params.set(k, `\x01${usoVars.length}\x02`);
    }
    return url.slice(0, queryPos + 1) + params.toString();
  }

  function expandUsoVars(response) {
    if (!usoVars.length || !response) return response;
    const isText = typeof response === 'string';
    const json = isText && tryJSONparse(response) || response;
    json.updateUrl = url;
    for (const section of json.sections || []) {
      const {code} = section;
      if (code.includes('\x01')) {
        section.code = code.replace(/\x01(\d+)\x02/g, (_, num) => usoVars[num - 1] || '');
      }
    }
    return isText ? JSON.stringify(json) : json;
  }
}

async function closeCurrentTab() {
  // https://bugzil.la/1409375
  const tab = await getOwnTab();
  if (tab) chrome.tabs.remove(tab.id);
}

function waitForTabUrl(tab) {
  return new Promise(resolve => {
    browser.tabs.onUpdated.addListener(...[
      function onUpdated(tabId, info, updatedTab) {
        if (info.url && tabId === tab.id) {
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve(updatedTab);
        }
      },
      ...'UpdateFilter' in browser.tabs ? [{tabId: tab.id}] : [], // FF only
    ]);
  });
}

function capitalize(s) {
  return s[0].toUpperCase() + s.slice(1);
}
