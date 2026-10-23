// Image API Explorer: a plain consumer of the public GET /process endpoint.

const $ = (sel) => document.querySelector(sel);
const form = $('#form');
const els = {
  url: form.elements.url,
  width: form.elements.width,
  height: form.elements.height,
  format: form.elements.format,
  crop: form.elements.crop,
  useQuality: form.elements.useQuality,
  quality: form.elements.quality,
  qualityOut: $('#qualityOut'),
  submit: $('#submitBtn'),
  hint: $('#hint'),
  requestUrl: $('#requestUrl'),
  copyUrl: $('#copyUrl'),
  copyCurl: $('#copyCurl'),
  error: $('#error'),
  source: $('#sourcePanel'),
  output: $('#outputPanel'),
};

const LOSSY = new Set(['jpeg', 'webp', 'avif']);
const PARAMS = ['url', 'width', 'height', 'format', 'crop', 'quality'];
let inflight = null;
let outputObjectUrl = null;

// ---------- width/height autofill ----------
// When a usable image URL is entered, prefill width/height with the source's
// natural size as a starting point. Read client-side from the image itself, so
// it costs no API call. Fields the user has typed into are never overwritten.

let autofilled = { width: '', height: '' };
let probeSeq = 0;
let probeTimer = null;

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function canAutofill(field) {
  return els[field].value === '' || els[field].value === autofilled[field];
}

/** Resolves once the probe is done (filled, failed, or superseded); never rejects. */
function probeSourceSize(url) {
  const seq = ++probeSeq;
  if (!isHttpUrl(url)) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      resolve();
      if (seq !== probeSeq || !img.naturalWidth) return; // a newer URL won the race
      for (const [field, size] of [['width', img.naturalWidth], ['height', img.naturalHeight]]) {
        if (!canAutofill(field)) continue;
        els[field].value = autofilled[field] = String(size);
      }
      els.hint.textContent = `Width and height prefilled from the source (${img.naturalWidth} × ${img.naturalHeight}).`;
      syncControls(false);
    };
    // On error, leave the fields alone; the API will report what's wrong on submit.
    img.onerror = () => resolve();
    img.src = url;
  });
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => probeSourceSize(els.url.value.trim()), 400);
}

// ---------- request building ----------

function currentParams() {
  const p = new URLSearchParams();
  const url = els.url.value.trim();
  if (url) p.set('url', url);
  if (els.width.value) p.set('width', els.width.value);
  if (els.height.value) p.set('height', els.height.value);
  if (els.format.value) p.set('format', els.format.value);
  if (els.crop.value && !els.crop.disabled) p.set('crop', els.crop.value);
  if (els.useQuality.checked) p.set('quality', els.quality.value);
  return p;
}

function requestUrl() {
  const p = currentParams();
  return p.has('url') ? `${location.origin}/process?${p}` : null;
}

function syncControls(clearHint = true) {
  const hasDims = Boolean(els.width.value || els.height.value);
  els.crop.disabled = !hasDims;
  els.crop.title = hasDims ? '' : 'Set a width and/or height to choose a crop mode';

  els.quality.disabled = !els.useQuality.checked;
  els.qualityOut.textContent = els.useQuality.checked ? els.quality.value : 'default';
  const fmt = els.format.value;
  if (els.useQuality.checked && fmt && !LOSSY.has(fmt)) els.hint.textContent = `Quality is ignored for ${fmt.toUpperCase()} output.`;
  else if (clearHint) els.hint.textContent = '';

  const url = requestUrl();
  els.requestUrl.textContent = url ?? 'Enter an image URL to build a request';
  els.copyUrl.disabled = els.copyCurl.disabled = !url;
  els.submit.disabled = !url;

  // Keep the page URL shareable: the explorer state round-trips through the query string.
  const pageParams = currentParams();
  history.replaceState(null, '', pageParams.toString() ? `?${pageParams}` : location.pathname);
}

function restoreFromPageUrl() {
  const q = new URLSearchParams(location.search);
  for (const name of PARAMS) {
    if (!q.has(name)) continue;
    if (name === 'quality') {
      els.useQuality.checked = true;
      els.quality.value = q.get('quality');
    } else {
      els[name].value = q.get(name);
    }
  }
  return q.has('url');
}

// ---------- rendering ----------

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setFrame(panel, content) {
  const frame = panel.querySelector('.frame');
  frame.replaceChildren(content);
}

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function spinner() {
  const s = document.createElement('div');
  s.className = 'spinner';
  s.setAttribute('role', 'status');
  s.setAttribute('aria-label', 'Loading');
  return s;
}

function setMeta(panel, rows) {
  const dl = panel.querySelector('.meta');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    if (v instanceof Node) dd.append(v);
    else dd.textContent = v;
    dl.append(dt, dd);
  }
}

