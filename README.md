# MAVIX V11 — by McTanz08
Downloader video dark premium dengan backend Node.js (Express) + yt-dlp + FFmpeg + SQLite.

## Syarat
Node 20+, `yt-dlp`, `ffmpeg` (dengan libvidstab untuk Stabilizer; build Debian/Ubuntu sudah termasuk).

## Jalankan lokal
    npm install
    cp .env.example .env   # opsional; export variabelnya atau set di hosting
    npm start              # http://localhost:3000
Cek `GET /api/health` — harus menampilkan `ytdlp:true, ffmpeg:true`.

## Deploy jadi link (disarankan Docker)
Dockerfile sudah memasang ffmpeg + yt-dlp. Upload folder ini ke Railway / Render / Fly.io / VPS (pilih "Dockerfile"), set env dari `.env.example`, dan HTTPS otomatis dari hosting. Hosting statis (GitHub Pages, Netlify tanpa functions) TIDAK bisa — backend wajib berjalan.
Pakai disk/volume untuk `data/` jika ingin riwayat awet. Update yt-dlp berkala: `pip install -U yt-dlp`.

## Fitur
Satu input universal, deteksi platform, metadata, kualitas yang benar-benar tersedia, MP4 / MP3 (128–320 kbps), caption tanpa hashtag, antrean job + progres, riwayat (SQLite), Stabilizer (vidstab 2-pass), FPS Enhancer (minterpolate, bukan ubah metadata), Upscale terpisah (lanczos, bukan resolusi asli), rate limit, proteksi SSRF, batas ukuran/durasi, file dihapus otomatis (TTL).

## Batasan jujur
- "No WM" = hanya versi tanpa watermark yang disediakan sumber; tidak ada penghapus watermark.
- Konten privat, login, atau DRM tidak diunduh. Gunakan hanya untuk konten yang kamu berhak unduh.
- Beberapa platform (Instagram/Facebook/TikTok) kerap memblokir IP server; cookie/proxy harus kamu atur sendiri dan sesuai ToS.
- FPS 120 & Stabilizer berat di CPU; naikkan resource server atau turunkan `MAX_CONCURRENT_JOBS`.

## Troubleshooting
`yt-dlp tidak terpasang` → pasang & pastikan ada di PATH. `vidstab` error → ffmpeg tanpa libvidstab. Unduhan gagal 403 → update yt-dlp / platform memblokir IP.
