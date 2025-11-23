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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
];

const pickUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

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
                    .replace(/[^a-z0-9\s-]/g, '')
                    .replace(/\s+/g, '-');
            }
            const baseUrl = `https://www.careerone.com.au/jobs/in-${locationSlug}`;
            const urlObj = new URL(baseUrl);
            if (kw) urlObj.searchParams.set('keywords', String(kw).trim());
            return urlObj.href;
        };

        // Prepare initial URLs
        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location));

        log.info('📍 Initial URLs prepared:', { urls: initial });

        // Setup proxy configuration
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        if (proxyConf) {
            log.info('🔐 Proxy configuration enabled');
        }

        // Tracking variables
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
                maxPoolSize: 60,
                sessionOptions: { maxUsageCount: 6 },
            },
            errorHandler({ error, session, log: crawlerLog }) {
                if (session && /403|429|blocked/i.test(error?.message || '')) {
                    crawlerLog.warning('?? Retiring session due to block error');
                    session.retire();
                }
            },
            autoscaledPoolOptions: {
                minConcurrency: 1,
                desiredConcurrency: 4,
                scaleUpStepRatio: 0.5,
                scaleDownStepRatio: 0.25,
            },
            maxRequestRetries: 5,
            requestHandlerTimeoutSecs: 90,
            maxConcurrency: 8,
            navigationTimeoutSecs: 60,
            blockedStatusCodes: [], // handle blocks manually to rotate session/proxy
            preNavigationHooks: [
                async ({ page, request, session }) => {
                    // Set up page before navigation to avoid detection
                    if (!session.userData.ua) session.userData.ua = pickUserAgent();
                    await page.setUserAgent(session.userData.ua);
                    
                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-US,en;q=0.9',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1',
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
                        
                        // Mock chrome object
                        window.chrome = {
                            runtime: {},
                        };
                        
                        // Mock permissions
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) => (
                            parameters.name === 'notifications' ?
                                Promise.resolve({ state: Notification.permission }) :
                                originalQuery(parameters)
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
                        '--disk-cache-size=0',
                    ],
                    defaultViewport: {
                        width: 1366,
                        height: 768,
                    },
                },
                useChrome: false,
            },

            async requestHandler({ request, page, enqueueLinks, log: crawlerLog, session, response }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;
                const requestStart = Date.now();

                crawlerLog.info(`[${label}] Page ${pageNo}: ${request.url}`);

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
                        
                        // Wait for job listings with multiple selectors
                        const selectors = [
                            'a[href*="/jobview/"]',
                            'article a[href*="/jobview/"]',
                            '[data-testid="job-card"] a',
                        ];
                        
                        let jobsFound = false;
                        for (const selector of selectors) {
                            try {
                                await page.waitForSelector(selector, { timeout: 10000 });
                                jobsFound = true;
                                crawlerLog.info(`✅ Jobs found using selector: ${selector}`);
                                break;
                            } catch (err) {
                                crawlerLog.warning(`⚠️ Selector failed: ${selector}`);
                            }
                        }

                        if (!jobsFound) {
                            crawlerLog.warning(`❌ No job listings found on page ${pageNo}`);
                            
                            if (debugMode) {
                                const screenshot = await page.screenshot({ fullPage: true });
                                await Actor.setValue(`debug-screenshot-page-${pageNo}.png`, screenshot, { contentType: 'image/png' });
                            }
                            return;
                        }

                        // Small delay for dynamic content to load
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
                            // Try to find next page button
                            const hasNextPage = await page.evaluate(() => {
                                // Look for "NEXT" button or pagination
                                const nextButton = 
                                    document.querySelector('a[rel="next"]') ||
                                    document.querySelector('button[aria-label="Next"]') ||
                                    Array.from(document.querySelectorAll('a')).find(
                                        (a) => /next|›|»/i.test(a.textContent)
                                    );
                                return !!nextButton;
                            });

                            if (hasNextPage) {
                                const nextPageUrl = new URL(request.url);
                                nextPageUrl.searchParams.set('page', String(pageNo + 1));

                                await enqueueLinks({
                                    urls: [nextPageUrl.href],
                                    userData: { label: 'LIST', pageNo: pageNo + 1 },
                                });
                                crawlerLog.info(`📄 Enqueued next page: ${pageNo + 1}`);
                            } else {
                                crawlerLog.info(`🏁 No more pages available after page ${pageNo}`);
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

                        stats.detailPages++;

                        // Wait for main content
                        try {
                            await page.waitForSelector('h1', { timeout: 15000 });
                        } catch (err) {
                            crawlerLog.warning('⚠️ H1 not found, trying alternative wait');
                            await sleep(1200);
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
                            title: jobData.title,
                            company: jobData.company,
                            category: category || null,
                            location: jobData.location,
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
                    crawlerLog.info(`⏱️ Request completed in ${requestTime}ms`);
                    
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
                        stack: error.stack,
                    });

                    if (debugMode) {
                        try {
                            const screenshot = await page.screenshot();
                            await Actor.setValue(
                                `error-screenshot-${Date.now()}.png`,
                                screenshot,
                                { contentType: 'image/png' }
                            );
                        } catch (screenshotErr) {
                            crawlerLog.warning('Failed to capture error screenshot');
                        }
                    }
                }
            },

            failedRequestHandler({ request, error }, err) {
                failed++;
                log.error(`❌ Request failed after retries: ${request.url}`, {
                    error: error || err?.message,
                    userData: request.userData,
                });
                stats.errors.push({
                    url: request.url,
                    error: (error || err)?.message,
                    type: 'failed_after_retries',
                });
            },
        });

        // Run the crawler
        await crawler.run(
            initial.map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            }))
        );

        // Final statistics
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        log.info('🏁 Scraping completed!', {
            duration: `${duration}s`,
            saved,
            failed,
            success_rate: `${((saved / (saved + failed)) * 100).toFixed(1)}%`,
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
