const $ = (s) => document.querySelector(s);
const form = $('#fetchForm'), urlInput = $('#urlInput'), fetchBtn = $('#fetchBtn');
const alertBox = $('#alert'), result = $('#result');
const formatBody = $('#formatBody'), hideUnknown = $('#hideUnknown');

let current = null; // last /api/info payload + url
let activeTab = 'video';

function showAlert(msg, good = false) {
  alertBox.hidden = false;
  alertBox.textContent = msg;
  alertBox.classList.toggle('good', good);
}
function hideAlert() { alertBox.hidden = true; }
function setLoading(on) {
  fetchBtn.disabled = on;
  $('.spin').hidden = !on;
  $('.go-label').textContent = on ? 'Fetching…' : 'Fetch';
  if (on) result.hidden = true;
}

function fmtViews(n) {
  if (n == null) return '— views';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B views';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M views';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K views';
  return n + ' views';
}
function fmtDur(sec) {
  if (!sec) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return '';
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
function isApprox(f) { return f.filesize == null && f.filesize_approx != null; }

function dlHref(params) {
  const q = new URLSearchParams({ url: current.url, title: current.info.title, ...params });
  return `/api/download?${q.toString()}`;
}

function qualityLabel(f) {
  if (f.height) return `${f.height}p${f.fps && f.fps > 30 ? f.fps : ''}`;
  if (f.abr) return `${Math.round(f.abr)} kbps`;
  if (f.format_note) return f.format_note;
  return f.resolution || f.ext.toUpperCase();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return showAlert('Paste a YouTube URL first.');
  hideAlert(); setLoading(true);
  try {
    const r = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Failed to fetch info.');
    current = { url, info: j };
    render(j, url);
    saveHistory(j, url);
    showAlert('Video loaded — pick a quality below.', true);
    setTimeout(hideAlert, 2500);
  } catch (err) {
    result.hidden = true;
    showAlert(err.message);
  } finally { setLoading(false); }
});

$('#pasteBtn').onclick = async () => {
  try { urlInput.value = await navigator.clipboard.readText(); urlInput.focus(); }
  catch { showAlert('Clipboard blocked — paste with Ctrl+V.'); }
};
$('#clearBtn').onclick = () => { urlInput.value = ''; urlInput.focus(); };
document.querySelectorAll('[data-example]').forEach(b =>
  b.onclick = () => { urlInput.value = b.dataset.example; form.requestSubmit(); });

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  activeTab = t.dataset.tab;
  if (current) renderTable();
});
hideUnknown.onchange = () => current && renderTable();

function render(info, url) {
  result.hidden = false;
  $('#vThumb').src = info.thumbnail || '';
  $('#thumbDl').href = info.thumbnail || '#';
  $('#vDur').textContent = fmtDur(info.duration);
  $('#vTitle').textContent = info.title;
  $('#vChannel').textContent = info.uploader;
  $('#vViews').textContent = fmtViews(info.view_count);
  $('#vDate').textContent = fmtDate(info.upload_date) || '';
  $('#vLikes').textContent = info.like_count ? Number(info.like_count).toLocaleString() + ' likes' : '';
  $('#vDesc').textContent = info.description || 'No description.';
  $('#vTags').innerHTML = (info.tags || []).slice(0, 8).map(t => `<span>#${t}</span>`).join('');
  $('#copyTitle').onclick = () => navigator.clipboard.writeText(info.title).then(() => showAlert('Title copied.', true));
  $('#copyLink').onclick = () => navigator.clipboard.writeText(info.webpage_url || url).then(() => showAlert('Link copied.', true));
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Quick MP4 ladder (merged with audio)
  const ladder = (info.mp4_ladder || []).slice().sort((a, b) => b.height - a.height).slice(0, 4);
  $('#quickMp4').innerHTML = '';
  if (!ladder.length) $('#quickMp4').innerHTML = '<span class="empty">No MP4 ladder</span>';
  const qBest = document.createElement('a');
  qBest.className = 'qbtn hero-q'; qBest.href = dlHref({ mode: 'best' });
  qBest.innerHTML = `<b>Best</b><small>max quality → mp4</small>`;
  $('#quickMp4').appendChild(qBest);
  ladder.forEach(f => {
    const a = document.createElement('a');
    a.className = 'qbtn';
    a.href = dlHref({ mode: 'mp4', height: f.height });
    a.innerHTML = `<b>${f.height}p</b><small>${f.size_label ? '~' + f.size_label : 'mp4 · audio incl.'}</small>`;
    $('#quickMp4').appendChild(a);
  });

  // Quick MP3
  $('#quickMp3').innerHTML = '';
  [['320', 'best'], ['192', 'balanced'], ['128', 'smallest']].forEach(([q, sub]) => {
    const a = document.createElement('a');
    a.className = 'qbtn';
    a.href = dlHref({ mode: 'mp3', quality: q });
    a.innerHTML = `<b>${q} kbps</b><small>${sub}</small>`;
    $('#quickMp3').appendChild(a);
  });

  $('#countVideo').textContent = (info.mp4_ladder || []).length + (info.video_only || []).length;
  $('#countAudio').textContent = (info.audio_only || []).length;
  $('#countAll').textContent = info.format_count || (info.formats || []).length;

  renderTable();
}

