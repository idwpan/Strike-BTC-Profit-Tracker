// Runs on the Strike transactions page and augments the table with profit
// details using price data from the background script as well as historical
// price lookups.

// The manifest loads the polyfill before this file, so `browser.*` APIs work in
// both Chrome and Firefox.

const LOG_PREFIX = "[Strike Profit]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const debug = (...args) => console.debug(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

// Convert a string like "₿0.1" to a number.
const parseBTC = (str = "") => parseFloat(str.replace(/[₿,\s]/g, "")) || 0;

// Convert a string like "$100" to a number.
const parseUSD = (str = "") => parseFloat(str.replace(/[$,\s]/g, "")) || 0;

// Column index used as a template for new cells (the "Sold" column).
const SOLD_COLUMN_INDEX = 2;

// Cached historical prices keyed by minute bucket to limit API calls.
const historicalPriceCache = new Map();

// Track whether the script is navigating tabs programmatically so we can avoid
// responding to our own clicks.
let isProgrammaticNavigation = false;

// Track an in-flight processing promise so we do not run multiple refreshes at
// the same time.
let processingPromise = null;

// only check receiving and sending tabs once then cache until next page load
let checkReceivingSending = true;
let receiveResult = { events: [], totalBTC: 0 };
let sendResult = { events: [], totalBTC: 0 };

// Small utility to wait a given number of milliseconds.
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until the provided predicate returns a truthy value or the timeout
// elapses. Returns the predicate's value or null on timeout.
const waitForCondition = async (
    predicate,
    { timeout = 5000, interval = 100 } = {}
) => {
    const start = Date.now();
    let result = predicate();
    while (!result) {
        if (Date.now() - start > timeout) return null;
        await wait(interval);
        result = predicate();
    }
    return result;
};

// Check whether the Trading tab is currently active.
const isTradingTabActive = () => {
    const activeTab = document.querySelector('button[aria-selected="true"]');
    return activeTab?.textContent.trim() === "Trading";
};

// Locate a tab button by its visible label.
const findTabByName = (name) =>
    [...document.querySelectorAll('[role="tab"]')].find(
        (btn) => btn.textContent.trim().toLowerCase() === name.toLowerCase()
    );

// Return the currently active tab button if present.
const getActiveTab = () => document.querySelector('[role="tab"][aria-selected="true"]');

// Ask the background script for the current BTC price.
const fetchCurrentBTCPrice = async () => {
    const response = await browser.runtime.sendMessage({ type: "GET_BTC_PRICE" });
    if (!response || response.error || response.price == null) {
        throw new Error("Failed to fetch BTC price from background");
    }
    debug("Fetched current BTC price", response.price);
    return response.price;
};

// Fetch the BTC price around the provided timestamp using Bitfinex candles.
// Results are cached per-minute to keep network usage low.
const fetchHistoricalBTCPrice = async (date) => {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

    const minuteKey = Math.floor(date.getTime() / 60000);
    if (historicalPriceCache.has(minuteKey)) {
        debug("Using cached historical price for", date.toISOString());
        return historicalPriceCache.get(minuteKey);
    }

    const windowMs = 10 * 60 * 1000; // +/- 10 minutes
    const start = Math.max(0, date.getTime() - windowMs);
    const end = date.getTime() + windowMs;
    const url =
        `https://api-pub.bitfinex.com/v2/candles/trade:1m:tBTCUSD/hist?start=${start}&end=${end}` +
        "&limit=120&sort=1";

    try {
        debug("Requesting historical BTC price for", date.toISOString());
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data) || !data.length) {
            historicalPriceCache.set(minuteKey, null);
            return null;
        }

        const targetMs = date.getTime();
        let closest = null;
        let closestDiff = Number.POSITIVE_INFINITY;

        data.forEach((candle) => {
            if (!Array.isArray(candle) || candle.length < 3) return;
            const candleTime = candle[0];
            const diff = Math.abs(candleTime - targetMs);
            if (diff < closestDiff) {
                closest = candle;
                closestDiff = diff;
            }
        });

        const price = closest ? closest[2] ?? closest[1] ?? null : null;
        historicalPriceCache.set(minuteKey, price ?? null);
        debug("Received historical BTC price", price, "for", date.toISOString());
        return price ?? null;
    } catch (error) {
        warn("Failed to fetch historical BTC price:", error);
        historicalPriceCache.set(minuteKey, null);
        return null;
    }
};

