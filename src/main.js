// Careerone Jobs Scraper - Production-Ready Puppeteer Implementation
// Fast, stealthy, and robust scraping with comprehensive error handling

import { Actor, log } from 'apify';
import { PuppeteerCrawler, Dataset, sleep } from 'crawlee';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Configure stealth plugin with all evasion techniques
puppeteerExtra.use(StealthPlugin());

// Rotate user agents across sessions to avoid easy fingerprinting
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13.5; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

const pickUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Apify v3 supports top-level await
await Actor.init();

async function main() {
    const startTime = Date.now();

    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            category = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 10,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
            debugMode = false,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 100;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 10;

        // Configure log verbosity: debugMode -> DEBUG, otherwise INFO
        log.setLevel(debugMode ? log.LEVELS.DEBUG : log.LEVELS.INFO);

        log.info('🚀 Starting Careerone Jobs Scraper', {
            keyword,
            location,
            results_wanted: RESULTS_WANTED,
            max_pages: MAX_PAGES,
            collectDetails,
        });

        // Build start URL with proper formatting
        const buildStartUrl = (kw, loc) => {
            let locationSlug = 'australia';
            if (loc) {
                // Handle formats like "Sydney NSW" -> "sydney-nsw"
                locationSlug = String(loc)
                    .trim()
                    .toLowerCase()
                    .replace(/\s+,\s+/, ' ')
                    .replace(/\s+/g, '-')
                    .replace(/[^a-z0-9-]/g, '');
            }

            let baseUrl = `https://www.careerone.com.au/jobs/in-${locationSlug}`;
            const params = new URLSearchParams();

            if (kw) {
                params.set('keywords', kw.trim());
            }

            if (category) {
                params.set('category', String(category).trim());
            }

            const queryString = params.toString();
            if (queryString) baseUrl += `?${queryString}`;

            return baseUrl;
        };

        let initialUrls = [];

        // 1) Start URLs precedence: url > startUrl > startUrls > built from keyword/location
        if (url && typeof url === 'string') {
            initialUrls.push(url);
        } else if (startUrl && typeof startUrl === 'string') {
            initialUrls.push(startUrl);
        } else if (Array.isArray(startUrls) && startUrls.length > 0) {
            initialUrls = startUrls
                .filter((u) => typeof u === 'string' && u.trim())
                .map((u) => u.trim());
        } else {
            // Fallback: build URL from keyword + location
            const builtUrl = buildStartUrl(keyword, location);
            initialUrls.push(builtUrl);
        }

        // Deduplicate URLs
        initialUrls = [...new Set(initialUrls)];

        if (initialUrls.length === 0) {
            throw new Error('No valid start URLs were provided or could be constructed.');
        }

        log.info('📍 Initial URLs prepared:', { urls: initialUrls });

        // Configure proxy
        let proxyConf;
        if (proxyConfiguration) {
            proxyConf = await Actor.createProxyConfiguration(proxyConfiguration);
        } else {
            proxyConf = await Actor.createProxyConfiguration({});
        }

        if (proxyConf) {
            log.info('🔐 Proxy configuration enabled');
        } else {
            log.warning('⚠️ No proxy configuration available, you may be blocked quickly.');
        }

        // Global statistics
        let saved = 0;
        let failed = 0;
        const seenUrls = new Set();
        const stats = {
            listPages: 0,
            detailPages: 0,
            errors: [],
        };

        // Create Puppeteer crawler with optimized settings
        const crawler = new PuppeteerCrawler({
            proxyConfiguration: proxyConf,
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 30,
                sessionOptions: { maxUsageCount: 4 },
            },
            errorHandler(context, error) {
                const { session, log: crawlerLog } = context;
                if (session && /403|429|blocked/i.test(error?.message || '')) {
                    crawlerLog.warning('?? Retiring session due to block error');
                    session.retire();
                }
            },
            autoscaledPoolOptions: {
                minConcurrency: 1,
                desiredConcurrency: 4,
                scaleUpStepRatio: 0.7,
                scaleDownStepRatio: 0.25,
            },
            maxRequestRetries: 4,
            requestHandlerTimeoutSecs: 45,
            maxConcurrency: 6,
            navigationTimeoutSecs: 25,
            preNavigationHooks: [
                async ({ page, session }) => {
                    // Set up page before navigation to avoid detection
                    if (!session.userData.ua) session.userData.ua = pickUserAgent();
                    await page.setUserAgent(session.userData.ua);

                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1',
                        'Referer': 'https://www.careerone.com.au/',
                        'Sec-Fetch-Dest': 'document',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'none',
                        'Sec-Fetch-User': '?1',
                        'Pragma': 'no-cache',
                        'Cache-Control': 'no-cache',
                    });

                    // Additional stealth: hide webdriver property
                    await page.evaluateOnNewDocument(() => {
                        Object.defineProperty(navigator, 'webdriver', {
                            get: () => false,
                        });
                    });

                    // More stealth: mock languages, plugins, etc.
                    await page.evaluateOnNewDocument(() => {
                        Object.defineProperty(navigator, 'languages', {
                            get: () => ['en-US', 'en'],
                        });

                        Object.defineProperty(navigator, 'plugins', {
                            get: () => [1, 2, 3],
                        });
                    });

                    // Prevent detection via permissions
                    await page.evaluateOnNewDocument(() => {
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => (
                            parameters.name === 'notifications'
                                ? Promise.resolve({ state: Notification.permission })
                                : originalQuery(parameters)
                        );
                    });

                    // Block unnecessary resources for speed
                    await page.setRequestInterception(true);
                    page.on('request', (req) => {
                        const resourceType = req.resourceType();
                        // Block heavy assets while keeping layout-critical resources
                        if (['image', 'font', 'media'].includes(resourceType)) {
                            req.abort();
                        } else {
                            req.continue();
                        }
                    });
                },
            ],
            launchContext: {
                launcher: puppeteerExtra,
                launchOptions: {
                    headless: true,
                    ignoreHTTPSErrors: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--disable-blink-features=AutomationControlled',
                        // Performance optimizations
                        '--disable-extensions',
                        '--disable-background-networking',
                        '--disable-default-apps',
                        '--disable-sync',
                        '--metrics-recording-only',
                        '--mute-audio',
                        '--no-default-browser-check',
                        '--safebrowsing-disable-auto-update',
                        // Memory optimizations
                        '--disable-dev-shm-usage',
                    ],
                },
            },

            async requestHandler({ request, page, enqueueLinks, log: crawlerLog, session, response }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;
                const requestStart = Date.now();

                if (debugMode || label === 'LIST') {
                    crawlerLog.info(`[${label}] Page ${pageNo}: ${request.url}`);
                }

                if (label === 'LIST' && saved >= RESULTS_WANTED) {
                    crawlerLog.info(`🎯 Target already reached (${saved}/${RESULTS_WANTED}), skipping list page.`);
                    return;
                }

                try {
                    // If we land on a block page, retire the session and retry
                    const status = response?.status();
                    if (status === 403 || status === 429) {
                        crawlerLog.warning(`?? Detected block status ${status}, retiring session`);
                        session?.retire();
                        throw new Error(`Blocked with status ${status}`);
                    }

                    if (label === 'LIST') {
                        stats.listPages++;

                        // Small delay to allow page to paint
                        await sleep(1200);

                        // Basic heuristic to detect "blocked" content (captcha, "access denied")
                        const bodyText = await page.evaluate(() => document.body.innerText || '');
                        if (/access denied|forbidden|unusual traffic|captcha/i.test(bodyText)) {
                            crawlerLog.warning('⚠️ Possible block page detected by content, retiring session');
                            session?.retire();
                            throw new Error('Blocked by page content');
                        }

                        // Extra delay for dynamic content
                        await sleep(1000);

                        // Extract job links with deduplication
                        const jobLinks = await page.evaluate(() => {
                            const links = document.querySelectorAll('a[href*="/jobview/"]');
                            const uniqueLinks = new Set();

                            links.forEach((link) => {
                                const href = link.href;
                                if (href && href.includes('/jobview/')) {
                                    // Clean URL by removing query params
                                    const cleanUrl = href.split('?')[0];
                                    uniqueLinks.add(cleanUrl);
                                }
                            });

                            return Array.from(uniqueLinks);
                        });

                        crawlerLog.info(`📊 Found ${jobLinks.length} unique job links on page ${pageNo}`);

                        if (jobLinks.length === 0) {
                            crawlerLog.warning('⚠️ No job links extracted, possible page structure change');
                            if (debugMode) {
                                try {
                                    const screenshot = await page.screenshot({ fullPage: true });
                                    await Actor.setValue(`debug-screenshot-empty-list-page-${pageNo}.png`, screenshot, { contentType: 'image/png' });
                                } catch {
                                    // ignore screenshot errors
                                }
                            }
                            return;
                        }

                        // Process jobs based on collectDetails flag
                        if (collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            const toEnqueue = jobLinks
                                .slice(0, Math.max(0, remaining))
                                .filter((link) => !seenUrls.has(link));

                            toEnqueue.forEach((link) => seenUrls.add(link));

                            if (toEnqueue.length > 0) {
                                await enqueueLinks({
                                    urls: toEnqueue,
                                    userData: { label: 'DETAIL', fromPage: pageNo },
                                });
                                crawlerLog.info(`➕ Enqueued ${toEnqueue.length} job details`);
                            }
                        } else {
                            // Save URLs directly without details
                            const remaining = RESULTS_WANTED - saved;
                            const toPush = jobLinks
                                .slice(0, Math.max(0, remaining))
                                .filter((link) => !seenUrls.has(link));

                            toPush.forEach((link) => seenUrls.add(link));

                            if (toPush.length > 0) {
                                const items = toPush.map((u) => ({
                                    url: u,
                                    _source: 'careerone.com.au',
                                    _scraped_at: new Date().toISOString(),
                                }));

                                await Dataset.pushData(items);
                                saved += toPush.length;
                                crawlerLog.info(`💾 Saved ${toPush.length} job URLs (total: ${saved}/${RESULTS_WANTED})`);
                            }
                        }

                        // Handle pagination
                        if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                            // Try to read the actual "next page" href from the DOM
                            const nextPageHref = await page.evaluate(() => {
                                const candidates = [
                                    document.querySelector('a[rel="next"]'),
                                    document.querySelector('button[aria-label="Next"]'),
                                    Array.from(document.querySelectorAll('a')).find(
                                        (a) => /next|›|»/i.test((a.textContent || '').trim())
                                    ),
                                ].filter(Boolean);

                                const link = candidates[0];

                                // If it's an <a>, use its href; if it's only a button with JS handler, return null
                                if (!link) return null;
                                if (link.tagName.toLowerCase() === 'a' && link.href) {
                                    return link.href;
                                }

                                return null;
                            });

                            if (nextPageHref) {
                                await enqueueLinks({
                                    urls: [nextPageHref],
                                    userData: { label: 'LIST', pageNo: pageNo + 1 },
                                });
                                crawlerLog.info(`📄 Enqueued next page via href: ${nextPageHref}`);
                            } else {
                                // Fallback: conservative ?page= pagination if site supports it
                                try {
                                    const urlObj = new URL(request.url);
                                    urlObj.searchParams.set('page', String(pageNo + 1));
                                    const fallbackUrl = urlObj.href;

                                    if (fallbackUrl !== request.url) {
                                        await enqueueLinks({
                                            urls: [fallbackUrl],
                                            userData: { label: 'LIST', pageNo: pageNo + 1 },
                                        });
                                        crawlerLog.info(`📄 Enqueued next page via fallback URL: ${fallbackUrl}`);
                                    } else {
                                        crawlerLog.info(`🏁 No more pages available after page ${pageNo}`);
                                    }
                                } catch {
                                    crawlerLog.info(`🏁 No more pages available after page ${pageNo}`);
                                }
                            }
                        } else if (saved >= RESULTS_WANTED) {
                            crawlerLog.info(`🎯 Reached target: ${saved} jobs`);
                        } else if (pageNo >= MAX_PAGES) {
                            crawlerLog.info(`🛑 Reached max pages limit: ${MAX_PAGES}`);
                        }
                    }

                    if (label === 'DETAIL') {
                        if (saved >= RESULTS_WANTED) {
                            crawlerLog.info(`⏭️ Skipping, target reached: ${saved}/${RESULTS_WANTED}`);
                            return;
                        }

                        // Gentle throttling for detail pages to keep requests "one by one"
                        const jitter = 400 + Math.floor(Math.random() * 500);
                        await sleep(jitter);

                        stats.detailPages++;

                        // Wait for main content
                        try {
                            await page.waitForSelector('h1', { timeout: 15000 });
                        } catch (err) {
                            crawlerLog.warning('⚠️ H1 not found, trying alternative wait');
                            await sleep(1200);
                        }

                        // Additional content-based block detection
                        const detailBody = await page.evaluate(() => document.body.innerText || '');
                        if (/access denied|forbidden|unusual traffic|captcha/i.test(detailBody)) {
                            crawlerLog.warning('⚠️ Block detected on detail page, retiring session');
                            session?.retire();
                            throw new Error('Blocked detail page');
                        }

                        // Extract job details with multiple fallbacks
                        const jobData = await page.evaluate(() => {
                            // Helper function to clean text
                            const cleanText = (text) => text?.trim().replace(/\s+/g, ' ') || null;

                            // Title extraction with fallbacks
                            const title =
                                cleanText(document.querySelector('h1')?.textContent) ||
                                cleanText(document.querySelector('[data-testid="job-title"]')?.textContent) ||
                                cleanText(document.querySelector('.job-title')?.textContent) ||
                                null;

                            // Company extraction with fallbacks
                            const company =
                                cleanText(document.querySelector('h2 a')?.textContent) ||
                                cleanText(document.querySelector('[data-company]')?.textContent) ||
                                cleanText(document.querySelector('.company-name')?.textContent) ||
                                null;

                            // Location extraction
                            const locationLinks = document.querySelectorAll('h2 a');
                            const location =
                                cleanText(locationLinks[1]?.textContent) ||
                                cleanText(document.querySelector('[data-location]')?.textContent) ||
                                cleanText(document.querySelector('.location')?.textContent) ||
                                null;

                            // Salary extraction
                            const salary =
                                cleanText(document.querySelector('[class*="salary"]')?.textContent) ||
                                cleanText(document.querySelector('[data-salary]')?.textContent) ||
                                null;

                            // Date posted extraction
                            let datePosted = null;
                            const bodyText = document.body.textContent;
                            const datePatterns = [
                                /Date posted[:\s]*([^\n]+)/i,
                                /Posted[:\s]*(\d+[dhmyw]?\s*ago)/i,
                                /Posted[:\s]*([^\n]+)/i,
                            ];

                            for (const pattern of datePatterns) {
                                const match = bodyText.match(pattern);
                                if (match) {
                                    datePosted = cleanText(match[1]);
                                    break;
                                }
                            }

                            // Description extraction - get rich content
                            const descriptionElements = [];

                            // Try multiple selectors for description
                            const descContainers = [
                                document.querySelector('[class*="job-description"]'),
                                document.querySelector('[class*="description"]'),
                                document.querySelector('article'),
                                document.querySelector('main'),
                            ];

                            for (const container of descContainers) {
                                if (container) {
                                    const paragraphs = container.querySelectorAll('p, div, li');
                                    paragraphs.forEach((el) => {
                                        const text = el.textContent?.trim();
                                        if (text && text.length > 30) {
                                            descriptionElements.push(el.outerHTML);
                                        }
                                    });
                                    if (descriptionElements.length > 0) break;
                                }
                            }

                            // Fallback: get content after h2
                            if (descriptionElements.length === 0) {
                                const h2 = document.querySelector('h2');
                                if (h2) {
                                    let element = h2.nextElementSibling;
                                    let count = 0;
                                    while (element && count < 30) {
                                        const text = element.textContent?.trim();
                                        if (text && text.length > 30) {
                                            descriptionElements.push(element.outerHTML);
                                        }
                                        element = element.nextElementSibling;
                                        count++;
                                    }
                                }
                            }

                            const descriptionHtml = descriptionElements.join('\n') || null;
                            const descriptionText = descriptionElements
                                .map((html) => {
                                    const div = document.createElement('div');
                                    div.innerHTML = html;
                                    return div.textContent?.trim();
                                })
                                .join(' ')
                                .replace(/\s+/g, ' ')
                                .trim() || null;

                            return {
                                title,
                                company,
                                location,
                                salary,
                                datePosted,
                                descriptionHtml,
                                descriptionText,
                            };
                        });

                        // Validate data
                        if (!jobData.title) {
                            crawlerLog.warning('⚠️ No title found, data might be incomplete');
                        }

                        const item = {
                            site: 'Careerone',
                            keyword: keyword || null,
                            location: location || null,
                            category: category || null,
                            title: jobData.title,
                            company: jobData.company,
                            location_text: jobData.location,
                            salary: jobData.salary,
                            date_posted: jobData.datePosted,
                            description_html: jobData.descriptionHtml,
                            description_text: jobData.descriptionText,
                            url: request.url,
                            _source: 'careerone.com.au',
                            _scraped_at: new Date().toISOString(),
                        };

                        await Dataset.pushData(item);
                        saved++;

                        crawlerLog.info(
                            `✅ Saved: "${item.title}" at ${item.company} (${saved}/${RESULTS_WANTED})`
                        );
                    }

                    const requestTime = Date.now() - requestStart;
                    if (debugMode) {
                        crawlerLog.debug(`⏱️ Request completed in ${requestTime}ms`);
                    }
                } catch (error) {
                    failed++;
                    stats.errors.push({
                        url: request.url,
                        error: error.message,
                        label,
                        pageNo,
                    });
                    crawlerLog.error(`❌ Error processing ${label}: ${error.message}`, {
                        url: request.url,
                        label,
                        pageNo,
                    });

                    // Capture screenshot of error in debug mode
                    if (debugMode) {
                        try {
                            const screenshot = await page.screenshot({ fullPage: true });
                            await Actor.setValue(
                                `error-${label.toLowerCase()}-page-${pageNo}-${Date.now()}.png`,
                                screenshot,
                                { contentType: 'image/png' },
                            );
                        } catch {
                            crawlerLog.warning('Failed to capture error screenshot');
                        }
                    }
                }
            },

            failedRequestHandler({ request, log: crawlerLog }, error) {
                failed++;
                const message = error?.message || String(error || '');
                crawlerLog.error(`❌ Request failed after retries: ${request.url}`, {
                    error: message,
                    userData: request.userData,
                });
                stats.errors.push({
                    url: request.url,
                    error: message,
                    type: 'failed_after_retries',
                });
            },
        });

        // Run the crawler
        await crawler.run(
            initialUrls.map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            })),
        );

        const duration = (Date.now() - startTime) / 1000;
        log.info('🏁 Scraping completed!', {
            duration_seconds: duration.toFixed(1),
            saved,
            failed,
            list_pages: stats.listPages,
            detail_pages: stats.detailPages,
        });

        if (stats.errors.length > 0) {
            log.warning(`⚠️ ${stats.errors.length} errors occurred during scraping`);
            await Actor.setValue('errors.json', stats.errors);
        }

        if (saved === 0) {
            log.warning('⚠️ No jobs were saved. Please check the logs and selectors.');
        }
    } catch (error) {
        log.error('❌ Fatal error in main function:', {
            message: error.message,
            stack: error.stack,
        });
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    log.error('❌ Unhandled error:', err);
    console.error(err);
    process.exit(1);
});
