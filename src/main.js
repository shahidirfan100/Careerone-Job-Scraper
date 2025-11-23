// Careerone Jobs Scraper - Production-Ready Puppeteer Implementation
// Tuned for speed, higher concurrency, and reduced blocking

import { Actor, log } from 'apify';
import { PuppeteerCrawler, Dataset, sleep } from 'crawlee';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Stealth + Puppeteer
puppeteerExtra.use(StealthPlugin());

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13.5; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
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

        // Logging
        log.setLevel(debugMode ? log.LEVELS.DEBUG : log.LEVELS.INFO);

        log.info('🚀 Starting Careerone Jobs Scraper', {
            keyword,
            location,
            results_wanted: RESULTS_WANTED,
            max_pages: MAX_PAGES,
            collectDetails,
        });

        // Build default start URL
        const buildStartUrl = (kw, loc) => {
            let locationSlug = 'australia';
            if (loc) {
                locationSlug = String(loc)
                    .trim()
                    .toLowerCase()
                    .replace(/\s+,\s+/, ' ')
                    .replace(/\s+/g, '-')
                    .replace(/[^a-z0-9-]/g, '');
            }

            let baseUrl = `https://www.careerone.com.au/jobs/in-${locationSlug}`;
            const params = new URLSearchParams();

            if (kw) params.set('keywords', kw.trim());
            if (category) params.set('category', String(category).trim());

            const qs = params.toString();
            if (qs) baseUrl += `?${qs}`;

            return baseUrl;
        };

        // Prepare initial URLs (priority: url > startUrl > startUrls > built)
        let initialUrls = [];

        if (typeof url === 'string' && url.trim()) {
            initialUrls.push(url.trim());
        } else if (typeof startUrl === 'string' && startUrl.trim()) {
            initialUrls.push(startUrl.trim());
        } else if (Array.isArray(startUrls) && startUrls.length > 0) {
            initialUrls = startUrls
                .filter((u) => typeof u === 'string' && u.trim())
                .map((u) => u.trim());
        } else {
            initialUrls.push(buildStartUrl(keyword, location));
        }

        // Deduplicate
        initialUrls = [...new Set(initialUrls)];

        if (!initialUrls.length) {
            throw new Error('No valid start URLs were provided or could be constructed.');
        }

        log.info('📍 Initial URLs prepared:', { urls: initialUrls });

        // Proxy
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : await Actor.createProxyConfiguration({});

        if (proxyConf) log.info('🔐 Proxy configuration enabled');

        // Stats
        let saved = 0;
        let failed = 0;
        const seenUrls = new Set();
        const stats = {
            listPages: 0,
            detailPages: 0,
            errors: [],
        };

        const crawler = new PuppeteerCrawler({
            proxyConfiguration: proxyConf,

            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 30,
                sessionOptions: { maxUsageCount: 4 },
            },

            // Key: let autoscaler be more aggressive on concurrency
            autoscaledPoolOptions: {
                minConcurrency: 2,
                maxConcurrency: 8,
                // Loosen CPU/memory thresholds so we don't stay stuck at 1
                systemStatusOptions: {
                    maxCpuOverloadedRatio: 0.9,
                    maxMemoryOverloadedRatio: 0.8,
                    maxEventLoopOverloadedRatio: 0.9,
                    maxClientOverloadedRatio: 0.9,
                },
            },

            // Also set aliases directly
            minConcurrency: 2,
            maxConcurrency: 8,

            maxRequestRetries: 4,
            requestHandlerTimeoutSecs: 45,
            navigationTimeoutSecs: 30,

            // Handle block-style errors (Crawlee v3 signature)
            errorHandler(context, error) {
                const { session, log: crawlerLog } = context;
                if (session && /403|429|blocked/i.test(error?.message || '')) {
                    crawlerLog.warning('?? Retiring session due to block error');
                    session.retire();
                }
            },

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
                        '--disable-extensions',
                        '--disable-background-networking',
                        '--disable-default-apps',
                        '--disable-sync',
                        '--metrics-recording-only',
                        '--mute-audio',
                        '--no-default-browser-check',
                        '--safebrowsing-disable-auto-update',
                    ],
                },
            },

            preNavigationHooks: [
                async ({ page, session }) => {
                    // Lightweight, realistic browser profile
                    if (!session.userData.ua) session.userData.ua = pickUserAgent();
                    await page.setUserAgent(session.userData.ua);

                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-US,en;q=0.9',
                    });

                    // Block heavy resources to reduce CPU & speed up
                    if (!page._requestInterception) {
                        await page.setRequestInterception(true);
                        page.on('request', (req) => {
                            const type = req.resourceType();
                            if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
                                req.abort();
                            } else {
                                req.continue();
                            }
                        });
                    }
                },
            ],

            async requestHandler({ request, page, enqueueLinks, log: crawlerLog, session, response }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;
                const startedAt = Date.now();

                if (label === 'LIST' || debugMode) {
                    crawlerLog.info(`[${label}] Page ${pageNo}: ${request.url}`);
                }

                if (label === 'LIST' && saved >= RESULTS_WANTED) {
                    crawlerLog.info(`🎯 Target already reached (${saved}/${RESULTS_WANTED}), skipping list page.`);
                    return;
                }

                try {
                    const status = response?.status();
                    if (status === 403 || status === 429) {
                        // Let autoscaler rotate sessions, but don't overreact
                        crawlerLog.warning(`?? Detected HTTP ${status} on ${label}, retiring session`);
                        session?.retire();
                        throw new Error(`Blocked with status ${status}`);
                    }

                    if (label === 'LIST') {
                        stats.listPages++;

                        // Wait for job cards quickly; no giant scroll loops
                        const jobSelector = 'a[href*="/jobview/"]';
                        await page.waitForSelector(jobSelector, { timeout: 15000 }).catch(() => null);

                        // Small, bounded scroll to trigger lazy-loaded bits
                        await page.evaluate(async () => {
                            const wait = (ms) => new Promise((res) => setTimeout(res, ms));
                            for (let i = 0; i < 5; i++) {
                                window.scrollBy(0, 800);
                                await wait(200);
                            }
                        });

                        // One small extra wait for JS finishing
                        await sleep(500);

                        // Extract job links
                        const jobLinks = await page.evaluate(() => {
                            const anchors = document.querySelectorAll('a[href*="/jobview/"]');
                            const out = new Set();
                            anchors.forEach((a) => {
                                if (!a.href) return;
                                const href = a.href.split('?')[0];
                                if (href.includes('/jobview/')) out.add(href);
                            });
                            return Array.from(out);
                        });

                        crawlerLog.info(`📊 Found ${jobLinks.length} unique job links on page ${pageNo}`);

                        if (!jobLinks.length) {
                            crawlerLog.warning('⚠️ No job links extracted, possible layout change or block.');
                            if (debugMode) {
                                try {
                                    const screenshot = await page.screenshot({ fullPage: true });
                                    await Actor.setValue(
                                        `debug-empty-list-page-${pageNo}.png`,
                                        screenshot,
                                        { contentType: 'image/png' },
                                    );
                                } catch {
                                    // ignore
                                }
                            }
                            return;
                        }

                        if (collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            const toEnqueue = jobLinks
                                .slice(0, Math.max(0, remaining))
                                .filter((link) => !seenUrls.has(link));

                            toEnqueue.forEach((link) => seenUrls.add(link));

                            if (toEnqueue.length) {
                                await enqueueLinks({
                                    urls: toEnqueue,
                                    userData: { label: 'DETAIL', fromPage: pageNo },
                                });
                                crawlerLog.info(`➕ Enqueued ${toEnqueue.length} job details`);
                            }
                        } else {
                            const remaining = RESULTS_WANTED - saved;
                            const toPush = jobLinks
                                .slice(0, Math.max(0, remaining))
                                .filter((link) => !seenUrls.has(link));

                            toPush.forEach((link) => seenUrls.add(link));

                            if (toPush.length) {
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

                        // Pagination
                        if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                            const nextPageHref = await page.evaluate(() => {
                                const link =
                                    document.querySelector('a[rel="next"]') ||
                                    Array.from(document.querySelectorAll('a')).find((a) =>
                                        /next|›|»/i.test((a.textContent || '').trim()),
                                    );
                                if (link && link.tagName.toLowerCase() === 'a' && link.href) {
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
                                // Fallback: ?page=N, only if it actually changes URL
                                try {
                                    const u = new URL(request.url);
                                    u.searchParams.set('page', String(pageNo + 1));
                                    const fallbackUrl = u.href;
                                    if (fallbackUrl !== request.url) {
                                        await enqueueLinks({
                                            urls: [fallbackUrl],
                                            userData: { label: 'LIST', pageNo: pageNo + 1 },
                                        });
                                        crawlerLog.info(`📄 Enqueued next page via fallback URL: ${fallbackUrl}`);
                                    } else {
                                        crawlerLog.info(`🏁 No more pages after page ${pageNo}`);
                                    }
                                } catch {
                                    crawlerLog.info(`🏁 No more pages after page ${pageNo}`);
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
                            crawlerLog.info(`⏭️ Skipping detail, target reached: ${saved}/${RESULTS_WANTED}`);
                            return;
                        }

                        // Tiny jitter to avoid hammering exact intervals
                        await sleep(80 + Math.floor(Math.random() * 120));
                        stats.detailPages++;

                        // Wait main title quickly
                        await page.waitForSelector('h1', { timeout: 10000 }).catch(() => null);

                        const jobData = await page.evaluate(() => {
                            const cleanText = (t) => (t ? t.trim().replace(/\s+/g, ' ') : null);

                            const title =
                                cleanText(document.querySelector('h1')?.textContent) ||
                                cleanText(document.querySelector('[data-testid="job-title"]')?.textContent) ||
                                cleanText(document.querySelector('.job-title')?.textContent) ||
                                null;

                            const company =
                                cleanText(document.querySelector('h2 a')?.textContent) ||
                                cleanText(document.querySelector('[data-company]')?.textContent) ||
                                cleanText(document.querySelector('.company-name')?.textContent) ||
                                null;

                            const locationLinks = document.querySelectorAll('h2 a');
                            const location =
                                cleanText(locationLinks[1]?.textContent) ||
                                cleanText(document.querySelector('[data-location]')?.textContent) ||
                                cleanText(document.querySelector('.location')?.textContent) ||
                                null;

                            const salary =
                                cleanText(document.querySelector('[class*="salary"]')?.textContent) ||
                                cleanText(document.querySelector('[data-salary]')?.textContent) ||
                                null;

                            let datePosted = null;
                            const bodyText = document.body.textContent || '';
                            const patterns = [
                                /Date posted[:\s]*([^\n]+)/i,
                                /Posted[:\s]*(\d+[dhmyw]?\s*ago)/i,
                                /Posted[:\s]*([^\n]+)/i,
                            ];
                            for (const p of patterns) {
                                const m = bodyText.match(p);
                                if (m) {
                                    datePosted = cleanText(m[1]);
                                    break;
                                }
                            }

                            // Short, bounded description grab
                            const descriptionElements = [];
                            const containers = [
                                document.querySelector('[class*="job-description"]'),
                                document.querySelector('[class*="description"]'),
                                document.querySelector('article'),
                                document.querySelector('main'),
                            ];
                            for (const c of containers) {
                                if (!c) continue;
                                const els = c.querySelectorAll('p, div, li');
                                for (const el of els) {
                                    const text = el.textContent?.trim();
                                    if (text && text.length > 30) {
                                        descriptionElements.push(el.outerHTML);
                                        if (descriptionElements.length >= 80) break;
                                    }
                                }
                                if (descriptionElements.length) break;
                            }

                            const descriptionHtml = descriptionElements.join('\n') || null;
                            const descriptionText =
                                descriptionElements
                                    .map((html) => {
                                        const d = document.createElement('div');
                                        d.innerHTML = html;
                                        return d.textContent?.trim() || '';
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

                        if (!jobData.title) {
                            crawlerLog.warning('⚠️ No title found on detail page (possible layout change).');
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
                            `✅ Saved: "${item.title}" at ${item.company} (${saved}/${RESULTS_WANTED})`,
                        );
                    }

                    if (debugMode) {
                        const took = Date.now() - startedAt;
                        crawlerLog.debug(`⏱️ ${label} ${pageNo} completed in ${took}ms`);
                    }
                } catch (err) {
                    failed++;
                    stats.errors.push({
                        url: request.url,
                        error: err.message,
                        label,
                        pageNo,
                    });

                    crawlerLog.error(`❌ Error processing ${label}: ${err.message}`, {
                        url: request.url,
                        label,
                        pageNo,
                    });

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

        await crawler.run(
            initialUrls.map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            })),
        );

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        log.info('🏁 Scraping completed!', {
            duration_seconds: duration,
            saved,
            failed,
            list_pages: stats.listPages,
            detail_pages: stats.detailPages,
        });

        if (stats.errors.length) {
            log.warning(`⚠️ ${stats.errors.length} errors occurred during scraping`);
            await Actor.setValue('errors.json', stats.errors);
        }

        if (!saved) {
            log.warning('⚠️ No jobs were saved. Please check the logs and selectors.');
        }
    } catch (err) {
        log.error('❌ Fatal error in main():', { message: err.message, stack: err.stack });
        throw err;
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    log.error('❌ Unhandled error:', err);
    process.exit(1);
});