// Extract a Date instance from a table cell that contains the completed time.
const parseDateFromCell = (cell) => {
    if (!cell) return null;

    const withTitle = cell.querySelector('[title]');
    if (withTitle?.getAttribute("title")) {
        const ts = Date.parse(withTitle.getAttribute("title"));
        if (!Number.isNaN(ts)) return new Date(ts);
    }

    const text = cell.textContent?.trim();
    if (!text) return null;
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : new Date(parsed);
};

// Remove any previously injected profit cells from a row.
const clearProfitCells = (row) => {
    row.querySelectorAll('[data-profit-cell="true"]').forEach((cell) => cell.remove());
};

// Remove previously injected header cells from the header row.
const clearProfitHeaders = (headerRow) => {
    headerRow.querySelectorAll('[data-profit-header="true"]').forEach((cell) => cell.remove());
};

// Format helpers.
const formatUSD = (value) => `$${Number(value ?? 0).toFixed(2)}`;
const formatPercent = (value) => `${Number(value ?? 0).toFixed(2)}%`;
const formatBTC = (value) => `${Number(value ?? 0).toFixed(8)} BTC`;

// Add header cells with provided labels, cloning style from the first <th>.
const appendStyledHeaderCells = (headerRow, labels) => {
    if (!headerRow) return;
    clearProfitHeaders(headerRow);

    const templateTH = headerRow.querySelectorAll("th")[1];
    if (!templateTH) return;

    labels.forEach((label) => {
        const cloned = templateTH.cloneNode(true);
        const labelElem = cloned.querySelector("p") || cloned;

        if (labelElem) labelElem.textContent = label;
        cloned.dataset.profitHeader = "true";
        headerRow.appendChild(cloned);
    });
};

// Add new cells to a row using a template, optionally applying a color.
const appendStyledCells = (row, values, templateIndex = SOLD_COLUMN_INDEX) => {
    if (!row) return;
    clearProfitCells(row);

    const cells = row.querySelectorAll("td");
    const templateTD = cells[templateIndex] || cells[cells.length - 1];
    if (!templateTD) return;

    values.forEach(({ text, color = null }) => {
        const cloned = templateTD.cloneNode(true);
        const p = cloned.querySelector("p");

        if (p) {
            p.textContent = text;
            if (color) p.style.color = color;
        } else {
            cloned.textContent = text;
            if (color) cloned.style.color = color;
        }

        cloned.dataset.profitCell = "true";
        row.appendChild(cloned);
    });
};

// Locate a column index within a table header using a set of keywords.
const createColumnLookup = (table) => {
    const headers = [...table.querySelectorAll("thead th")].map((th) =>
        th.textContent?.trim().toLowerCase() ?? ""
    );

    return (keywords, fallback = -1) => {
        const normalized = keywords.map((k) => k.toLowerCase());
        const index = headers.findIndex((header) =>
            normalized.some((keyword) => header.includes(keyword))
        );
        return index >= 0 ? index : fallback;
    };
};

// Return the scrollable element that actually drives row loading.
const getScrollableContainer = (panel) => {
    // Common cases: a div wrapping the table, or the panel itself
    const candidates = [
        panel.querySelector('[data-testid*="table"], [role="tabpanel"]'),
        panel.querySelector('[class*="Table"], [class*="table"]'),
        panel
    ].filter(Boolean);
    // Pick the first element that is scrollable.
    return candidates.find(el => el.scrollHeight > el.clientHeight) || panel;
};

