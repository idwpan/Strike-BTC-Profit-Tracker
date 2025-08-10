// Runs on the Strike transactions page and augments the table with profit
// details using the latest BTC/USD price from the background script.

// The manifest loads the polyfill before this file, so `browser.*` APIs work in
// both Chrome and Firefox.

// Convert a string like "₿0.1" to a number
const parseBTC = (str) => parseFloat(str.replace(/[₿,]/g, ""));

// Convert a string like "$100" to a number
const parseUSD = (str) => parseFloat(str.replace(/[$,]/g, ""));

// Column index used as a template for new cells (the "Sold" column).
const SOLD_COLUMN_INDEX = 2;

// Check whether the Trading tab is currently active
const isTradingTabActive = () => {
    const activeTab = document.querySelector('button[aria-selected="true"]');
    return activeTab?.textContent.trim() === "Trading";
};

// Ask the background script for the current BTC price
const fetchCurrentBTCPrice = async () => {
    const response = await browser.runtime.sendMessage({ type: "GET_BTC_PRICE" });
    if (!response || response.error || response.price == null) {
        throw new Error("Failed to fetch BTC price from background");
    }
    return response.price;
};

// Display a banner above the table showing total value, profit, and percent
const insertTotalProfitBanner = (price, rows) => {
    // Remove any existing banner to prevent duplicates
    document.getElementById("strike-profit-banner")?.remove();

    let totalInvested = 0;
    let totalBTC = 0;

    // Accumulate USD invested and BTC purchased across rows
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

    // Build the banner markup
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

    // Place the banner before the table
    const target = document.querySelector("table");
    target?.parentElement.insertBefore(banner, target);
};

// Add header cells with provided labels, cloning style from the first <th>
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

// Add new cells to a row using a template, optionally applying a color
const appendStyledCells = (row, values) => {
    const templateTD = row.querySelectorAll("td")[SOLD_COLUMN_INDEX];
    if (!templateTD) return;

    values.forEach(({ text, color = null }) => {
        // Clone the template cell with its children
        const cloned = templateTD.cloneNode(true);

        // Replace text inside an inner <p> if present
        const p = cloned.querySelector("p");
        if (p) {
            p.textContent = text;
            if (color) p.style.color = color;
        } else {
            // Otherwise set text directly on the cell
            cloned.textContent = text;
            if (color) cloned.style.color = color;
        }

        row.appendChild(cloned);
    });
};

// Main entry point: inserts profit columns and banner when the Trading tab is visible
const insertProfitColumns = async () => {
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

    // Add header columns only once
    const headerRow = table.querySelector("thead tr");
    if (headerRow && !headerRow.dataset.profitColumnsAdded) {
        appendStyledHeaderCells(headerRow, ["BTC Price ($)", "Profit ($)", "Profit (%)"]);
        headerRow.dataset.profitColumnsAdded = "true";
    }

    // Append profit columns for each data row
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

// Re-inject columns when the Trading tab is clicked again
const setupTabClickListener = () => {
    const tradingTab = [...document.querySelectorAll('[role="tab"]')]
        .find((btn) => btn.textContent.trim() === "Trading");

    tradingTab?.addEventListener("click", () => {
        // Retry a few times to allow the table to render
        for (let i = 0; i < 5; i++) {
            setTimeout(insertProfitColumns, i * 1000);
        }
    });
};

// Kick things off once the DOM is ready
const start = () => {
    insertProfitColumns();
    setupTabClickListener();
    console.log("StrikeBTC Profit Tracker script loaded");
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
} else {
    start();
}
