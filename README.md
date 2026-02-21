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
- **Deposits/Withdrawals from Reya explorer token transfers**:
  - `https://explorer.reya.network/api?module=account&action=tokentx&...`
  - Uses Reya USDC contract `0x3B860c0b53f2e8bd5264AA7c3451d41263C933F2`
  - Classifies bridge transfers via Socket contract `0x1d43076909Ca139BFaC4EbB7194518bE3638fc76`
    - `from == socket` => Deposit
    - `to == socket` => Withdrawal
- Current money split:
  - Wallet USDC on Reya chain from RPC `eth_call balanceOf`
  - DEX account balance/collateral from Wallet Data endpoints (`/v2/wallet/...`)
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
3. **Missing deposit/withdrawal history**
   - Verify wallet has Reya USDC transfers in explorer.
   - Only bridge transfers are shown (`from/to` Socket contract).
4. **API/WS partial data**
   - UI still renders available sections and falls back where possible.
5. **Wallet won’t load**
   - Ensure wallet matches exact EVM format (42 chars total, `0x` prefix).