function showError(status, body, fallbackMessage) {
  const err = body?.error;
  const box = els.error;
  box.replaceChildren();

  const h = document.createElement('h2');
  h.textContent = err ? `${status} · ${err.code}` : `Request failed${status ? ` (${status})` : ''}`;
  const p = document.createElement('p');
  p.textContent = err?.message ?? fallbackMessage;
  box.append(h, p);

  const detailsAddInfo = Array.isArray(err?.details) && (err.details.length > 1 || err.details[0]?.message !== err.message);
  if (detailsAddInfo) {
    const ul = document.createElement('ul');
    for (const d of err.details) {
      const li = document.createElement('li');
      li.textContent = d.param ? `${d.param}: ${d.message}` : d.message ?? JSON.stringify(d);
      ul.append(li);
    }
    box.append(ul);
  } else if (err?.details && typeof err.details === 'object') {
    const pre = document.createElement('small');
    pre.textContent = JSON.stringify(err.details);
    box.append(pre);
  }
  if (body?.requestId) {
    const s = document.createElement('small');
    s.textContent = `Request ID: ${body.requestId}`;
    box.append(s);
  }
  box.hidden = false;
}

function clearError() {
  els.error.hidden = true;
  els.error.replaceChildren();
}

function badge(text) {
  const b = document.createElement('span');
  b.className = 'badge';
  b.textContent = text;
  return b;
}

// ---------- the actual API call ----------

async function run() {
  const url = requestUrl();
  if (!url) return;

  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;

  clearError();
  els.submit.disabled = true;
  els.submit.textContent = 'Processing…';
  setFrame(els.output, spinner());
  setMeta(els.output, []);

  // The original is shown straight from its source; its metadata comes from the API's X-Source-* headers.
  const sourceImg = new Image();
  sourceImg.alt = 'Original image';
  sourceImg.referrerPolicy = 'no-referrer';
  sourceImg.onerror = () => setFrame(els.source, emptyNote('Your browser could not display the source directly.'));
  sourceImg.src = els.url.value.trim();
  setFrame(els.source, sourceImg);
  setMeta(els.source, []);

  const started = performance.now();
  try {
    // no-cache: reuse the browser's copy only after revalidating (ETag → 304), so every run is a
    // real round trip to the API: honest timings, and it shows up in the CDN's access logs.
    const res = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
    const elapsed = Math.round(performance.now() - started);

    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      showError(res.status, body, res.statusText || 'The API returned an error.');
      setFrame(els.output, emptyNote('No output. See the error above.'));
      return;
    }

    const blob = await res.blob();
    if (outputObjectUrl) URL.revokeObjectURL(outputObjectUrl);
    outputObjectUrl = URL.createObjectURL(blob);

    const h = (name) => res.headers.get(name);
    const sourceBytes = Number(h('x-source-bytes'));

    setMeta(els.source, [
      ['Format', (h('x-source-format') ?? '—').toUpperCase()],
      ['Dimensions', `${h('x-source-width')} × ${h('x-source-height')}`],
      ['Size', formatBytes(sourceBytes)],
    ]);

    const outImg = new Image();
    outImg.alt = 'Processed image';
    outImg.src = outputObjectUrl;
    setFrame(els.output, outImg);

    const delta = sourceBytes ? Math.round((1 - blob.size / sourceBytes) * 100) : null;
    setMeta(els.output, [
      ['Format', (blob.type.replace('image/', '') || '—').toUpperCase()],
      ['Dimensions', `${h('x-output-width')} × ${h('x-output-height')}`],
      ['Size', delta === null ? formatBytes(blob.size) : `${formatBytes(blob.size)} (${delta >= 0 ? `${delta}% smaller` : `${-delta}% larger`})`],
      ['Cache', badge(h('x-cache') ?? 'n/a')],
      ['Time', `${elapsed} ms`],
      ['Request ID', h('x-request-id') ?? '—'],
    ]);
  } catch (err) {
    if (err.name === 'AbortError') return;
    showError(0, null, `Could not reach the API: ${err.message}`);
    setFrame(els.output, emptyNote('No output.'));
  } finally {
    if (inflight === controller) {
      inflight = null;
      els.submit.textContent = 'Process image';
      els.submit.disabled = !requestUrl();
    }
  }
}

// ---------- clipboard ----------

async function copy(button, text) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied!';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = label; }, 1200);
}

const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

// ---------- wiring ----------

form.addEventListener('input', (e) => {
  syncControls();
  if (e.target === els.url) scheduleProbe();
});
form.addEventListener('change', () => syncControls());
form.addEventListener('submit', (e) => { e.preventDefault(); run(); });

$('.samples').addEventListener('click', async (e) => {
  const sample = e.target.closest('button[data-sample]')?.dataset.sample;
  if (!sample) return;
  els.url.value = sample;
  syncControls();
  await probeSourceSize(sample); // so the request shown matches the one that runs
  run();
});

$('#resetBtn').addEventListener('click', () => {
  inflight?.abort();
  form.reset();
  autofilled = { width: '', height: '' };
  probeSeq++;
  clearError();
  setFrame(els.source, emptyNote('Pick a sample or paste an image URL.'));
  setFrame(els.output, emptyNote('The result shows up here.'));
  setMeta(els.source, []);
  setMeta(els.output, []);
  syncControls();
});

els.copyUrl.addEventListener('click', () => copy(els.copyUrl, requestUrl()));
els.copyCurl.addEventListener('click', () => {
  const fmt = els.format.value || 'img';
  copy(els.copyCurl, `curl -sS -o out.${fmt === 'jpeg' ? 'jpg' : fmt} -D - ${shellQuote(requestUrl())}`);
});

const restored = restoreFromPageUrl();
syncControls();
// A shared link is run exactly as given: no autofill, so the request matches the link.
if (restored) run();
