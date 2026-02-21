const WS_ENDPOINTS = ["wss://ws.reya.xyz", "wss://websocket-testnet.reya.xyz"];
const API_ENDPOINTS = ["https://api.reya.xyz", "https://reya.xyz/api"];
const EXPLORER_API = "https://explorer.reya.network/api";
const REYA_RPC = "https://rpc.reya.network";
const REYA_USDC = "0x3B860c0b53f2e8bd5264AA7c3451d41263C933F2".toLowerCase();
const SOCKET_CONTRACT = "0x1d43076909ca139bfac4ebb7194518be3638fc76";

const WS_TOPICS = (wallet) => [
  `/v2/wallet/${wallet}/positions`,
  `/v2/wallet/${wallet}/perpExecutions`,
  `/v2/wallet/${wallet}/orderChanges`,
  "/v2/prices",
  "/v2/markets/summary"
];

const state = {
  wallet: null,
  ws: null,
  reconnectCount: 0,
  endpointIndex: 0,
  heartbeatInterval: null,
  positions: new Map(),
  trades: [],
  spot: [],
  transfers: [],
  prices: {},
  marketSummary: {},
  balances: {
    walletUsdc: null,
    dexBalance: null
  },
  bridgeTotals: {
    deposits: 0,
    withdrawals: 0,
    net: 0
  }
};

const ui = {
  walletInput: document.getElementById("walletInput"),
  loadBtn: document.getElementById("loadWalletBtn"),
  walletError: document.getElementById("walletError"),
  connectionStatus: document.getElementById("connectionStatus"),
  dataStatus: document.getElementById("dataStatus"),
  positionsBody: document.getElementById("positionsBody"),
  tradesBody: document.getElementById("tradesBody"),
  spotBody: document.getElementById("spotBody"),
  transfersBody: document.getElementById("transfersBody"),
  empties: {
    positions: document.getElementById("positionsEmpty"),
    trades: document.getElementById("tradesEmpty"),
    spot: document.getElementById("spotEmpty"),
    transfers: document.getElementById("transfersEmpty")
  },
  kpi: {
    total: document.getElementById("kpiTotal"),
    margin: document.getElementById("kpiMargin"),
    collateral: document.getElementById("kpiCollateral"),
    unrealized: document.getElementById("kpiUnrealized")
  }
};

function setStatus(connection, data) {
  if (connection) ui.connectionStatus.textContent = connection;
  if (data) ui.dataStatus.textContent = data;
}

function validateWallet(input) {
  return /^0x[a-fA-F0-9]{40}$/.test((input || "").trim());
}

function parseEnvelope(payload) {
  let data = payload;
  if (typeof payload === "string") {
    try { data = JSON.parse(payload); } catch { return null; }
  }
  if (!data || typeof data !== "object") return null;
  return data.data ?? data.result ?? data.payload ?? data.body ?? data;
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  if (Array.isArray(value?.data)) return value.data;
  return value ? [value] : [];
}

