// Background script: supplies the current BTC/USD price to content scripts
// by querying Coindesk.

// Attempt to load the WebExtension polyfill. Firefox loads it via the manifest,
// so a direct import there would throw and can be ignored.
try {
  importScripts("vendor/browser-polyfill.js");
} catch {
  // If the polyfill is already present (e.g. Firefox), ignore the failure.
}

// Endpoint that returns the latest BTC price from Coindesk.
const COINDESK_URL =
  "https://data-api.coindesk.com/spot/v1/latest/tick?market=kraken&instruments=BTC-USD&apply_mapping=true";

// Listen for requests from the content script.
browser.runtime.onMessage.addListener(async (message) => {
  // Ignore messages unrelated to price queries.
  if (message?.type !== "GET_BTC_PRICE") return;

  try {
    // Retrieve the latest BTC price from Coindesk.
    const response = await fetch(COINDESK_URL);
    const data = await response.json();

    // Use optional chaining and fallback to null if missing.
    const price = data?.Data?.["BTC-USD"]?.PRICE ?? null;

    // Return the price so the content script can display it.
    return { price };
  } catch (error) {
    console.error("Failed to fetch BTC price from background:", error);
    // Signal failure to the caller.
    return { error: true };
  }
});
