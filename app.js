// Import necessary modules
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url"; // To get __dirname in ES modules
import fetch, { Headers } from "node-fetch"; // Import Headers if you need to set custom ones
import minimist from "minimist";
import * as cheerio from "cheerio"; // Import cheerio

// --- Configuration & Constants ---

// Determine the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration files
const INPUT_URL_LIST_FILE = path.join(__dirname, "source-urls.txt"); // Or your specific input file
const OUTPUT_CSV_FILE = path.join(__dirname, "url-results-with-content.csv"); // Updated output filename
const LOG_FILE = path.join(__dirname, "url-results-log.txt"); // Log filename

// Request Configuration
const REQUEST_DELAY_MS = 300; // Delay between requests
const REQUEST_TIMEOUT_MS = 20000; // Timeout for each request (increased slightly for content download)
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"; // Common browser user agent

const BATCH_RUN_ID = new Date().toISOString().replace(/[:.]/g, "-"); // Unique ID for batch run

// Content Extraction Configuration
const CONTENT_SELECTOR = "#qg-primary-content"; // CSS Selector for the main content DIV
const IGNORE_SELECTORS = [
  "#qg-page-options",
  "#qg-options",
  ".qg-content-footer",
];

// CSV Headers (Added mainContentText)
const CSV_HEADERS = [
  "row", // Overall row number
  "batchRunId", // Unique ID for this batch run
  "originalUrl",
  "finalUrl",
  "statusCode",
  "redirected", // boolean: true/false
  "contentType", // Content-Type header
  "isSWE",
  "mainContentText", // Extracted text content
  "bodyClasses",
  "meta_title",
  "meta_description",
  "meta_created",
  "meta_modified",
  "meta_assetid",
  "error", // To log fetch-specific errors
];

// --- Helper Functions ---

/**
 * Creates a delay for a specified duration.
 * @param {number} ms - The delay duration in milliseconds.
 * @returns {Promise<void>}
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses command line arguments for pagination.
 * @throws {Error} If required arguments (pagestart, pagesize) are missing or invalid.
 * @returns {{ pageStart: number, pageSize: number }} Parsed arguments.
 */
const parseCliArgs = () => {
  // (Function remains the same as before)
  const args = minimist(process.argv.slice(2));
  const pageStart = parseInt(args.pagestart, 10) || 0;
  const pageSize = parseInt(args.pagesize, 10) || 20;

  if (isNaN(pageStart) || pageStart < 0) {
    throw new Error(
      "Missing or invalid --pagestart argument. Must be a non-negative integer."
    );
  }
  if (isNaN(pageSize) || pageSize <= 0) {
    throw new Error(
      "Missing or invalid --pagesize argument. Must be a positive integer."
    );
  }
  return { pageStart, pageSize };
};

/**
 * Reads URLs from the specified input file.
 * @param {string} filePath - Path to the file containing URLs (one per line).
 * @throws {Error} If the file cannot be read.
 * @returns {string[]} Array of URLs.
 */
const loadUrlsFromFile = (filePath) => {
  // (Function remains the same as before)
  try {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return fileContent.split("\n").filter((line) => line.trim() !== "");
  } catch (error) {
    throw new Error(
      `Failed to read URL list file "${filePath}": ${error.message}`
    );
  }
};

/**
 * Fetches a URL, gets response info, and downloads body text for HTML content.
 * @param {string} url - The URL to fetch.
 * @returns {Promise<{ response: fetch.Response | null, bodyText: string | null, error?: Error }>}
 * An object containing the response, the body text (if HTML and status 200), and an optional error object.
 */
