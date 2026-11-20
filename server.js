import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const C = {
  port: +process.env.PORT || 3000,
  tmp: path.resolve(process.env.TMP_DIR || './tmp'),
  ttl: (+process.env.FILE_TTL_MIN || 30) * 60000,
  conc: +process.env.MAX_CONCURRENT_JOBS || 2,
  maxMB: +process.env.MAX_FILE_MB || 1500,
  maxDur: (+process.env.MAX_DURATION_MIN || 60) * 60,
};
fs.mkdirSync(C.tmp, { recursive: true });
fs.mkdirSync('data', { recursive: true });
const db = new Database('data/mavix.db');
db.exec(`CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,title TEXT,thumb TEXT,format TEXT,resolution TEXT,
created INTEGER,status TEXT,file TEXT,url TEXT)`);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- helpers ----------
const PLATFORMS = [['YouTube', /(^|\.)(youtube\.com|youtu\.be)$/], ['TikTok', /(^|\.)tiktok\.com$/],
  ['Instagram', /(^|\.)instagram\.com$/], ['Facebook', /(^|\.)(facebook\.com|fb\.watch)$/],
  ['X/Twitter', /(^|\.)(x\.com|twitter\.com)$/], ['Vimeo', /(^|\.)vimeo\.com$/]];
const detect = h => (PLATFORMS.find(([, r]) => r.test(h)) || ['Lainnya'])[0];

function privateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^(fc|fd|fe80)/i.test(ip) || ip.startsWith('::ffff:') && privateIp(ip.slice(7));
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
}
async function validateUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('URL tidak valid'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('Hanya URL http/https yang didukung');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('Domain tidak ditemukan');
  if (addrs.some(a => privateIp(a.address))) throw new Error('Alamat jaringan privat diblokir');
  return u;
}
const stripHashtags = t => (t || '').split('\n').map(l => l.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1').replace(/[ \t]{2,}/g, ' ').trim()).join('\n').trim();

function run(cmd, args, onLine) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args); let out = '', err = '';
    const feed = d => { const s = d.toString(); out += s; onLine && s.split(/[\r\n]+/).forEach(l => l && onLine(l)); };
    p.stdout.on('data', feed); p.stderr.on('data', d => { err += d; onLine && d.toString().split(/[\r\n]+/).forEach(l => l && onLine(l)); });
    p.on('error', e => rej(new Error(`${cmd} tidak terpasang / gagal dijalankan: ${e.message}`)));
    p.on('close', c => c === 0 ? res(out) : rej(new Error(err.split('\n').filter(Boolean).slice(-2).join(' ') || `${cmd} exit ${c}`)));
  });
}

// ---------- job queue ----------
const jobs = new Map(); const queue = []; let active = 0;
function enqueue(job, fn) {
  jobs.set(job.id, job); job.status = 'queued'; job.progress = 0;
  queue.push(async () => {
    job.status = 'running';
    try { await fn(job); job.status = 'done'; job.progress = 100; }
    catch (e) { job.status = 'error'; job.error = e.message; log('job fail', job.id, e.message); }
    db.prepare('UPDATE history SET status=?,file=? WHERE id=?').run(job.status === 'done' ? 'selesai' : 'gagal', job.file || null, job.id);
  });
  pump();
}
function pump() {
  while (active < C.conc && queue.length) { active++; queue.shift()().finally(() => { active--; pump(); }); }
}
const newJob = (extra) => ({ id: crypto.randomUUID(), ...extra });
const fileInfo = f => ({ size: fs.statSync(f).size });

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'"], mediaSrc: ["'self'"] } } }));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true }));
app.use('/api/download', rateLimit({ windowMs: 600000, limit: 20 }));
app.use('/api/tool', rateLimit({ windowMs: 600000, limit: 10 }));
app.use(express.static('public'));