const getRowCount = (table) =>
    table?.querySelector("tbody")?.querySelectorAll("tr").length || 0;

// Resolve when the DOM in `root` has been quiet (no childList mutations) for `quietMs`
const waitForDomQuiet = (root, quietMs = 500, timeout = 8000) =>
    new Promise((resolve) => {
        let lastMutation = Date.now();
        const timer = setInterval(() => {
            if (Date.now() - lastMutation >= quietMs) {
                cleanup();
                resolve(true);
            }
        }, Math.min(quietMs, 250));
        const to = setTimeout(() => { cleanup(); resolve(false); }, timeout);
        const obs = new MutationObserver(() => { lastMutation = Date.now(); });
        obs.observe(root, { childList: true, subtree: true });
        const cleanup = () => { clearInterval(timer); clearTimeout(to); obs.disconnect(); };
    });

// Click any visible "Load more" button, if present
const clickLoadMoreIfPresent = (panel) => {
    const btn = [...panel.querySelectorAll("button")].find(
        (b) => b.textContent.trim().toLowerCase() === "load more"
    );
    if (!btn) return false;
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return false;
    btn.click();
    return true;
};

// Scroll to bottom a few times to trigger infinite loaders/virtualization
const scrollOnceToBottom = async (scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
    // Give React/Vue a tick to schedule work
    await wait(150);
};

// Ensure all paginated/virtualized rows are present before processing
const ensureAllRowsLoaded = async (panel, { panelName = "panel" } = {}) => {
    if (!panel) { warn(`Cannot ensure rows for ${panelName}; no panel provided`); return; }

    // Wait for table & first row to exist at all
    let table = await waitForCondition(() => panel.querySelector("table"), { timeout: 2000, interval: 100 });
    if (!table) { debug(`No table found for ${panelName}`); return; }
    await waitForCondition(() => table.querySelector("tbody tr"), { timeout: 2000, interval: 100 });

    const scroller = getScrollableContainer(panel);

    // Loop until row count stabilizes and there are no pending mutations.
    let stablePasses = 0;
    let lastCount = -1;

    for (let i = 0; i < 40; i += 1) { // hard safety cap
        table = panel.querySelector("table") || table;
        const before = getRowCount(table);

        // Try both mechanisms: button click and scroll-to-bottom.
        const clicked = clickLoadMoreIfPresent(panel);
        await scrollOnceToBottom(scroller);

        // Wait for rows to materialize or the button to disable
        await waitForDomQuiet(panel, 200, 1000);

        table = panel.querySelector("table") || table;
        const after = getRowCount(table);

        debug(`${panelName}: rows ${before} -> ${after}${clicked ? " (+clicked)" : ""}`);

        if (after === before) {
            // No growth this iteration; count as a “stable” pass.
            stablePasses += 1;
        } else {
            stablePasses = 0;
        }

        // Consider done if two consecutive passes show no growth and no load-more available.
        const loadMorePresent = !![...panel.querySelectorAll("button")].find(
            (b) => b.textContent.trim().toLowerCase() === "load more" && !(b.disabled || b.getAttribute("aria-disabled") === "true")
        );

        if (stablePasses >= 2 && !loadMorePresent) {
            debug(`${panelName}: rows stabilized at ${after}`);
            break;
        }

        // Also break if counts are truly stuck across multiple tries
        if (after === lastCount && stablePasses >= 3) break;
        lastCount = after;
    }

    // Final quiet period to let any last virtualized chunks settle
    await waitForDomQuiet(panel, 200, 1000);
};