function rowFor(f, kind) {
  const tr = document.createElement('tr');
  const hasSound = f.has_video && f.has_audio;
  const muted = f.has_video && !f.has_audio;
  const sizeTxt = f.size_label || 'unknown';
  const badge = f.has_video
    ? (hasSound ? '<span class="tag loud">Audio</span>' : '<span class="tag">Silent</span>')
    : '<span class="tag loud">Audio</span>';
  let href, label = 'Get ↓';
  if (!f.has_video) { href = dlHref({ mode: 'mp3', quality: '192' }); label = 'MP3 ↓'; }
  else if (f.height) { href = dlHref({ mode: 'mp4', height: f.height }); }
  else { href = dlHref({ format_id: f.format_id }); }

  tr.innerHTML = `
    <td class="c-q"><span class="qual">${qualityLabel(f)}${badge}</span><span class="qsub">${f.format_id} · ${f.ext}</span></td>
    <td class="mono c-c">${f.ext || '—'}</td>
    <td class="mono c-f">${f.fps || '—'}</td>
    <td class="r c-s"><span class="size ${isApprox(f) ? 'approx' : ''}">${f.size_label ? (isApprox(f) ? '~' : '') + f.size_label : '—'}</span></td>
    <td class="c-g"><a class="get" href="${href}">${label}</a></td>
    <td class="mono c-m">${f.ext || '—'} · ${f.fps ? f.fps + ' fps' : '—'} · <b>${f.size_label ? (isApprox(f) ? '~' : '') + f.size_label : '—'}</b></td>`;
  return tr;
}

function renderTable() {
  const info = current.info;
  formatBody.innerHTML = '';
  let list = [];
  if (activeTab === 'video') list = [...(info.mp4_ladder || []), ...(info.video_only || [])];
  else if (activeTab === 'audio') list = info.audio_only || [];
  else list = info.formats || [];

  if (hideUnknown.checked) list = list.filter(f => f.size_bytes != null);

  // de-dupe by format_id
  const seen = new Set();
  list = list.filter(f => !seen.has(f.format_id) && seen.add(f.format_id));

  if (!list.length) {
    formatBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--mut);padding:26px;font-family:var(--mono);font-size:12px;">No rows with known size — uncheck “known size only”.</td></tr>`;
    return;
  }
  // biggest size first within tab for video, best bitrate first for audio
  list.slice(0, 40).forEach(f => formatBody.appendChild(rowFor(f)));
}

// ---------- history ----------
function getHist() { try { return JSON.parse(localStorage.getItem('pt_hist') || localStorage.getItem('tf_hist') || '[]'); } catch { return []; } }
function saveHistory(info, url) {
  const h = getHist().filter(x => x.id !== info.id);
  h.unshift({ id: info.id, title: info.title, thumb: info.thumbnail, uploader: info.uploader, url });
  localStorage.setItem('pt_hist', JSON.stringify(h.slice(0, 12)));
  renderHist();
}
function renderHist() {
  const box = $('#histList'), h = getHist();
  box.innerHTML = h.length ? '' : '<span class="empty">Nothing yet — fetch a video and it will appear here.</span>';
  h.forEach(item => {
    const b = document.createElement('button');
    b.className = 'hist-item';
    b.innerHTML = `<img src="${item.thumb || ''}" alt=""/><div><b>${item.title}</b><small>${item.uploader}</small></div><span class="go">→</span>`;
    b.onclick = () => { urlInput.value = item.url; form.requestSubmit(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    box.appendChild(b);
  });
}
$('#clearHist').onclick = () => { localStorage.removeItem('pt_hist'); localStorage.removeItem('tf_hist'); renderHist(); };

renderHist();