app.get('/api/health', async (_, res) => {
  const chk = c => run(c, ['-version'].slice(c === 'yt-dlp' ? 1 : 0).concat(c === 'yt-dlp' ? ['--version'] : [])).then(() => true, () => false);
  res.json({ ok: true, ytdlp: await chk('yt-dlp'), ffmpeg: await chk('ffmpeg'), active, queued: queue.length });
});

app.post('/api/info', async (req, res) => {
  try {
    const u = await validateUrl(req.body.url);
    const j = JSON.parse(await run('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '15', u.href]));
    if (j.is_live) throw new Error('Live stream tidak didukung');
    if (j.duration > C.maxDur) throw new Error(`Durasi melebihi batas ${C.maxDur / 60} menit`);
    const heights = [...new Set((j.formats || []).filter(f => f.vcodec && f.vcodec !== 'none' && f.height).map(f => f.height))].sort((a, b) => b - a);
    res.json({ platform: detect(u.hostname), url: u.href, title: j.title, creator: j.uploader || j.channel || '-', duration: j.duration || 0,
      thumbnail: j.thumbnail || '', caption: j.description || j.title || '', captionClean: stripHashtags(j.description || j.title || ''),
      heights, maxHeight: heights[0] || null });
  } catch (e) { res.status(400).json({ error: 'Gagal memeriksa tautan: ' + e.message + '. Jika platform membatasi akses (login/DRM), tidak ada yang bisa diunduh secara sah.' }); }
});

app.post('/api/download', async (req, res) => {
  try {
    const u = await validateUrl(req.body.url);
    const type = req.body.type === 'mp3' ? 'mp3' : 'mp4';
    const h = [360, 480, 720, 1080, 1440, 2160].includes(+req.body.height) ? +req.body.height : 1080;
    const br = [128, 192, 256, 320].includes(+req.body.bitrate) ? +req.body.bitrate : 192;
    const job = newJob({ type });
    const out = path.join(C.tmp, job.id + '.' + type);
    db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?,?,?)').run(job.id, String(req.body.title || u.hostname).slice(0, 300), String(req.body.thumb || '').slice(0, 1000),
      type.toUpperCase(), type === 'mp3' ? br + 'kbps' : h + 'p', Date.now(), 'proses', null, u.href);
    enqueue(job, async j => {
      const args = ['--no-playlist', '--no-warnings', '--newline', '--max-filesize', C.maxMB + 'M', '-o', path.join(C.tmp, job.id + '.%(ext)s'), '--ffmpeg-location', '/usr/bin'];
      if (type === 'mp3') args.push('-x', '--audio-format', 'mp3', '--audio-quality', br + 'K');
      else args.push('-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4');
      await run('yt-dlp', [...args, u.href], l => { const m = l.match(/\[download\]\s+([\d.]+)%/); if (m) j.progress = Math.min(95, +m[1] * (type === 'mp3' ? 0.9 : 0.95)); });
      if (!fs.existsSync(out)) throw new Error('File hasil tidak ditemukan');
      j.file = out; j.progress = 99;
    });
    res.json({ id: job.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Video tools: stabilizer, fps interpolation, upscale (operate on a finished download)
app.post('/api/tool', (req, res) => {
  const row = db.prepare('SELECT * FROM history WHERE id=?').get(String(req.body.historyId));
  if (!row || row.status !== 'selesai' || !row.file || !fs.existsSync(row.file) || row.format !== 'MP4') return res.status(400).json({ error: 'Pilih unduhan MP4 yang masih tersedia' });
  const tool = req.body.tool, opt = +req.body.option;
  const ok = { stabilize: [3, 10, 20], fps: [30, 60, 120], upscale: [1440, 2160] };
  if (!ok[tool]?.includes(opt)) return res.status(400).json({ error: 'Opsi tidak valid' });
  const job = newJob({ type: tool }), out = path.join(C.tmp, job.id + '.mp4');
  db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?,?,?,?)').run(job.id, row.title + ` [${tool} ${opt}]`, row.thumb, 'MP4', tool === 'upscale' ? opt + 'p (upscale)' : tool === 'fps' ? opt + ' FPS (interpolasi)' : 'stabil', Date.now(), 'proses', null, row.url);
  enqueue(job, async j => {
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,duration', '-of', 'json', row.file])).streams[0];
    const dur = +probe.duration || 1;
    const prog = l => { const m = l.match(/out_time_us=(\d+)/); if (m) j.progress = Math.min(95, (+m[1] / 1e6) / dur * 100 * (tool === 'stabilize' ? 0.5 : 1) + (tool === 'stabilize' ? j.base || 0 : 0)); };
    const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy', '-movflags', '+faststart'];
    if (tool === 'stabilize') {
      const trf = path.join(C.tmp, job.id + '.trf'); j.base = 0;
      await run('ffmpeg', ['-y', '-i', row.file, '-vf', `vidstabdetect=shakiness=${Math.min(10, opt)}:result=${trf}`, '-f', 'null', '-', '-progress', 'pipe:1'], prog);
      j.base = 50;
      await run('ffmpeg', ['-y', '-i', row.file, '-vf', `vidstabtransform=input=${trf}:smoothing=${opt}:zoom=1,unsharp=5:5:0.8`, ...enc, '-progress', 'pipe:1', out], prog);
      fs.rmSync(trf, { force: true });
    } else {
      const vf = tool === 'fps' ? `minterpolate=fps=${opt}:mi_mode=mci:mc_mode=aobmc:vsbmc=1` : `scale=-2:${opt}:flags=lanczos,unsharp=3:3:0.5`;
      await run('ffmpeg', ['-y', '-i', row.file, '-vf', vf, ...enc, '-progress', 'pipe:1', out], prog);
    }
    j.file = out; j.source = probe.r_frame_rate;
  });
  res.json({ id: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job tidak ditemukan' });
  res.json({ status: j.status, progress: Math.round(j.progress || 0), error: j.error, size: j.file && fs.existsSync(j.file) ? fileInfo(j.file).size : null, sourceFps: j.source });
});
app.get('/api/file/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM history WHERE id=?').get(req.params.id);
  if (!r?.file || !fs.existsSync(r.file)) return res.status(404).json({ error: 'File sudah kedaluwarsa' });
  res.download(r.file, (r.title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80) || 'mavix') + path.extname(r.file));
});
app.get('/api/history', (_, res) => res.json(db.prepare('SELECT id,title,thumb,format,resolution,created,status,(file IS NOT NULL) AS hasFile FROM history ORDER BY created DESC LIMIT 100').all()));
function removeRow(r) { if (r.file) fs.rmSync(r.file, { force: true }); db.prepare('DELETE FROM history WHERE id=?').run(r.id); jobs.delete(r.id); }
app.delete('/api/history/:id', (req, res) => { const r = db.prepare('SELECT * FROM history WHERE id=?').get(req.params.id); if (r) removeRow(r); res.json({ ok: true }); });
app.delete('/api/history', (_, res) => { db.prepare('SELECT * FROM history').all().forEach(removeRow); res.json({ ok: true }); });

// cleanup expired files
setInterval(() => {
  const now = Date.now();
  for (const r of db.prepare("SELECT * FROM history WHERE file IS NOT NULL AND created < ?").all(now - C.ttl)) {
    fs.rmSync(r.file, { force: true }); db.prepare("UPDATE history SET file=NULL,status='kedaluwarsa' WHERE id=?").run(r.id);
  }
  for (const f of fs.readdirSync(C.tmp)) { const p = path.join(C.tmp, f); if (now - fs.statSync(p).mtimeMs > C.ttl * 2) fs.rmSync(p, { force: true }); }
}, 60000);

app.use((e, _req, res, _n) => { log('err', e.message); res.status(500).json({ error: 'Kesalahan server' }); });
app.listen(C.port, () => log(`MAVIX V11 berjalan di :${C.port}`));
