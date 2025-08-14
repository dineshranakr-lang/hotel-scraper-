// lowest_price_5star.js
//
// Usage examples:
//   node lowest_price_5star.js --city "Mumbai"
//   node lowest_price_5star.js --city "Paris" --checkin "2025-11-10"
//
// Requirements:
//   npm i
//   npx playwright install chromium

// Ensure Playwright and Commander are installed
(async () => {
  try {
    var { chromium, devices } = await import("playwright");
    var { Command } = await import("commander");
  } catch (e) {
    console.error("Missing dependencies. Please run: npm install playwright commander");
    process.exit(1);
  }

// ------------------------------
// Helpers
// ------------------------------
function fmtDate(d) {
  return d.toISOString().split("T")[0];
}

function withinThisYearFiveNights(checkinStr) {
  const now = new Date();
  const currentYear = now.getFullYear();

  if (checkinStr) {
    const inDate = new Date(checkinStr);
    const outDate = new Date(inDate.getTime() + 5 * 86400000);
    if (isNaN(inDate)) throw new Error("Invalid --checkin date (YYYY-MM-DD).");
    if (inDate <= now) throw new Error("Check-in must be in the future.");
    if (inDate.getFullYear() !== currentYear) {
      throw new Error(`Check-in must be within the current year ${currentYear}.`);
    }
    return [inDate, outDate];
  }

  // Auto-pick: at least 14 days from now, 5 nights, clamp to this year
  const earliest = new Date(now.getTime() + 14 * 86400000);
  // Prefer Monday start if possible
  const MON = 1;
  const daysUntilMon = (MON - earliest.getDay() + 7) % 7;
  let inDate = new Date(earliest.getTime() + daysUntilMon * 86400000);
  if (inDate.getFullYear() !== currentYear) {
    // fallback: Dec 10 (still leaves 5 nights to Dec 15)
    inDate = new Date(currentYear, 11, 10);
  }
  let outDate = new Date(inDate.getTime() + 5 * 86400000);

  const lastDay = new Date(currentYear, 11, 31); // Dec 31
  if (outDate > lastDay) {
    const shiftDays = Math.ceil((outDate - lastDay) / 86400000);
    inDate = new Date(inDate.getTime() - shiftDays * 86400000);
    outDate = new Date(outDate.getTime() - shiftDays * 86400000);
  }
  return [inDate, outDate];
}

function parseCurrencyPrice(text) {
  // Matches symbols or currency codes followed by numbers (₹, $, €, £, ¥, INR, USD, etc.)
  const re = /([₹$€£¥]|USD|EUR|GBP|JPY|INR)\s*([0-9][0-9,\.]*)/i;
  const m = text.match(re);
  if (!m) return null;
  return {
    currency: m[1],
    value: parseFloat(m[2].replace(/,/g, "")),
  };
}

// ------------------------------
// Core scraping
// ------------------------------
async function findLowestPrice({ city, checkin }) {
  const [dtIn, dtOut] = withinThisYearFiveNights(checkin);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  });
  const page = await context.newPage();

  // Google Hotels search URL
  const url = `https://www.google.com/travel/hotels/${encodeURIComponent(
    city
  )}?hl=en&checkin=${fmtDate(dtIn)}&checkout=${fmtDate(
    dtOut
  )}&adults=2&children=1&childrenAges=1`;

  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Try to accept cookie dialogs (varies by region)
  try {
    const accept = page.getByRole("button", { name: /Accept all|I agree|Accept/i });
    if (await accept.count()) await accept.first().click({ timeout: 2000 });
  } catch {}

  // Apply 5-star filter
  try {
    await page.getByRole("button", { name: /Filters|All filters/i }).click({ timeout: 6000 });
    await page.getByRole("button", { name: /5-star/i }).click({ timeout: 4000 });
    await page.getByRole("button", { name: /Done|Apply|Show results/i }).click({ timeout: 4000 });
  } catch {
    // UI may differ; continue anyway
  }

  // Sort by Top-rated / Rating
  try {
    await page.getByRole("button", { name: /Sort/i }).click({ timeout: 4000 });
    const menu = page.getByRole("menuitem", { name: /Top-rated|Rating high to low|Rating/i });
    if (await menu.count()) await menu.first().click({ timeout: 4000 });
  } catch {}

  // Click first hotel card that looks 5-star
  await page.waitForTimeout(1500);
  const fiveStarLink = page.getByRole("link").filter({ hasText: /5-star|★★★★★|5\s*stars/i });
  try {
    if (await fiveStarLink.count()) {
      await fiveStarLink.nth(0).click({ timeout: 6000 });
    } else {
      await page.getByRole("link").nth(0).click({ timeout: 6000 });
    }
  } catch (e) {
    await browser.close();
    throw new Error(`Could not open a hotel result for "${city}".`);
  }

  await page.waitForTimeout(2000);

  // Hotel meta
  let hotelName = "Unknown Hotel";
  let hotelRating = null;
  let hotelStars = 5;

  try {
    hotelName = (await page.getByRole("heading").first.innerText()).trim();
  } catch {}
  try {
    const ratingNode = page.locator("text=/\\b[0-9]\\.[0-9]\\b/");
    if (await ratingNode.count()) {
      const t = await ratingNode.first.innerText();
      const m = t.match(/([0-9]\.[0-9])/);
      if (m) hotelRating = parseFloat(m[1]);
    }
  } catch {}

  // Open price comparison panel if available
  try {
    const compareBtn = page.getByRole("button", {
      name: /Prices|Compare prices|View more rates|More prices/i,
    });
    if (await compareBtn.count()) await compareBtn.first().click({ timeout: 4000 });
  } catch {}

  await page.waitForTimeout(1500);

  // Scrape provider rows (provider name, price, and link if present)
  // Providers usually appear as rows or anchor items in the price pane
  const rows = page.locator('[role="row"], [data-provider], a[role="link"]');
  const rowsCount = Math.min((await rows.count()) || 0, 80);

  const providers = [];
  for (let i = 0; i < rowsCount; i++) {
    const row = rows.nth(i);
    let text;
    try {
      text = await row.innerText();
    } catch {
      continue;
    }
    if (!text) continue;

    const price = parseCurrencyPrice(text);
    if (!price) continue;

    // Try to extract provider name
    let providerName = text.split("\n")[0].trim();
    if (!providerName || providerName.length > 60) {
      for (const brand of [
        "Google",
        "Booking.com",
        "Expedia",
        "Agoda",
        "Hotels.com",
        "MakeMyTrip",
        "Trip.com",
        "Priceline",
        "Travelocity",
        "Cleartrip",
        "Goibibo",
        "Easemytrip",
      ]) {
        if (text.toLowerCase().includes(brand.toLowerCase())) {
          providerName = brand;
          break;
        }
      }
    }

    // Try to capture a click-out URL (if present)
    let href = null;
    try {
      const link = row.locator("a[href]").first;
      if (await link.count()) {
        href = await link.getAttribute("href");
        // Normalize relative URLs
        if (href && href.startsWith("/")) href = new URL(href, page.url()).toString();
      }
    } catch {}

    providers.push({
      provider: providerName || "Unknown",
      price_value: price.value,
      currency: price.currency,
      url: href,
      raw_text: text,
    });
  }

  // Deduplicate by provider (keep lowest)
  const byProvider = new Map();
  for (const p of providers) {
    const key = (p.provider || "Unknown").trim();
    if (!byProvider.has(key) || p.price_value < byProvider.get(key).price_value) {
      byProvider.set(key, p);
    }
  }
  const deduped = [...byProvider.values()];
  const lowest =
    deduped.length > 0
      ? deduped.reduce((min, p) => (p.price_value < min.price_value ? p : min), deduped[0])
      : null;

  await browser.close();

  return {
    query_city: city,
    checkin: fmtDate(dtIn),
    checkout: fmtDate(dtOut),
    nights: 5,
    guests: { adults: 2, infants: 1, infant_age: 1 },
    hotel: { name: hotelName, rating: hotelRating, stars: hotelStars, city },
    lowest,
    all_providers: deduped.sort((a, b) => a.price_value - b.price_value),
  };
}

// ------------------------------
// CLI
const program = new Command();
program.requiredOption("--city <city>", "City to search (e.g., 'Mumbai')");
program.option("--checkin <YYYY-MM-DD>", "Optional check-in date (must be this year & in future)");
program.parse(process.argv);

findLowestPrice({ city: program.opts().city, checkin: program.opts().checkin })
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error("ERROR:", err.message);
    process.exit(1);
  });

})(); // End of async IIFE
