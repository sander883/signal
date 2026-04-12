# Signal Bot Data Archive

This branch stores collected trading signal data (auto-synced).
It is an orphan branch — no code here, only data files.

## Files
- `data/signals-YYYY-MM-DD.jsonl` — every signal decision (sent + blocked)
- `data/trades-YYYY-MM-DD.jsonl` — paper trade close events with MFE/MAE

## Usage
```python
import pandas as pd, glob
signals = pd.concat([pd.read_json(f, lines=True) for f in glob.glob("data/signals-*.jsonl")])
trades  = pd.concat([pd.read_json(f, lines=True) for f in glob.glob("data/trades-*.jsonl")])
```

Synced via `npm run sync-data`.