const fetchUrlData = async (url) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response = null;
  try {
    const headers = new Headers();
    headers.append("User-Agent", USER_AGENT);

    response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow", // Follow redirects automatically
      headers: headers,
    });

    // Check if fetch was successful AND content type is HTML before downloading body
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && contentType.startsWith("text/html")) {
      const bodyText = await response.text();
      return { response, bodyText, error: null };
    } else {
      // Response received, but not 200 OK or not HTML content
      // No need to download body text in this case
      return { response, bodyText: null, error: null };
    }
  } catch (error) {
    // Handles network errors, DNS errors, timeouts (AbortError)
    console.error(
      `\n❌ Fetch error for ${url}: ${error.name} - ${error.message}`
    );
    return { response: null, bodyText: null, error }; // Indicate failure
  } finally {
    clearTimeout(timeoutId); // Clear timeout always
  }
};

/**
 * Extracts text content from a specific element in an HTML string.
 * @param {string} htmlString - The HTML content as a string.
 * @param {string} selector - The CSS selector for the target element.
 * @returns {string} The extracted text content, or an empty string if not found/error.
 */
const extractContentText = (htmlString, selector, ignore_selectors) => {
  if (!htmlString || !selector) {
    return "";
  }
  try {
    const $ = cheerio.load(htmlString);
    const contentElement = $(selector);
    if (contentElement.length > 0) {
      //Remove ignored selectors
      ignore_selectors.forEach((ignoreSelector) => {
        contentElement.find(ignoreSelector).remove();
      });

      // Get text and clean it up slightly for CSV (remove excessive whitespace/newlines)
      let text = contentElement.text();
      text = text
        .replace(/\s\s+/g, " ")
        .replace(/(\r\n|\n|\r)/gm, " ")
        .trim(); // Replace newlines/multiple spaces with single space
      return text;
    } else {
      return "Content selector not found"; // Indicate the specific div wasn't present
    }
  } catch (error) {
    console.error(
      `Error parsing HTML or extracting content with Cheerio: ${error.message}`
    );
    return "Error during content extraction"; // Indicate a parsing error
  }
};

const extractBodyClasses = (htmlString) => {
  try {
    const $ = cheerio.load(htmlString);
    const bodyClasses = $("body").attr("class") || "";
    return bodyClasses;
  } catch (error) {
    console.error(
      `Error parsing HTML or extracting body classes with Cheerio: ${error.message}`
    );
  }
};

const extractContentMeta = (htmlString, fields) => {
  if (!htmlString || !fields) {
    return "";
  }

  try {
    const $ = cheerio.load(htmlString);
    let metaData = {};
    fields.forEach((field) => {
      const contentElement = $(`meta[name="${field}"]`);
      if (contentElement.length > 0) {
        metaData[field] = contentElement.attr("content");
      } else {
        metaData[field] = "Meta tag not found"; // Indicate the specific div wasn't present
      }
    });
    console.log(metaData);

    return metaData;
  } catch (error) {
    console.error(
      `Error parsing HTML or extracting content with Cheerio: ${error.message}`
    );
    return "Error during content extraction"; // Indicate a parsing error
  }
};

/**
 * Processes the fetch response and potentially extracts content.
 * @param {fetch.Response} response - The response object from fetch.
 * @param {string | null} bodyText - The downloaded HTML body text (or null).
 * @param {string} originalUrl - The URL that was initially requested.
 * @param {number} overallIndex - The 1-based overall row number from the original list.
 * @returns {object} A structured object containing the processed data for the CSV.
 */
