# Reya Wallet Dashboard

Production-ready static dashboard for Reya wallet analytics (HTML/CSS/vanilla JS), designed for GitHub Pages deployment.

## Features
- Wallet input with strict EVM validation (`0x` + 40 hex chars).
- `?wallet=0x...` query parameter support.
- Idle state when no wallet is provided.
- REST snapshot backfill with endpoint fallback:
  - `https://api.reya.xyz`
  - `https://reya.xyz/api`
- WebSocket streaming with primary/fallback endpoints:
  - `wss://ws.reya.xyz`
  - `wss://websocket-testnet.reya.xyz`
- Auto reconnect with exponential backoff + endpoint rotation.
- Ping heartbeat for long-lived sessions.
- Robust normalization against variable payload envelopes and aliases.
- Dashboard tabs:
  - Positions
  - Trade History PnL
  - Spot Buys/Sells
  - Deposits/Withdrawals
- Dark gray/black/white sharp-edge glassmorphism styling.

## Run locally
Because this app uses browser fetch + websockets, run from a local server (not `file://`).

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

Or use any static server.

## Deploy on GitHub Pages
This repository includes `.github/workflows/deploy-pages.yml`.

- Deploy triggers on push to `main` or `master`.
- Workflow uses:
  - `actions/checkout@v4`
  - `actions/configure-pages@v5`
  - `actions/upload-pages-artifact@v4`
  - `actions/deploy-pages@v4`

## Troubleshooting Pages
1. **404 on Pages URL**
   - Confirm repository **Settings → Pages → Source** is set to **GitHub Actions**.
2. **Workflow succeeds but site is stale**
   - Hard refresh browser cache.
   - Confirm latest commit was pushed to `main`/`master`.
3. **API/WS no data**
   - Check browser console/network if endpoints are temporarily unavailable.
   - The UI is resilient to partial outages and will still render available sections.
4. **Wallet won’t load**
   - Ensure wallet matches exact EVM format (42 chars total, `0x` prefix).

## Project files
- `index.html`
- `styles.css`
- `app.js`
- `.github/workflows/deploy-pages.yml`
- `.nojekyll`