function toNumber(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function formatNum(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatUsd(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `$${formatNum(value, 2)}`;
}

function inferPositionSide(item) {
  const explicit = String(item.side || item.positionSide || "").toLowerCase();
  if (explicit.includes("long")) return "Long";
  if (explicit.includes("short")) return "Short";
  const signedSize = toNumber(item.signedSize, item.netSize, item.positionSizeSigned);
  if (signedSize !== null) return signedSize >= 0 ? "Long" : "Short";
  const size = toNumber(item.size, item.positionSize, item.qty, item.quantity) || 0;
  const direction = String(item.direction || item.dir || "").toLowerCase();
  if (direction.includes("sell")) return "Short";
  if (direction.includes("buy")) return "Long";
  return size < 0 ? "Short" : "Long";
}

function normalizePosition(raw) {
  const market = raw.market || raw.symbol || raw.marketId || "Unknown";
  const side = inferPositionSide(raw);
  const size = Math.abs(toNumber(raw.size, raw.positionSize, raw.qty, raw.quantity, raw.signedSize) || 0);
  const mark = toNumber(raw.markPrice, raw.mark, raw.price, state.prices[market]);
  const entry = toNumber(raw.entryPrice, raw.avgEntry, raw.averageEntryPrice);
  const value = toNumber(raw.value, raw.notional, raw.positionValue, mark !== null ? size * mark : null);
  const pnl = toNumber(raw.unrealizedPnl, raw.pnl, raw.upnl);
  return {
    id: raw.id || `${market}:${raw.accountId || raw.account || "acct"}`,
    market,
    side,
    size,
    accountId: raw.accountId || raw.account || raw.subAccount || "—",
    value,
    pnl,
    mark,
    entry
  };
}

function normalizeTrade(raw) {
  const sideRaw = String(raw.side || raw.direction || raw.type || "").toLowerCase();
  const side = sideRaw.includes("sell") ? "Sell" : "Buy";
  return {
    time: parseTs(raw.timestamp || raw.time || raw.executedAt || raw.createdAt),
    market: raw.market || raw.symbol || raw.asset || "Unknown",
    side,
    size: Math.abs(toNumber(raw.size, raw.qty, raw.quantity, raw.amount) || 0),
    price: toNumber(raw.price, raw.executionPrice, raw.fillPrice),
    fee: toNumber(raw.fee, raw.fees, raw.totalFee),
    pnl: toNumber(raw.pnl, raw.realizedPnl, raw.realized)
  };
}

function normalizeSpot(raw) {
  const base = normalizeTrade(raw);
  return {
    ...base,
    amount: toNumber(raw.amount, raw.quoteAmount, base.price !== null ? base.size * base.price : null)
  };
}

function toDecimalAmount(rawValue, decimals = 6) {
  if (rawValue === null || rawValue === undefined) return null;
  const parsed = String(rawValue).replace(/[^0-9-]/g, "");
  if (!parsed) return null;
  const bigint = BigInt(parsed);
  const scale = 10n ** BigInt(decimals);
  const whole = bigint / scale;
  const fractional = Number(bigint % scale) / Number(scale);
  return Number(whole) + fractional;
}

function normalizeBridgeTransfer(raw) {
  const from = String(raw.from || "").toLowerCase();
  const to = String(raw.to || "").toLowerCase();
  const amount = toDecimalAmount(raw.value, Number(raw.tokenDecimal) || 6);
  const type = to === SOCKET_CONTRACT ? "Withdrawal" : from === SOCKET_CONTRACT ? "Deposit" : "Transfer";
  return {
    time: parseTs(raw.timeStamp || raw.timestamp || raw.time),
    type,
    asset: raw.tokenSymbol || raw.asset || "USDC",
    amount,
    txHash: raw.hash || raw.transactionHash || "—",
    from,
    to
  };
}

function mergePositions(rows) {
  for (const row of rows) {
    const p = normalizePosition(row);
    state.positions.set(p.id, p);
  }
}

function mergeTrades(rows) {
  const normalized = rows.map(normalizeTrade);
  state.trades = [...normalized, ...state.trades]
    .filter((t) => t.time || t.market)
    .slice(0, 500)
    .sort((a, b) => (b.time || 0) - (a.time || 0));
}

function mergeSpot(rows) {
  const normalized = rows.map(normalizeSpot);
  state.spot = [...normalized, ...state.spot]
    .filter((t) => t.time || t.market)
    .slice(0, 500)
    .sort((a, b) => (b.time || 0) - (a.time || 0));
}

function updateKpis() {
  const positions = [...state.positions.values()];
  const totalValue = positions.reduce((sum, p) => sum + (p.value || 0), 0);
  const unrealized = positions.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const margin = toNumber(
    state.marketSummary.marginUsage,
    state.marketSummary.marginUsed,
    state.marketSummary.totalOnAccount ? (totalValue / state.marketSummary.totalOnAccount) * 100 : null
  );

  const total = toNumber(
    state.balances.dexBalance,
    state.marketSummary.totalOnAccount,
    state.marketSummary.totalAccountValue,
    totalValue
  );
  const collateral = toNumber(
    state.balances.walletUsdc,
    state.marketSummary.collateralNow,
    state.marketSummary.collateral,
    totalValue + unrealized
  );

  ui.kpi.total.textContent = formatUsd(total);
  ui.kpi.margin.textContent = margin === null ? "—" : `${formatNum(margin, 2)}%`;
  ui.kpi.collateral.textContent = formatUsd(collateral);
  ui.kpi.unrealized.textContent = `${formatUsd(unrealized)} (Net bridged: ${formatUsd(state.bridgeTotals.net)})`;
  ui.kpi.unrealized.className = unrealized >= 0 ? "pnl-pos" : "pnl-neg";
}

function renderRows(tbody, rows, rowRenderer, emptyEl, emptyText) {
  tbody.innerHTML = "";
  if (!rows.length) {
    emptyEl.textContent = emptyText;
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");
  rows.forEach((row) => tbody.insertAdjacentHTML("beforeend", rowRenderer(row)));
}

function renderAll() {
  const positions = [...state.positions.values()];
  renderRows(
    ui.positionsBody,
    positions,
    (p) => `<tr>
      <td>${p.market}</td>
      <td class="${p.side === "Long" ? "side-long" : "side-short"}">${p.side}</td>
      <td>${formatNum(p.size, 5)}</td>
      <td>${p.accountId}</td>
      <td>${formatUsd(p.value)}</td>
      <td class="${(p.pnl || 0) >= 0 ? "pnl-pos" : "pnl-neg"}">${formatUsd(p.pnl)}</td>
      <td>${formatNum(p.mark, 4)}</td>
      <td>${formatNum(p.entry, 4)}</td>
    </tr>`,
    ui.empties.positions,
    "No open positions for this wallet."
  );

  renderRows(
    ui.tradesBody,
    state.trades,
    (t) => `<tr>
      <td>${t.time ? new Date(t.time).toLocaleString() : "—"}</td>
      <td>${t.market}</td>
      <td class="${t.side === "Buy" ? "side-buy" : "side-sell"}">${t.side}</td>
      <td>${formatNum(t.size, 5)}</td>
      <td>${formatNum(t.price, 4)}</td>
      <td>${formatNum(t.fee, 4)}</td>
      <td class="${(t.pnl || 0) >= 0 ? "pnl-pos" : "pnl-neg"}">${formatNum(t.pnl, 4)}</td>
    </tr>`,
    ui.empties.trades,
    "No perp executions found yet."
  );

  renderRows(
    ui.spotBody,
    state.spot,
    (t) => `<tr>
      <td>${t.time ? new Date(t.time).toLocaleString() : "—"}</td>
      <td>${t.market}</td>
      <td class="${t.side === "Buy" ? "side-buy" : "side-sell"}">${t.side}</td>
      <td>${formatNum(t.size, 5)}</td>
      <td>${formatNum(t.price, 4)}</td>
      <td>${formatNum(t.amount, 4)}</td>
    </tr>`,
    ui.empties.spot,
    "No spot buy/sell history available from API payloads."
  );

  renderRows(
    ui.transfersBody,
    state.transfers,
    (t) => `<tr>
      <td>${t.time ? new Date(t.time).toLocaleString() : "—"}</td>
      <td class="${t.type === "Deposit" ? "side-buy" : "side-sell"}">${t.type}</td>
      <td>${t.asset}</td>
      <td>${formatNum(t.amount, 6)}</td>
      <td>${t.txHash === "—" ? "—" : `<a href="https://explorer.reya.network/tx/${t.txHash}" target="_blank" rel="noopener noreferrer">${t.txHash.slice(0, 10)}…</a>`}</td>
    </tr>`,
    ui.empties.transfers,
    "No bridge deposits/withdrawals found for Reya USDC."
  );

  updateKpis();
}

function parseResponseByIntent(intent, payload) {
  const rows = ensureArray(parseEnvelope(payload));
  if (intent === "positions") mergePositions(rows);
  if (intent === "trades") mergeTrades(rows);
  if (intent === "spot") mergeSpot(rows);
  if (intent === "prices") {
    rows.forEach((r) => {
      const key = r.market || r.symbol;
      const val = toNumber(r.price, r.markPrice, r.mark);
      if (key && val !== null) state.prices[key] = val;
    });
  }
  if (intent === "summary") {
    const summary = rows[0] || parseEnvelope(payload) || {};
    state.marketSummary = { ...state.marketSummary, ...summary };
  }
}

async function fetchFirst(pathsByIntent) {
  await Promise.all(Object.entries(pathsByIntent).map(async ([intent, paths]) => {
    let done = false;
    for (const base of API_ENDPOINTS) {
      for (const path of paths) {
        if (done) break;
        try {
          const res = await fetch(`${base}${path}`);
          if (!res.ok) continue;
          parseResponseByIntent(intent, await res.json());
          done = true;
        } catch {
          // ignore and continue
        }
      }
    }
    if (!done) setStatus(null, `Partial data: ${intent} snapshot unavailable.`);
  }));

  renderAll();
}

async function fetchBridgeTransfers(wallet) {
  const url = `${EXPLORER_API}?${new URLSearchParams({
    module: "account",
    action: "tokentx",
    address: wallet,
    contractaddress: REYA_USDC,
    sort: "desc"
  }).toString()}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const payload = await res.json();
    const rows = ensureArray(payload.result || payload.data || payload.items);
    const normalized = rows.map(normalizeBridgeTransfer)
      .filter((t) => t.type === "Deposit" || t.type === "Withdrawal");

    state.transfers = normalized
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .slice(0, 500);

    state.bridgeTotals.deposits = state.transfers
      .filter((t) => t.type === "Deposit")
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    state.bridgeTotals.withdrawals = state.transfers
      .filter((t) => t.type === "Withdrawal")
      .reduce((sum, t) => sum + (t.amount || 0), 0);
    state.bridgeTotals.net = state.bridgeTotals.deposits - state.bridgeTotals.withdrawals;
  } catch {
    setStatus(null, "Could not fetch Reya explorer transfer history.");
  }
}

async function fetchWalletUsdcBalance(wallet) {
  try {
    const paddedAddress = wallet.toLowerCase().replace("0x", "").padStart(64, "0");
    const res = await fetch(REYA_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: REYA_USDC, data: `0x70a08231${paddedAddress}` }, "latest"]
      })
    });
    const payload = await res.json();
    if (!payload?.result) return;
    state.balances.walletUsdc = Number(BigInt(payload.result) / 1000000n) + Number(BigInt(payload.result) % 1000000n) / 1e6;
  } catch {
    setStatus(null, "Could not fetch on-chain Reya USDC wallet balance.");
  }
}

function pickBalanceValue(row) {
  return toNumber(
    row.collateral,
    row.balance,
    row.totalBalance,
    row.equity,
    row.accountValue,
    row.usdcBalance,
    row.freeCollateral,
    row.amount
  );
}

async function fetchDexBalance(wallet) {
  const walletAccountPaths = [
    `/v2/wallet/${wallet}/accounts`,
    `/v2/wallet/${wallet}/accountIds`,
    `/v2/wallet/${wallet}/balances`
  ];
  const accountBalancePatterns = [
    (id) => `/v2/wallet/${wallet}/accounts/${id}/balances`,
    (id) => `/v2/accounts/${id}/balances`
  ];

  let accounts = [];
  for (const base of API_ENDPOINTS) {
    for (const path of walletAccountPaths) {
      try {
        const res = await fetch(`${base}${path}`);
        if (!res.ok) continue;
        const body = await res.json();
        const rows = ensureArray(parseEnvelope(body));
        if (path.includes("balances")) {
          const values = rows.map(pickBalanceValue).filter((v) => v !== null);
          if (values.length) {
            state.balances.dexBalance = values.reduce((s, v) => s + v, 0);
            return;
          }
        }
        accounts = rows
          .map((r) => r.accountId || r.id || r.account || r.subAccountId)
          .filter(Boolean);
        if (accounts.length) break;
      } catch {
        // try next path
      }
    }
    if (accounts.length) {
      let total = 0;
      let found = false;
      for (const id of accounts) {
        for (const pattern of accountBalancePatterns) {
          try {
            const res = await fetch(`${base}${pattern(id)}`);
            if (!res.ok) continue;
            const body = await res.json();
            const rows = ensureArray(parseEnvelope(body));
            const values = rows.map(pickBalanceValue).filter((v) => v !== null);
            if (values.length) {
              total += values.reduce((s, v) => s + v, 0);
              found = true;
              break;
            }
          } catch {
            // continue
          }
        }
      }
      if (found) {
        state.balances.dexBalance = total;
        return;
      }
    }
  }

  setStatus(null, "DEX account balance endpoint unavailable; using market summary fallback.");
}

function wsSend(topic) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ op: "subscribe", topic }));
}

function startHeartbeat() {
  clearInterval(state.heartbeatInterval);
  state.heartbeatInterval = setInterval(() => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify({ op: "ping", t: Date.now() }));
  }, 20000);
}

function handleWsMessage(event) {
  const envelope = parseEnvelope(event.data);
  if (!envelope) return;
  const topic = envelope.topic || envelope.channel || envelope.path || "";
  const rows = ensureArray(envelope);

  if (topic.includes("positions")) mergePositions(rows);
  else if (topic.includes("perpExecutions")) mergeTrades(rows);
  else if (topic.includes("orderChanges")) {
    mergeSpot(rows.filter((r) => String(r.marketType || r.type || "").toLowerCase().includes("spot")));
  } else if (topic.includes("prices")) parseResponseByIntent("prices", envelope);
  else if (topic.includes("markets/summary")) parseResponseByIntent("summary", envelope);
  else {
    mergePositions(rows.filter((r) => r.market || r.positionSize));
    mergeTrades(rows.filter((r) => r.executionPrice || r.realizedPnl));
  }

  renderAll();
}

function connectWs() {
  if (!state.wallet) return;
  const endpoint = WS_ENDPOINTS[state.endpointIndex % WS_ENDPOINTS.length];
  setStatus(`Connecting (${(state.endpointIndex % WS_ENDPOINTS.length) + 1}/${WS_ENDPOINTS.length})`, `Opening WebSocket ${endpoint}`);
  const ws = new WebSocket(endpoint);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.reconnectCount = 0;
    setStatus("Connected", `Streaming live data from ${endpoint}`);
    WS_TOPICS(state.wallet).forEach(wsSend);
    startHeartbeat();
  });

  ws.addEventListener("message", handleWsMessage);

  ws.addEventListener("close", () => {
    clearInterval(state.heartbeatInterval);
    const waitMs = Math.min(15000, 1000 * (2 ** state.reconnectCount));
    state.reconnectCount += 1;
    state.endpointIndex += 1;
    setStatus("Reconnecting", `Connection closed. Retrying in ${Math.round(waitMs / 1000)}s.`);
    setTimeout(connectWs, waitMs);
  });

  ws.addEventListener("error", () => {
    setStatus("Error", "WebSocket error; falling back and retrying.");
    ws.close();
  });
}

function resetWalletState() {
  if (state.ws) state.ws.close();
  clearInterval(state.heartbeatInterval);
  state.positions.clear();
  state.trades = [];
  state.spot = [];
  state.transfers = [];
  state.prices = {};
  state.marketSummary = {};
  state.balances = { walletUsdc: null, dexBalance: null };
  state.bridgeTotals = { deposits: 0, withdrawals: 0, net: 0 };
}

async function loadWallet(wallet) {
  resetWalletState();
  state.wallet = wallet;
  const url = new URL(window.location.href);
  url.searchParams.set("wallet", wallet);
  history.replaceState({}, "", url.toString());

  setStatus("Loading", "Fetching snapshots, bridge transfers, and balances...");
  renderAll();

  await Promise.all([
    fetchFirst({
      positions: [`/v2/wallet/${wallet}/positions`],
      trades: [`/v2/wallet/${wallet}/perpExecutions`],
      spot: [`/v2/wallet/${wallet}/spotExecutions`, `/v2/wallet/${wallet}/orderChanges`],
      prices: ["/v2/prices"],
      summary: ["/v2/markets/summary"]
    }),
    fetchBridgeTransfers(wallet),
    fetchWalletUsdcBalance(wallet),
    fetchDexBalance(wallet)
  ]);

  renderAll();
  connectWs();
}

function setWalletError(msg) {
  if (!msg) {
    ui.walletError.classList.add("hidden");
    return;
  }
  ui.walletError.textContent = msg;
  ui.walletError.classList.remove("hidden");
}

function initTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

function initWallet() {
  const submit = async () => {
    const wallet = ui.walletInput.value.trim();
    if (!validateWallet(wallet)) {
      setWalletError("Invalid wallet address format. Expected 0x + 40 hex characters.");
      return;
    }
    setWalletError("");
    await loadWallet(wallet);
  };

  ui.loadBtn.addEventListener("click", submit);
  ui.walletInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  const queryWallet = new URLSearchParams(window.location.search).get("wallet");
  if (queryWallet && validateWallet(queryWallet)) {
    ui.walletInput.value = queryWallet;
    submit();
  } else {
    setStatus("Idle", "No wallet selected. Paste an EVM wallet and click Load.");
  }
}

initTabs();
initWallet();
renderAll();