const processHttpResponse = (response, bodyText, originalUrl, overallIndex) => {
  let extractedText = "";
  let bodyClasses = "";
  let extractedMetadata = {};
  let isSWE = "";

  // Only attempt extraction if we successfully got HTML body text
  if (bodyText) {
    extractedText = extractContentText(
      bodyText,
      CONTENT_SELECTOR,
      IGNORE_SELECTORS
    );

    bodyClasses = extractBodyClasses(bodyText);

    // Extract metadata
    extractedMetadata = extractContentMeta(bodyText, [
      "DCTERMS.title",
      "DCTERMS.description",
      "DCTERMS.created",
      "DCTERMS.modified",
      "matrix.id",
    ]);

    isSWE = bodyText.includes("qg-main.css") ? "Yes" : isSWE; //true or false
  } else if (
    response.ok &&
    (response.headers.get("content-type") || "").startsWith("text/html")
  ) {
    // Handle case where response was OK/HTML but bodyText is null (shouldn't happen with current fetch logic, but safe)
    extractedText = "Error reading response body";
  }

  return {
    row: overallIndex,
    batchRunId: BATCH_RUN_ID, // Unique ID for this batch run
    originalUrl: originalUrl,
    finalUrl: response.url, // URL after potential redirects
    statusCode: response.status,
    redirected: response.redirected,
    contentType: response.headers.get("content-type") || "", // Get Content-Type header
    isSWE: isSWE,
    mainContentText: extractedText, // Add extracted text
    bodyClasses: bodyClasses || "", // Add body classes if available
    meta_title: extractedMetadata["DCTERMS.title"],
    meta_description: extractedMetadata["DCTERMS.description"],
    meta_created: extractedMetadata["DCTERMS.created"],
    meta_modified: extractedMetadata["DCTERMS.modified"],
    meta_assetid: extractedMetadata["matrix.id"],
    error: "", // No fetch error
  };
};

/**
 * Formats a result object for URLs that encountered a fetch error (network, timeout, etc.).
 * @param {string} originalUrl - The URL that failed to fetch.
 * @param {Error} error - The error object caught during fetch.
 * @param {number} overallIndex - The 1-based overall row number from the original list.
 * @returns {object} A structured object representing the error row for the CSV.
 */
const formatFetchErrorResult = (originalUrl, error, overallIndex) => ({
  row: overallIndex,
  originalUrl: originalUrl,
  finalUrl: "",
  statusCode: "FETCH_ERROR", // Custom status for fetch errors
  redirected: "",
  contentType: "",
  mainContentText: "", // Add empty field for consistency
  error: `${error.name}: ${error.message}`, // Log the specific error
});

/**
 * Appends results to a CSV file. Creates the file with headers if it doesn't exist.
 * @param {object[]} results - An array of result objects.
 * @param {string} filePath - The path to the CSV file.
 * @param {string[]} headers - Array of header names in order.
 */