// Make sure the table for the requested tab is available, loading the tab if
// necessary. Returns the tab, its panel, and the resolved table.
const ensureTabTableReady = async (tabName, { expectRows = true } = {}) => {
    const tab = findTabByName(tabName);
    if (!tab) {
        warn(`Tab "${tabName}" not found`);
        return null;
    }

    const resolvePanel = async () => {
        const id = tab.getAttribute("aria-controls");
        return id ? document.getElementById(id) : null;
    };

    let panel = (await resolvePanel()) ??
        (await waitForCondition(resolvePanel, { timeout: 5000, interval: 150 }));

    if (!panel) {
        warn(`Panel for tab "${tabName}" not found`);
        return null;
    }

    let table = panel.querySelector("table");
    let hasRows = !!table?.querySelector("tbody tr");

    const wasActive = tab.getAttribute("aria-selected") === "true";

    if (!table || (expectRows && !hasRows)) {
        if (!wasActive) {
            log(`Activating ${tabName} tab to load data`);
            isProgrammaticNavigation = true;
            tab.click();
            await waitForCondition(
                () => tab.getAttribute("aria-selected") === "true",
                { timeout: 7000, interval: 150 }
            );
            isProgrammaticNavigation = false;
        } else {
            debug(`${tabName} tab already active; waiting for data`);
        }

        table = await waitForCondition(
            () => panel.querySelector("table"),
            { timeout: 10000, interval: 200 }
        );

        if (!table) {
            warn(`Table for tab "${tabName}" did not load`);
            return { tab, panel, table: null };
        }

        if (expectRows) {
            await waitForCondition(
                () => table.querySelector("tbody tr"),
                { timeout: 10000, interval: 200 }
            );
        }
    }

    await ensureAllRowsLoaded(panel, { panelName: tabName });
    table = panel.querySelector("table");
    if (!table) {
        warn(`Table for tab "${tabName}" missing after load`);
        return { tab, panel, table: null };
    }

    return { tab, panel, table };
};

// Process the trading table, inject profit columns, and return trading events.
const processTradingTable = async (table, currentPrice) => {
    const lookup = createColumnLookup(table);
    const soldIndex = lookup(["sold"], SOLD_COLUMN_INDEX);
    const boughtIndex = lookup(["bought"], SOLD_COLUMN_INDEX + 1);
    const completedIndex = lookup(["completed", "date", "filled"], 1);
    const templateIndex = soldIndex >= 0 ? soldIndex : SOLD_COLUMN_INDEX;

    const rows = [...table.querySelectorAll("tbody tr")];
    const events = [];
    const priceStats = { ratio: 0, historical: 0, missing: 0 };

    for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length <= Math.max(soldIndex, boughtIndex)) continue;
        if (cells.length <= 1) continue;

        const soldUSD = soldIndex >= 0 ? parseUSD(cells[soldIndex]?.innerText) : 0;
        const boughtBTC = boughtIndex >= 0 ? parseBTC(cells[boughtIndex]?.innerText) : 0;
        if (!boughtBTC) continue;

        const completedAt = completedIndex >= 0 ? parseDateFromCell(cells[completedIndex]) : null;
        const fallbackPrice = boughtBTC ? soldUSD / boughtBTC : null;
        let entryPrice = null;

        if (Number.isFinite(fallbackPrice) && fallbackPrice > 0) {
            entryPrice = fallbackPrice;
            priceStats.ratio += 1;
        } else if (completedAt) {
            const historicalPrice = await fetchHistoricalBTCPrice(completedAt);
            if (Number.isFinite(historicalPrice) && historicalPrice > 0) {
                entryPrice = historicalPrice;
                priceStats.historical += 1;
            }
        }

        if (entryPrice == null) {
            priceStats.missing += 1;
        }

        const priceForBasis = entryPrice ?? 0;
        const basisUSD = priceForBasis * boughtBTC;
        const currentValueUSD = boughtBTC * currentPrice;
        const profitUSD = currentValueUSD - basisUSD;
        const percent = basisUSD ? (profitUSD / basisUSD) * 100 : 0;
        const color = profitUSD >= 0 ? "green" : "red";

        appendStyledCells(
            row,
            [
                // { text: entryPrice ? formatUSD(entryPrice) : "—" },
                { text: formatUSD(profitUSD), color },
                { text: formatPercent(percent), color },
            ],
            templateIndex
        );

        events.push({
            type: "trade",
            timestamp: completedAt ?? null,
            amountBTC: boughtBTC,
            entryPrice: priceForBasis,
        });
    }

    const headerRow = table.querySelector("thead tr");
    appendStyledHeaderCells(headerRow, ["Profit ($)", "Profit (%)"]);

    log(
        `Processed Trading table with ${events.length} trades ` +
        `(ratio: ${priceStats.ratio}, historical: ${priceStats.historical}, missing price: ${priceStats.missing})`
    );

    return { events, table };
};

