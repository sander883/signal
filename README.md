# XAUUSD Trading Signal Bot

Advanced Gold (XAU/USD) trading signal generator with mandatory news filtering, multi-strategy analysis, and Telegram alerts.

## Features

- **5 Trading Strategies**: Trend Following, Scalping, Breakout, Mean Reversion, Price Action (SMC)
- **Mandatory News Filter**: Blocks trading during NFP, CPI, FOMC, GDP, and other high-impact events
- **Session Filter**: Only trades during London and New York sessions
- **ATR-Based Risk Management**: Dynamic stop loss, multiple take profit levels, trailing stop, break-even
- **Multi-Timeframe Analysis**: Primary (M15) + secondary (H1) trend alignment
- **Strategy Confluence**: Higher confidence when multiple strategies agree
- **Telegram Alerts**: Real-time signal notifications with full trade details
- **Backtesting Engine**: Test strategies against historical data
- **Paper Trading Mode**: Virtual position tracking without real capital
- **Performance Tracking**: Daily summaries with win rate and strategy breakdown

## Quick Start

### 1. Prerequisites

- Node.js 18+ (LTS recommended)
- Telegram Bot (create via [@BotFather](https://t.me/BotFather))
- Market data API key ([Twelve Data](https://twelvedata.com) or [Alpha Vantage](https://www.alphavantage.co))

### 2. Installation

```bash
git clone <repo-url>
cd signal
npm install
```

### 3. Configuration

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_CHAT_ID=-1001234567890
TWELVEDATA_API_KEY=your_api_key_here

# Optional overrides
RISK_PERCENT=1.5
REWARD_RATIO=2
PRIMARY_TIMEFRAME=15min
NEWS_FILTER_ENABLED=true
SESSION_FILTER_ENABLED=true
```

### 4. Run

```bash
# Production
npm start

# Development (auto-restart on changes)
npm run dev

# Backtesting
npm run backtest

# Run tests
npm test

# Syntax checks
npm run check
```

## How to Get Your API Keys

### Telegram Bot Token
1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the token (format: `123456:ABC...`)

### Telegram Chat ID
1. Add your bot to a group or start a DM
2. Send a message to the bot
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Find `chat.id` in the response

### Twelve Data API Key
1. Sign up at [twelvedata.com](https://twelvedata.com)
2. Free tier: 800 API calls/day, 8 calls/minute
3. Copy your API key from the dashboard

## Architecture

```
src/
├── index.js              # Main entry point, cron scheduler
├── config.js             # All configuration from .env
├── data.js               # Market data fetching (TwelveData/AlphaVantage)
├── indicators.js         # Technical indicator computation
├── risk.js               # Risk management (SL/TP/position sizing)
├── telegram.js           # Telegram alert formatting & sending
├── logger.js             # Winston logging (console + file)
├── backtest.js           # Backtesting engine
├── strategies/
│   ├── index.js          # Strategy runner & confluence logic
│   ├── trendFollowing.js # EMA 50/200 + MACD + RSI
│   ├── scalping.js       # EMA 9/21 + RSI
│   ├── breakout.js       # Support/Resistance breakout
│   ├── meanReversion.js  # Bollinger Bands + RSI
│   └── priceAction.js    # BOS / CHOCH / Supply-Demand
└── filters/
    ├── newsFilter.js     # Economic calendar + event blocking
    └── sessionFilter.js  # London/NY session enforcement
```

## News Filter (Critical)

The news filter is **mandatory** and blocks all signal generation during high-impact economic events.

### How It Works

1. **Data Fetching**: On startup and every 30 minutes, the bot fetches the economic calendar from [ForexFactory](https://nfs.faireconomy.media/ff_calendar_thisweek.json) (public JSON API)
2. **Event Detection**: Filters for USD high-impact events matching keywords: NFP, CPI, FOMC, Interest Rate, GDP, PPI, Unemployment, Retail Sales, PMI, Core PCE
3. **Time Blocking**: Creates a blocked window around each event:
   - Default: 30 min before → 60 min after
   - Configurable via `NEWS_BUFFER_BEFORE_MIN` and `NEWS_BUFFER_AFTER_MIN`
4. **Fallback Safety**: If the calendar API is unreachable, the bot uses hardcoded schedules for major recurring events (NFP first Friday, CPI mid-month, FOMC, etc.)
5. **Ultimate Safety**: If all sources fail, trading is blocked entirely until the next successful fetch

### Blocked Events Example
```
⚠️ TRADING PAUSED - NEWS FILTER
📰 NEWS BLOCK ACTIVE: Non-Farm Payrolls (High) | Starts in 25 min
⏳ Trading will resume after the news buffer period ends.
```

## Strategies

| Strategy | Indicators | Best For |
|----------|-----------|----------|
| Trend Following | EMA 50/200 + MACD + RSI | Strong trends, H1+ |
| Scalping | EMA 9/21 + RSI | Quick moves, M15 |
| Breakout | S/R levels + ATR + ADX | Volatility expansion |
| Mean Reversion | Bollinger Bands + RSI + ADX | Ranging markets |
| Price Action | BOS/CHOCH + Supply/Demand | Smart money concepts |

## Signal Validation Pipeline

A signal must pass ALL of these checks:

1. Session filter allows trading (London/NY hours)
2. No active news blocks
3. Strategy conditions met
4. Minimum confidence threshold (50%)
5. H1 trend alignment (penalty if misaligned)
6. Risk parameters valid (SL not too wide)

## Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `RISK_PERCENT` | 1.5 | Risk per trade as % of account |
| `REWARD_RATIO` | 2 | Risk:Reward ratio (1:X) |
| `PRIMARY_TIMEFRAME` | 15min | Main analysis timeframe |
| `SECONDARY_TIMEFRAME` | 1h | Trend alignment timeframe |
| `NEWS_BUFFER_BEFORE_MIN` | 30 | Minutes before news to block |
| `NEWS_BUFFER_AFTER_MIN` | 60 | Minutes after news to block |
| `STRATEGY_*` | true | Enable/disable individual strategies |
| `CRON_SCHEDULE` | */15 * * * 1-5 | Analysis frequency |
| `PAPER_TRADING_ENABLED` | false | Enable virtual trade execution |
| `PAPER_INITIAL_BALANCE` | 10000 | Starting balance for paper mode |
| `PAPER_MAX_OPEN_POSITIONS` | 3 | Max concurrent paper positions |
| `HEARTBEAT_MINUTES` | 60 | Metrics heartbeat log interval |

## Telegram Alert Format

```
🟢 XAUUSD BUY SIGNAL ⬆️

📊 Strategy: Trend Following
🔗 Confluence: Trend Following, Scalping
⏱ Timeframe: 15min
📈 Confidence: 82%
🎯 Strategies Agreeing: 2

💰 Entry: 2345.50
🛑 Stop Loss: 2340.20
✅ Take Profit 1: 2356.10 (1:2)
✅ Take Profit 2: 2361.40 (1:3)
✅ Take Profit 3: 2366.70

📏 SL Distance: 5.30 (530 pips)
📐 ATR: 3.53
⚠️ Risk: 1.5%
```

## License

ISC