const appendResultsToCsv = (results, filePath, headers) => {
  // (Function remains largely the same, but improved escaping for text content)
  if (results.length === 0) {
    return;
  }

  const fileExists = fs.existsSync(filePath);
  let csvContent = "";

  if (!fileExists) {
    csvContent += headers.map((h) => `"${h}"`).join(",") + "\n";
  }

  csvContent += results
    .map((row) => {
      return headers
        .map((headerKey) => {
          const value = row[headerKey] ?? "";
          // Enhanced CSV escaping for quotes AND potential newlines within extracted text
          const escapedValue = String(value)
            .replace(/"/g, '""') // Escape double quotes
            .replace(/(\r\n|\n|\r)/gm, " "); // Replace newlines with spaces
          return `"${escapedValue}"`;
        })
        .join(",");
    })
    .join("\n");

  fs.appendFileSync(
    filePath,
    (fileExists && csvContent ? "\n" : "") + csvContent,
    "utf8"
  );
};

/**
 * Appends a message to the log file.
 * @param {string} message - The message to log.
 * @param {string} filePath - The path to the log file.
 */
const appendToLogFile = (message, filePath) => {
  // (Function remains the same as before)
  const timestamp = new Date().toISOString();
  fs.appendFileSync(filePath, `${timestamp}: ${message}\n`, "utf8");
};

// --- Main Execution ---

(async () => {
  try {
    // 1. Parse Command Line Arguments
    const { pageStart, pageSize } = parseCliArgs();

    // 2. Load URLs
    const allUrls = loadUrlsFromFile(INPUT_URL_LIST_FILE);
    const totalUrls = allUrls.length;

    // 3. Calculate Batch Slice
    const startIndex = Math.max(0, pageStart);
    const endIndex = Math.min(startIndex + pageSize, totalUrls);

    if (startIndex >= totalUrls) {
      console.warn(
        `\n⚠️ Start index (${startIndex}) is beyond the total number of URLs (${totalUrls}). Nothing to process.`
      );
      return;
    }

    const urlsToProcess = allUrls.slice(startIndex, endIndex);
    const actualCount = urlsToProcess.length;

    console.log(
      `\n🚀 Checking URLs ${
        startIndex + 1
      } to ${endIndex} (Batch size: ${actualCount} URLs) of ${totalUrls} total.`
    );
    console.log(
      `   Fetching HTML and extracting text from: ${CONTENT_SELECTOR}`
    );
    console.log(`   Input file: ${INPUT_URL_LIST_FILE}`);
    console.log(`   Output CSV: ${OUTPUT_CSV_FILE}`);
    console.log(`   Log file:   ${LOG_FILE}`);

    // 4. Process URL Batch
    const resultsBatch = [];
    for (let i = 0; i < actualCount; i++) {
      const originalUrl = urlsToProcess[i];
      const overallIndex = startIndex + i + 1; // 1-based overall index

      console.log(
        `\nProcessing ${overallIndex} of ${endIndex}, from ${totalUrls}.\nURLs: ${originalUrl}`
      );

      // Fetch data, including body text if applicable
      const { response, bodyText, error } = await fetchUrlData(originalUrl);

      let resultData;
      if (error) {
        // Fetch failed (network error, timeout, etc.)
        resultData = formatFetchErrorResult(originalUrl, error, overallIndex);
        console.error(`❌ Fetch failed: ${error.name}`);
      } else if (response) {
        // Fetch succeeded (even if status is not 200 OK), process the response
        resultData = processHttpResponse(
          response,
          bodyText,
          originalUrl,
          overallIndex
        ); // Pass bodyText here
        const redirectInfo = response.redirected
          ? ` (Redirected to: ${response.url})`
          : "";
        const contentInfo = bodyText
          ? ` (Content extracted)`
          : response.ok &&
            (response.headers.get("content-type") || "").startsWith("text/html")
          ? " (HTML body not read/processed)"
          : ""; // More info if bodyText is null
        console.log(
          `✅ Fetch successful: Status ${response.status}${redirectInfo}${contentInfo}`
        );
      } else {
        // Safeguard for unknown state
        console.error(`❌ Unknown error processing ${originalUrl}`);
        resultData = formatFetchErrorResult(
          originalUrl,
          new Error("Unknown processing error"),
          overallIndex
        );
      }

      resultsBatch.push(resultData);

      // Wait before the next request
      if (i < actualCount - 1) {
        await delay(REQUEST_DELAY_MS);
      }
    }

    // 5. Write Results to CSV
    if (resultsBatch.length > 0) {
      appendResultsToCsv(resultsBatch, OUTPUT_CSV_FILE, CSV_HEADERS);
      console.log(
        `\n💾 Appended ${resultsBatch.length} results to ${OUTPUT_CSV_FILE}`
      );
    } else {
      console.log("\n🤷 No results generated in this batch.");
    }

    // 6. Log Completion
    const logMessage = `Checked batch: URLs ${
      startIndex + 1
    } to ${endIndex} (${actualCount} URLs). Extracted content from ${CONTENT_SELECTOR}.`;
    appendToLogFile(logMessage, LOG_FILE);
    console.log(`\n📝 Logged completion to ${LOG_FILE}`);

    console.log("\n✨ Batch processing complete.");
  } catch (error) {
    console.error(
      "\n\n💥 An unexpected error occurred during script execution:"
    );
    console.error(error);
    try {
      appendToLogFile(
        `CRITICAL ERROR: ${error.message}\n${error.stack}`,
        LOG_FILE
      );
    } catch (logError) {
      console.error("Failed to write critical error to log file:", logError);
    }
    process.exit(1);
  }
})();