// Parse a receiving or sending table and produce transfer events.
const processTransferTable = async (table, direction, currentPrice) => {
    const lookup = createColumnLookup(table);
    const amountIndex = lookup(["amount"], -1);
    const feeIndex = lookup(["fee"], -1);
    const completedIndex = lookup(["completed", "date"], -1);

    if (amountIndex < 0) return { events: [], totalBTC: 0 };

    const rows = [...table.querySelectorAll("tbody tr")];
    const events = [];
    let totalBTC = 0;
    const priceStats = { historical: 0, fallback: 0 };

    for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length <= amountIndex) continue;
        if (cells.length === 1) continue;

        const amount = Math.abs(parseBTC(cells[amountIndex]?.innerText));
        const fee = feeIndex >= 0 ? Math.abs(parseBTC(cells[feeIndex]?.innerText)) : 0;
        const completedAt = completedIndex >= 0 ? parseDateFromCell(cells[completedIndex]) : null;

        let netAmount = amount;
        if (direction === "out") {
            netAmount = amount + fee; // Remove both sent amount and fee from holdings
        }

        if (!netAmount) continue;

        const historicalPrice = await fetchHistoricalBTCPrice(completedAt);
        let priceForBasis = historicalPrice;
        if (Number.isFinite(priceForBasis) && priceForBasis > 0) {
            priceStats.historical += 1;
        } else {
            priceForBasis = currentPrice ?? 0;
            priceStats.fallback += 1;
        }

        if (direction === "in") {
            totalBTC += netAmount;
            events.push({
                type: "receive",
                timestamp: completedAt ?? null,
                amountBTC: netAmount,
                entryPrice: priceForBasis,
            });
        } else {
            totalBTC += netAmount;
            events.push({
                type: "send",
                timestamp: completedAt ?? null,
                amountBTC: -Math.abs(netAmount),
                entryPrice: priceForBasis,
            });
        }
    }

    log(
        `Processed ${direction === "in" ? "Receiving" : "Sending"} table with ${events.length} ` +
        `events (BTC total: ${totalBTC.toFixed(8)}, historical prices: ${priceStats.historical}, ` +
        `fallback prices: ${priceStats.fallback})`
    );

    return { events, totalBTC };
};

