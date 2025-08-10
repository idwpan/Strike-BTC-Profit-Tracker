// Load the polyfill in Chrome MV3 service worker (importScripts exists there).
// In Firefox MV2 background scripts, the CI manifest injects the polyfill
// before this file, and importScripts is not defined (safe no-op).
try {
    if (typeof importScripts === "function") {
        importScripts("vendor/browser-polyfill.js");
    }
} catch (_) {
    // Ignore if not available (e.g., Firefox MV2 where the script is already loaded)
}

// Listen for messages sent from other parts of the extension (e.g. content scripts or popup)
browser.runtime.onMessage.addListener(async (message, sender) => {

    // Only handle messages requesting the BTC price
    if (message?.type !== "GET_BTC_PRICE") return;

    try {
        // Make the API request to fetch the latest BTC price from Coindesk
        const res = await fetch("https://data-api.coindesk.com/spot/v1/latest/tick?market=kraken&instruments=BTC-USD&apply_mapping=true");

        // Parse the JSON response
        const data = await res.json();

        // Use optional chaining and fallback to null if missing
        const price = data?.Data?.["BTC-USD"]?.PRICE ?? null;

        // Returning an object from an async onMessage listener sends it as the response
        return { price };
    } catch (error) {
        // Log the error for debugging
        console.error("Failed to fetch BTC price from background:", error);

        // Respond with an error flag
        return { error: true };
    }
});
