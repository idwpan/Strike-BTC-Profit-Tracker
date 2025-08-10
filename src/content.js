// Content script injected on the Strike transactions page. It adds profit
// information to the table using the current BTC/USD price fetched from the
// background script.

// The polyfill is listed before this file in the manifest, so `browser.*`
// APIs are available in both Chrome and Firefox.

// Parses BTC values from strings (removes ₿)
const parseBTC = (str) => parseFloat(str.replace(/[₿,]/g, ""));

// Parses USD values from strings (removes $)
const parseUSD = (str) => parseFloat(str.replace(/[$,]/g, ""));

// Column index used as a template for new cells (the "Sold" column).
const SOLD_COLUMN_INDEX = 2;

// Returns true if the "Trading" tab is currently active in the UI
const isTradingTabActive = () => {
    const activeTab = document.querySelector('button[aria-selected="true"]');
    return activeTab?.textContent.trim() === "Trading";
};

// Fetches current BTC price via extension background message, returns a Promise
const fetchCurrentBTCPrice = async () => {
    const response = await browser.runtime.sendMessage({ type: "GET_BTC_PRICE" });
    if (!response || response.error || response.price == null) {
        throw new Error("Failed to fetch BTC price from background");
    }
    return response.price;
};

// Inserts or updates a banner above the table showing total value, profit, and percent
const insertTotalProfitBanner = (price, rows) => {
    // Remove any existing banner to avoid duplicates
    document.getElementById("strike-profit-banner")?.remove();

    let totalInvested = 0;
    let totalBTC = 0;

    // Sum up all investment and BTC purchased across all rows
    rows.forEach(row => {
        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;

        const soldUSD = parseUSD(cells[2].innerText);
        const boughtBTC = parseBTC(cells[3].innerText);

        totalInvested += soldUSD;
        totalBTC += boughtBTC;
    });

    const currentValue = totalBTC * price;
    const netProfit = currentValue - totalInvested;
    const percent = (netProfit / totalInvested) * 100;

    // Create the banner HTML
    const banner = document.createElement("div");
    banner.id = "strike-profit-banner";

    const valueDiv = document.createElement("div");
    valueDiv.style.marginBottom = "0.25em";
    valueDiv.textContent = "Total Value: ";

    const valueSpan = document.createElement("span");
    valueSpan.textContent = `$${currentValue.toFixed(2)}`;
    valueDiv.appendChild(valueSpan);

    const profitDiv = document.createElement("div");
    profitDiv.textContent = "Net Profit: ";

    const profitSpan = document.createElement("span");
    profitSpan.textContent = `$${netProfit.toFixed(2)} (${percent.toFixed(2)}%)`;
    profitSpan.style.color = netProfit >= 0 ? "green" : "red";
    profitDiv.appendChild(profitSpan);

    banner.appendChild(valueDiv);
    banner.appendChild(profitDiv);

    // Insert the banner before the table
    const target = document.querySelector("table");
    target?.parentElement.insertBefore(banner, target);
};

// Appends new header cells with provided labels, cloning style from first <th>
const appendStyledHeaderCells = (headerRow, labels) => {
    const templateTH = headerRow.querySelector("th");
    if (!templateTH) return;

    labels.forEach(label => {
        const cloned = templateTH.cloneNode(true);
        const labelElem = cloned.querySelector("p") || cloned;

        // Replace text content
        if (labelElem) labelElem.textContent = label;

        headerRow.appendChild(cloned);
    });
};

// Appends new cells to a row using a template, populates with values and optional color
const appendStyledCells = (row, values) => {
    const templateTD = row.querySelectorAll("td")[SOLD_COLUMN_INDEX];
    if (!templateTD) return;

    values.forEach(({ text, color = null }) => {
        // Deep clone the TD
        const cloned = templateTD.cloneNode(true);

        // Attempt to find a nested <p> tag to replace text
        const p = cloned.querySelector("p");
        if (p) {
            p.textContent = text;
            if (color) p.style.color = color;
        } else {
            // Fallback if no <p> is present
            cloned.textContent = text;
            if (color) cloned.style.color = color;
        }

        row.appendChild(cloned);
    });
};

// Main logic: injects profit columns and banner if "Trading" tab is active and table present
const injectProfitColumns = async () => {
    if (!isTradingTabActive()) return;

    let price;
    try {
        price = await fetchCurrentBTCPrice();
    } catch (err) {
        console.warn(err.message);
        return;
    }

    const table = document.querySelector("table");
    const rows = table?.querySelectorAll("tbody tr");
    if (!table || !rows?.length) return;

    insertTotalProfitBanner(price, [...rows]);

    // Add new header columns only once
    const headerRow = table.querySelector("thead tr");
    if (headerRow && !headerRow.dataset.profitColumnsAdded) {
        appendStyledHeaderCells(headerRow, ["BTC Price ($)", "Profit ($)", "Profit (%)"]);
        headerRow.dataset.profitColumnsAdded = "true";
    }

    // Add profit columns for each data row
    rows.forEach((row) => {
        if (row.dataset.profitInjected) return;

        const cells = row.querySelectorAll("td");
        if (cells.length < 5) return;

        const soldUSD = parseUSD(cells[2].innerText);
        const boughtBTC = parseBTC(cells[3].innerText);
        const currentValueUSD = boughtBTC * price;
        const profit = currentValueUSD - soldUSD;
        const percent = (profit / soldUSD) * 100;
        const color = profit >= 0 ? "green" : "red";

        appendStyledCells(row, [
            { text: `$${price.toFixed(2)}` },
            { text: `$${profit.toFixed(2)}`, color },
            { text: `${percent.toFixed(2)}%`, color },
        ]);

        row.dataset.profitInjected = "true";
    });
};

// Sets up click event on "Trading" tab to re-inject columns after tab change/rerender
const setupTabClickListener = () => {
    const tradingTab = [...document.querySelectorAll('[role="tab"]')]
        .find((btn) => btn.textContent.trim() === "Trading");

    tradingTab?.addEventListener("click", () => {
        // Run a few attempts over time to allow for table render
        for (let i = 0; i < 5; i++) {
            setTimeout(injectProfitColumns, i * 1000);
        }
    });
};

// Run once the DOM is ready.
document.addEventListener("DOMContentLoaded", () => {
    injectProfitColumns();
    setupTabClickListener();
    console.log("StrikeBTC Profit Tracker script loaded");
});