// Build a summary of holdings and profit using the provided events.
const buildSummary = (currentPrice, { tradeEvents = [], receiveEvents = [], sendEvents = [] }) => {
    const allEvents = [...tradeEvents, ...receiveEvents, ...sendEvents].filter(
        (event) => Number.isFinite(event.amountBTC) && event.amountBTC !== 0
    );

    allEvents.sort((a, b) => {
        const aTime = a.timestamp?.getTime() ?? 0;
        const bTime = b.timestamp?.getTime() ?? 0;
        if (aTime === bTime) {
            const aAmount = a.amountBTC ?? 0;
            const bAmount = b.amountBTC ?? 0;
            return bAmount - aAmount; // process inbound before outbound when timestamps match
        }
        return aTime - bTime;
    });

    let holdingsBTC = 0;
    let basisUSD = 0;

    allEvents.forEach((event) => {
        const amount = event.amountBTC;
        if (amount > 0) {
            holdingsBTC += amount;
            basisUSD += (event.entryPrice ?? 0) * amount;
        } else if (amount < 0) {
            const amountAbs = Math.abs(amount);
            if (holdingsBTC <= 0 || basisUSD <= 0) {
                holdingsBTC -= amountAbs;
                basisUSD = Math.max(0, basisUSD - (event.entryPrice ?? 0) * amountAbs);
                return;
            }

            const holdingsBefore = holdingsBTC;
            const basisBefore = basisUSD;
            const proportion = amountAbs / holdingsBefore;
            const reduction = basisBefore * proportion;
            holdingsBTC = holdingsBefore - amountAbs;
            basisUSD = Math.max(0, basisBefore - reduction);
        }
    });

    const currentValue = holdingsBTC * currentPrice;
    const netProfit = currentValue - basisUSD;
    const percent = basisUSD ? (netProfit / basisUSD) * 100 : 0;

    const tradesBTC = tradeEvents.reduce(
        (sum, event) => sum + Math.max(0, event.amountBTC || 0),
        0
    );
    const receivedBTC = receiveEvents.reduce(
        (sum, event) => sum + Math.max(0, event.amountBTC || 0),
        0
    );
    const sentBTC = sendEvents.reduce(
        (sum, event) => sum + Math.abs(Math.min(0, event.amountBTC || 0)),
        0
    );

    const summary = {
        holdingsBTC,
        basisUSD,
        currentValue,
        netProfit,
        percent,
        breakdown: {
            tradesBTC,
            receivedBTC,
            sentBTC,
        },
    };

    log(
        `Built summary: holdings ${summary.holdingsBTC.toFixed(8)} BTC, ` +
        `current value ${formatUSD(summary.currentValue)}, basis ${formatUSD(summary.basisUSD)}, ` +
        `net profit ${formatUSD(summary.netProfit)} (${formatPercent(summary.percent)})`
    );
    log(
        `Breakdown -> trades: ${formatBTC(summary.breakdown.tradesBTC)}, ` +
        `received: ${formatBTC(summary.breakdown.receivedBTC)}, sent: ${formatBTC(summary.breakdown.sentBTC)}`
    );

    return summary;
};

// Display a banner above the table showing total value, profit, and holdings.
const insertTotalProfitBanner = (table, summary) => {
    document.getElementById("strike-profit-banner")?.remove();
    if (!table || !summary) return;

    const banner = document.createElement("div");
    banner.id = "strike-profit-banner";

    const valueDiv = document.createElement("div");
    valueDiv.style.marginBottom = "0.25em";
    valueDiv.textContent = "Total Value: ";
    const valueSpan = document.createElement("span");
    valueSpan.textContent = `${formatUSD(summary.currentValue)} (${formatBTC(summary.holdingsBTC)})`;
    valueDiv.appendChild(valueSpan);

    const costDiv = document.createElement("div");
    costDiv.style.marginBottom = "0.25em";
    costDiv.textContent = `Notional Cost: ${formatUSD(summary.basisUSD)}`;

    const profitDiv = document.createElement("div");
    profitDiv.textContent = "Net Profit: ";
    const profitSpan = document.createElement("span");
    profitSpan.textContent = `${formatUSD(summary.netProfit)} (${formatPercent(summary.percent)})`;
    profitSpan.style.color = summary.netProfit >= 0 ? "green" : "red";
    profitDiv.appendChild(profitSpan);

    const breakdownDiv = document.createElement("div");
    breakdownDiv.style.marginTop = "0.25em";
    breakdownDiv.style.fontSize = "0.95em";

    const makeLine = (text) => {
        const d = document.createElement("div");
        d.textContent = text;
        return d;
    };

    breakdownDiv.replaceChildren(
        makeLine(`Holdings Breakdown: Trades ${formatBTC(summary.breakdown.tradesBTC)}`),
        makeLine(` + Received ${formatBTC(summary.breakdown.receivedBTC)}`),
        makeLine(` - Sent ${formatBTC(summary.breakdown.sentBTC)}`)
    );

    banner.appendChild(valueDiv);
    banner.appendChild(costDiv);
    banner.appendChild(profitDiv);
    banner.appendChild(breakdownDiv);

    const parent = table.parentElement;
    parent?.insertBefore(banner, table);

    log(
        `Inserted profit banner: value ${formatUSD(summary.currentValue)} ` +
        `(${formatBTC(summary.holdingsBTC)}) | net ${formatUSD(summary.netProfit)} ` +
        `(${formatPercent(summary.percent)})`
    );
};

