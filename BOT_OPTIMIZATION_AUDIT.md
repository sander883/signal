# Bot Optimization Audit (XAUUSD Signal Bot)

Tanggal audit: 2026-04-10

Dokumen ini merangkum area yang **wajib ditambah** dan yang bisa **dimaksimalkan** supaya bot lebih aman, stabil, dan profitable secara operasional.

## Ringkasan Prioritas

### P0 (kritikal, kerjakan dulu)
1. **Tambah startup config validation** agar bot fail-fast saat env penting kosong/salah.
2. **Perketat fallback AI** (jangan auto-pass ketika AI error/rate limit di jam high impact).
3. **Perbaiki handling API rate-limit/error schema** khususnya provider data market.
4. **Tambah test coverage untuk pipeline utama** (bukan cuma risk + session).

### P1 (tinggi)
1. **Tambahkan persistence state** (duplicate cooldown, metrics, paper positions) supaya restart tidak “lupa state”.
2. **Tambah quality gate untuk signal** (minimal RR real, spread-aware threshold, volatility regime guard).
3. **Hardening news filter** (freshness checks + source health + event sorting).

### P2 (menengah)
1. **Observability lebih lengkap**: health endpoint + error budget + alerting.
2. **Backtest realism**: slippage, spread dinamis, latency, cost model.
3. **Strategi adaptive weighting** berdasarkan performa rolling 7/30 hari.

---

## Temuan Detail dan Saran Eksekusi

## 1) Konfigurasi & Safety Guard

### Temuan
- Saat ini tidak ada validator sentral yang memastikan credential/konfigurasi wajib benar sebelum bot jalan.
- Banyak field `parseInt(...) || default` / `parseFloat(...) || default`; nilai invalid bisa diam-diam fallback tanpa warning.

### Dampak
- Bot terlihat “jalan”, padahal sebenarnya pakai nilai default yang mungkin tidak sesuai risk profile.

### Rekomendasi
- Buat `validateConfig()` di startup:
  - Wajib: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, minimal satu API key data provider.
  - Range check: `RISK_PERCENT` (misal 0.1–3), `REWARD_RATIO` (>=1.2), `AI_MIN_CONFIDENCE` (0–100).
  - Enum check: timeframe dan provider valid.
- Fail-fast dengan error jelas + contoh perbaikan env.

---

## 2) AI Gate & Decision Risk

### Temuan
- AI sudah punya smart gate + dedupe + rate limit (bagus).
- Namun ketika AI unavailable/error/rate-limited, flow bypass berpotensi tetap mengizinkan signal tergantung `fallbackAllow`.

### Dampak
- Pada periode market berisiko (news window atau volatility tinggi), fallback terlalu longgar bisa menambah false-positive.

### Rekomendasi
- Buat mode fallback bertingkat:
  - **Strict mode**: jika AI fail pada confidence 50–65, auto-reject.
  - **Normal mode**: 66–84 boleh pass dengan penalti confidence.
- Log reason terstruktur (`ai_decision_source`: `model|bypass|rate_limited`).
- Simpan metrik `ai_bypass_rate` dan kasih alert jika >20% per hari.

---

## 3) Market Data Reliability

### Temuan
- Sudah ada cache + circuit breaker provider (bagus).
- Belum ada parsing spesifik untuk response limit/error khas provider (mis. payload “Note”/“Information”).
- Saat fallback ke cached stale data, belum ada batas maksimal umur data.

### Dampak
- Sinyal bisa dibuat dari data terlalu lama tanpa disadari.

### Rekomendasi
- Tambahkan `maxStaleMs` per timeframe (mis. 3x interval candle).
- Jika stale melebihi batas: blok signal + kirim alert Telegram “data stale”.
- Tangani schema error provider secara eksplisit dan naikan counter `dataFallbacks`.

---

## 4) News Filter Hardening

### Temuan
- News filter mandatory sudah tepat.
- Belum ada scoring freshness source (berapa lama sejak fetch terakhir sukses).
- Fallback “known schedule” membantu, tapi akurasi tanggal event tertentu bisa meleset.

### Dampak
- Potensi under-block/over-block ketika sumber utama bermasalah.

### Rekomendasi
- Tambahkan `newsFreshnessStatus`:
  - `fresh` (<30m), `degraded` (30–120m), `stale` (>120m).
- Saat `stale`, otomatis naikkan buffer sebelum/sesudah news.
- Simpan event setelah sort ascending + normalisasi timezone ke UTC tegas.

---

## 5) Signal Quality Controls

### Temuan
- Pipeline sudah bagus (session -> news -> strategy -> alignment -> DXY -> risk -> AI).
- Belum ada guard berbasis spread/volatility regime yang adaptif untuk menahan entry berkualitas rendah.

### Dampak
- Trade bisa tetap lolos saat kondisi “choppy + spread mahal”.

### Rekomendasi
- Tambahkan hard filter:
  - `spread/slDistance <= X%`.
  - `ATR percentile` minimum agar hindari noise zone.
- Tambahkan “confidence decay” jika confluence rendah + regime tidak cocok.

---

## 6) Testing Depth

### Temuan
- Test suite saat ini sangat minim (baru risk/session).

### Dampak
- Refactor kecil berisiko merusak pipeline tanpa terdeteksi.

### Rekomendasi
- Prioritas test baru:
  1. News filter blocked/unblocked edge case.
  2. DXY filter confidence adjustment boundaries.
  3. AI fallback behavior (strict vs normal).
  4. Duplicate signal cooldown logic per timeframe.
  5. Market data stale handling.
- Target minimal: coverage branch untuk file core >70%.

---

## 7) Observability & Operasional

### Temuan
- Sudah ada metrics heartbeat berbasis log.
- Belum ada endpoint health/readiness dan belum ada alert threshold formal.

### Dampak
- Sulit mendeteksi degradasi bot secara proaktif.

### Rekomendasi
- Tambahkan endpoint `/health` (uptime, last cycle, last data fetch, last news fetch).
- Tentukan SLO sederhana:
  - cycle success rate > 98%
  - stale data incidents < 1% cycle
  - ai bypass rate < 20%
- Trigger alert Telegram jika SLO breach > N kali berturut-turut.

---

## 8) Eksekusi 14 Hari (Pragmatis)

### Minggu 1
- Hari 1–2: config validator + stale data guard.
- Hari 3–4: AI fallback strict mode + metrics tambahan.
- Hari 5–7: test suite untuk news/DXY/duplicate/stale.

### Minggu 2
- Hari 8–10: health endpoint + alert thresholds.
- Hari 11–12: spread/volatility quality gate.
- Hari 13–14: backtest ulang + tuning confidence penalty.

---

## KPI yang Perlu Dipantau Setelah Perbaikan

1. Win rate by strategy (rolling 7/30 hari).
2. Avg R multiple per trade.
3. Drawdown max harian/mingguan.
4. % signal yang dibatalkan karena news/DXY/AI.
5. % cycle gagal (data/news/API).
6. Profit factor paper trading (minimum target > 1.2 sebelum live).

