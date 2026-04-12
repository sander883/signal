#!/usr/bin/env node
/**
 * syncData.js — Push data/*.jsonl to the `data-archive` orphan branch.
 *
 * Usage:
 *   node scripts/syncData.js          # sync once
 *   npm run sync-data                 # same via npm
 *
 * How it works:
 * 1. Copy data files to a temp directory (safe from git operations)
 * 2. Stash any uncommitted work
 * 3. Switch to orphan branch `data-archive` (creates on first run)
 * 4. Restore data files from temp into the branch
 * 5. Commit + push
 * 6. Switch back to original branch + restore stash
 *
 * Safe to run repeatedly — only pushes new/changed files.
 * Does NOT touch your working branch code or history.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(process.cwd(), 'data');
const BRANCH = 'data-archive';
const REMOTE = 'origin';

function run(cmd, opts = {}) {
  try {
    const stdio = opts.silent ? 'pipe' : 'inherit';
    const result = execSync(cmd, { encoding: 'utf8', stdio });
    return (result || '').trim();
  } catch (err) {
    if (opts.ignoreError) return '';
    throw err;
  }
}

function main() {
  // ── Pre-checks ──
  if (!fs.existsSync(DATA_DIR)) {
    console.log('No data/ directory found. Run the bot first to generate data.');
    process.exit(0);
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.jsonl'));
  if (files.length === 0) {
    console.log('No .jsonl files in data/. Nothing to sync.');
    process.exit(0);
  }

  console.log(`Found ${files.length} data file(s) to sync.`);

  // ── Step 1: Copy data to temp (survives any git operation) ──
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-sync-'));
  const tmpData = path.join(tmpDir, 'data');
  fs.mkdirSync(tmpData);
  for (const file of files) {
    fs.copyFileSync(path.join(DATA_DIR, file), path.join(tmpData, file));
  }
  console.log(`Data backed up to ${tmpDir}`);

  // ── Step 2: Remember state ──
  const originalBranch = run('git rev-parse --abbrev-ref HEAD', { silent: true });
  console.log(`Current branch: ${originalBranch}`);

  const isDirty = run('git status --porcelain', { silent: true }).length > 0;
  if (isDirty) {
    console.log('Stashing uncommitted changes...');
    run('git stash push -m "syncData auto-stash"');
  }

  try {
    // ── Step 3: Switch to data-archive branch ──
    const localExists = run(`git branch --list ${BRANCH}`, { silent: true }).length > 0;
    const remoteExists = run(`git ls-remote --heads ${REMOTE} ${BRANCH}`, { silent: true }).length > 0;

    if (localExists) {
      run(`git checkout ${BRANCH}`);
    } else if (remoteExists) {
      run(`git fetch ${REMOTE} ${BRANCH}`, { ignoreError: true });
      run(`git checkout -b ${BRANCH} ${REMOTE}/${BRANCH}`);
    } else {
      console.log(`Creating orphan branch '${BRANCH}'...`);
      run(`git checkout --orphan ${BRANCH}`);
      run('git rm -rf .', { ignoreError: true });
    }

    // ── Step 4: Restore data files from temp ──
    if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });

    for (const file of files) {
      fs.copyFileSync(path.join(tmpData, file), path.join('data', file));
    }

    // Add a README on first run
    if (!fs.existsSync('README.md')) {
      fs.writeFileSync('README.md', [
        '# Signal Bot Data Archive',
        '',
        'This branch stores collected trading signal data (auto-synced).',
        'It is an orphan branch — no code here, only data files.',
        '',
        '## Files',
        '- `data/signals-YYYY-MM-DD.jsonl` — every signal decision (sent + blocked)',
        '- `data/trades-YYYY-MM-DD.jsonl` — paper trade close events with MFE/MAE',
        '',
        '## Usage',
        '```python',
        'import pandas as pd, glob',
        'signals = pd.concat([pd.read_json(f, lines=True) for f in glob.glob("data/signals-*.jsonl")])',
        'trades  = pd.concat([pd.read_json(f, lines=True) for f in glob.glob("data/trades-*.jsonl")])',
        '```',
        '',
        'Synced via `npm run sync-data`.',
        '',
      ].join('\n'));
    }

    // ── Step 5: Commit + push ──
    run('git add data/ README.md');

    const staged = run('git diff --cached --stat', { silent: true });
    if (!staged) {
      console.log('No new data changes to commit. Already up to date.');
    } else {
      const date = new Date().toISOString().split('T')[0];
      const totalSize = files.reduce((s, f) => {
        const p = path.join(tmpData, f);
        return s + (fs.existsSync(p) ? fs.statSync(p).size : 0);
      }, 0);
      const sizeKB = (totalSize / 1024).toFixed(1);

      run(`git commit -m "data: sync ${date} (${files.length} files, ${sizeKB} KB)"`);

      console.log('Pushing to remote...');
      let pushed = false;
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          run(`git push -u ${REMOTE} ${BRANCH}`);
          pushed = true;
          break;
        } catch (err) {
          if (attempt < 4) {
            const wait = Math.pow(2, attempt);
            console.log(`Push failed, retrying in ${wait}s... (attempt ${attempt}/4)`);
            execSync(`sleep ${wait}`);
          }
        }
      }
      if (pushed) {
        console.log(`\nData synced to ${REMOTE}/${BRANCH}`);
      } else {
        console.error('Failed to push after 4 attempts.');
        process.exitCode = 1;
      }
    }
  } finally {
    // ── Step 6: Always switch back ──
    console.log(`Switching back to ${originalBranch}...`);
    run(`git checkout ${originalBranch}`, { ignoreError: true });
    if (isDirty) {
      console.log('Restoring stashed changes...');
      run('git stash pop', { ignoreError: true });
    }

    // Cleanup temp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('Done.');
}

main();