// Main entry point: gathers data across tabs, injects columns, and updates the
// profit banner when the Trading tab is visible.
const insertProfitColumns = async () => {
    if (!isTradingTabActive()) {
        debug("Trading tab not active; skipping profit refresh");
        return;
    }

    if (processingPromise) {
        debug("Profit refresh already running; waiting for existing work");
        return processingPromise;
    }

    const startTime =
        typeof performance !== "undefined" && performance.now
            ? performance.now()
            : Date.now();
    let originalTab = null;

    processingPromise = (async () => {
        originalTab = getActiveTab();
        log("Starting profit refresh cycle");

        let currentPrice;
        try {
            currentPrice = await fetchCurrentBTCPrice();
        } catch (error) {
            warn(error.message);
            return;
        }

        if (checkReceivingSending) {
            const receiveContext = await ensureTabTableReady("Receiving");
            receiveResult = receiveContext?.table
                ? await processTransferTable(receiveContext.table, "in", currentPrice)
                : { events: [], totalBTC: 0 };
            if (!receiveContext?.table) {
                debug("Receiving table unavailable; defaulting to zero inbound transfers");
            }

            const sendContext = await ensureTabTableReady("Sending");
            sendResult = sendContext?.table
                ? await processTransferTable(sendContext.table, "out", currentPrice)
                : { events: [], totalBTC: 0 };
            if (!sendContext?.table) {
                debug("Sending table unavailable; defaulting to zero outbound transfers");
            }
            checkReceivingSending = false;
        }

        const tradingContext = await ensureTabTableReady("Trading");
        if (!tradingContext?.table) {
            warn("Trading table unavailable; aborting profit rendering");
            return;
        }

        const tradingResult = await processTradingTable(tradingContext.table, currentPrice);

        const tradeEvents = tradingResult.events ?? [];
        const receiveEvents = receiveResult?.events ?? [];
        const sendEvents = sendResult?.events ?? [];

        log(
            `Event counts -> trades: ${tradeEvents.length}, received: ${receiveEvents.length}, sent: ${sendEvents.length}`
        );

        const summary = buildSummary(currentPrice, {
            tradeEvents,
            receiveEvents,
            sendEvents,
        });

        insertTotalProfitBanner(tradingContext.table, summary);
    })()
        .catch((error) => warn("Failed to insert profit columns:", error))
        .finally(async () => {
            const endTime =
                typeof performance !== "undefined" && performance.now
                    ? performance.now()
                    : Date.now();
            log(`Profit refresh cycle finished in ${Math.round(endTime - startTime)}ms`);

            if (originalTab && originalTab !== getActiveTab()) {
                debug("Restoring original tab selection after refresh");
                isProgrammaticNavigation = true;
                originalTab.click();
                await waitForCondition(
                    () => originalTab.getAttribute("aria-selected") === "true",
                    { timeout: 7000, interval: 150 }
                );
                isProgrammaticNavigation = false;
            }

            processingPromise = null;
        });

    return processingPromise;
};

// Re-inject columns when the Trading tab is clicked again.
const setupTabClickListener = () => {
    const tradingTab = findTabByName("Trading");
    if (!tradingTab) return;

    tradingTab.addEventListener("click", () => {
        if (isProgrammaticNavigation) return;
        debug("Trading tab clicked; scheduling profit refresh");
        setTimeout(() => insertProfitColumns(), 350);
    });
};

// Kick things off once the DOM is ready.
const start = () => {
    insertProfitColumns();
    setupTabClickListener();
    log("StrikeBTC Profit Tracker script loaded");
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
} else {
    start();
}
