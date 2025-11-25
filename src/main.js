// Careerone Jobs Scraper - Production-ready Playwright implementation
// Optimized for speed, stealth, and reliability on Apify platform

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// ============================================================================
// CONFIGURATION
// ============================================================================

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

const BLOCKED_RESOURCES = ['image', 'stylesheet', 'font', 'media'];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const pickUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const randomDelay = (min = 500, max = 2000) => 
    new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));

const safeJsonParse = (txt) => {
    if (!txt) return null;
    try {
        return JSON.parse(txt);
    } catch {
        return null;
    }
};

const findJobPosting = (node) => {
    if (!node) return null;
    if (Array.isArray(node)) {
        for (const item of node) {
            const found = findJobPosting(item);
            if (found) return found;
        }
        return null;
    }
    if (typeof node === 'object') {
        const type = node['@type'];
        if (typeof type === 'string' && type.toLowerCase().includes('jobposting')) return node;
        if (Array.isArray(type) && type.some((t) => String(t).toLowerCase().includes('jobposting'))) return node;
        for (const val of Object.values(node)) {
            const found = findJobPosting(val);
            if (found) return found;
        }
    }
    return null;
};

const clean = (t) => (t ? t.trim().replace(/\s+/g, ' ') : null);

const buildStartUrl = (kw, loc, category) => {
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

// ============================================================================
// MAIN ACTOR
// ============================================================================

await Actor.init();

async function main() {
    const startTime = Date.now();

    try {
        // Get input configuration
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
            blockResources = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 100;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 10;

        log.setLevel(debugMode ? log.LEVELS.DEBUG : log.LEVELS.INFO);

        log.info('🚀 Starting Careerone Jobs Scraper', {
            keyword,
            location,
            results_wanted: RESULTS_WANTED,
            max_pages: MAX_PAGES,
            collectDetails,
            blockResources,
        });

        // Prepare initial URLs
        let initialUrls = [];
        if (typeof url === 'string' && url.trim()) {
            initialUrls.push(url.trim());
        } else if (typeof startUrl === 'string' && startUrl.trim()) {
            initialUrls.push(startUrl.trim());
        } else if (Array.isArray(startUrls) && startUrls.length > 0) {
            initialUrls = startUrls.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim());
        } else {
            initialUrls.push(buildStartUrl(keyword, location, category));
        }
        initialUrls = [...new Set(initialUrls)];

        if (!initialUrls.length) {
            throw new Error('No valid start URLs were provided or could be constructed.');
        }

        log.info('📍 Initial URLs:', { urls: initialUrls });

        // Proxy configuration
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration(proxyConfiguration)
            : await Actor.createProxyConfiguration({});

        if (proxyConf) log.info('🔐 Proxy configuration enabled');

        // Stats tracking
        let saved = 0;
        let failed = 0;
        const seenUrls = new Set();
        const stats = { listPages: 0, detailPages: 0, errors: [] };

        // Create crawler
        const crawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConf,

            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 10,
                sessionOptions: { maxUsageCount: 10 },
            },

            minConcurrency: 1,
            maxConcurrency: 3,
            maxRequestRetries: 3,
            navigationTimeoutSecs: 60,
            requestHandlerTimeoutSecs: 120,

            // Browser configuration for stealth
            launchContext: {
                launchOptions: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-blink-features=AutomationControlled',
                    ],
                },
            },

            // Pre-navigation hook for stealth and performance
            preNavigationHooks: [
                async ({ page, request }, gotoOptions) => {
                    // Set random viewport
                    const width = 1366 + Math.floor(Math.random() * 200);
                    const height = 768 + Math.floor(Math.random() * 200);
                    await page.setViewportSize({ width, height });

                    // Set random user agent
                    await page.setExtraHTTPHeaders({
                        'Accept-Language': 'en-AU,en;q=0.9',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    });

                    // Block unnecessary resources for speed
                    if (blockResources) {
                        await page.route('**/*', (route) => {
                            const resourceType = route.request().resourceType();
                            if (BLOCKED_RESOURCES.includes(resourceType)) {
                                route.abort();
                            } else {
                                route.continue();
                            }
                        });
                    }

                    // Stealth: Override navigator.webdriver
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        // Overwrite plugins
                        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                        // Overwrite languages
                        Object.defineProperty(navigator, 'languages', { get: () => ['en-AU', 'en'] });
                    });

                    if (debugMode) {
                        log.debug(`🌐 Navigating to: ${request.url}`);
                    }
                },
            ],

            // Main request handler
            async requestHandler({ request, page, enqueueLinks, session, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;
                const startedAt = Date.now();

                crawlerLog.info(`[${label}] Processing: ${request.url}`);

                try {
                    if (label === 'LIST') {
                        await handleListPage({
                            request, page, enqueueLinks, crawlerLog, pageNo,
                            saved, seenUrls, stats, RESULTS_WANTED, MAX_PAGES, collectDetails,
                            debugMode, keyword, location, category,
                            onSave: (count) => { saved += count; },
                        });
                    } else if (label === 'DETAIL') {
                        await handleDetailPage({
                            request, page, crawlerLog, stats, RESULTS_WANTED,
                            saved, debugMode, keyword, location, category,
                            onSave: () => { saved++; },
                        });
                    }
                } catch (err) {
                    crawlerLog.error(`Error handling ${label} page: ${err.message}`);
                    if (debugMode) {
                        await Actor.setValue(`error-${label}-${Date.now()}.html`, await page.content(), { contentType: 'text/html' });
                    }
                    throw err;
                }

                if (debugMode) {
                    const took = Date.now() - startedAt;
                    crawlerLog.debug(`⏱️ Processed in ${took}ms`);
                }
            },

            // Error handler
            failedRequestHandler({ request, log: crawlerLog }, error) {
                failed++;
                const message = error?.message || String(error || '');
                crawlerLog.error(`❌ Request failed: ${request.url}`, { error: message });
                stats.errors.push({ url: request.url, error: message, type: 'failed_after_retries' });
            },
        });

        // Helper function for LIST pages
        async function handleListPage({ request, page, enqueueLinks, crawlerLog, pageNo, saved, seenUrls, stats, RESULTS_WANTED, MAX_PAGES, collectDetails, debugMode, keyword, location, category, onSave }) {
            if (saved >= RESULTS_WANTED) {
                crawlerLog.info(`🎯 Target reached (${saved}/${RESULTS_WANTED}), skipping list page.`);
                return;
            }

            // Wait for page to fully load
            await page.waitForLoadState('domcontentloaded');
            
            // Add a small delay to let Vue/Nuxt hydrate
            await randomDelay(1000, 2000);

            // Wait for job cards to appear - try multiple selectors
            const jobSelectors = [
                'a[href*="/jobview/"]',
                '[data-job-id]',
                '.job-card',
                '[class*="job-listing"]',
                '[class*="JobCard"]',
            ];

            let foundSelector = null;
            for (const sel of jobSelectors) {
                try {
                    await page.waitForSelector(sel, { timeout: 10000 });
                    foundSelector = sel;
                    crawlerLog.info(`✅ Found jobs using selector: ${sel}`);
                    break;
                } catch {
                    continue;
                }
            }

            if (!foundSelector) {
                crawlerLog.warning('⚠️ Could not find job listings. Saving debug HTML...');
                await Actor.setValue(`debug-list-page-${pageNo}.html`, await page.content(), { contentType: 'text/html' });
                
                // Try scrolling to trigger lazy loading
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await randomDelay(2000, 3000);
                
                // Check again
                const hasJobs = await page.locator('a[href*="/jobview/"]').count();
                if (hasJobs === 0) {
                    crawlerLog.warning('No jobs found even after scroll. Site structure may have changed.');
                    return;
                }
            }

            stats.listPages++;

            // Extract job links
            const jobLinks = await page.evaluate(() => {
                const links = [];
                document.querySelectorAll('a[href*="/jobview/"]').forEach((el) => {
                    const href = el.getAttribute('href');
                    if (href) {
                        const fullUrl = href.startsWith('http') ? href : `https://www.careerone.com.au${href}`;
                        links.push(fullUrl.split('?')[0]);
                    }
                });
                return [...new Set(links)];
            });

            crawlerLog.info(`📊 Found ${jobLinks.length} job links on page ${pageNo}`);

            if (!jobLinks.length) {
                crawlerLog.warning('⚠️ No job links extracted.');
                return;
            }

            // Filter and enqueue
            const remaining = RESULTS_WANTED - saved;
            const newLinks = jobLinks.filter((link) => !seenUrls.has(link)).slice(0, remaining);
            newLinks.forEach((link) => seenUrls.add(link));

            if (collectDetails && newLinks.length) {
                await enqueueLinks({
                    urls: newLinks,
                    userData: { label: 'DETAIL', fromPage: pageNo },
                });
                crawlerLog.info(`➕ Enqueued ${newLinks.length} job details`);
            } else if (!collectDetails && newLinks.length) {
                const items = newLinks.map((u) => ({
                    url: u,
                    _source: 'careerone.com.au',
                    _scraped_at: new Date().toISOString(),
                }));
                await Dataset.pushData(items);
                onSave(newLinks.length);
                crawlerLog.info(`💾 Saved ${newLinks.length} job URLs (total: ${saved + newLinks.length}/${RESULTS_WANTED})`);
            }

            // Handle pagination
            if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                let nextUrl = null;

                // Try to find pagination
                const paginationSelectors = [
                    'a[rel="next"]',
                    'a:has-text("Next")',
                    'a:has-text("›")',
                    'a:has-text("»")',
                    '[class*="pagination"] a:last-child',
                ];

                for (const sel of paginationSelectors) {
                    try {
                        const nextEl = page.locator(sel).first();
                        const href = await nextEl.getAttribute('href');
                        if (href && !href.includes('javascript:')) {
                            nextUrl = href.startsWith('http') ? href : `https://www.careerone.com.au${href}`;
                            break;
                        }
                    } catch {
                        continue;
                    }
                }

                // Fallback: construct page URL
                if (!nextUrl) {
                    try {
                        const u = new URL(request.url);
                        u.searchParams.set('page', String(pageNo + 1));
                        nextUrl = u.href;
                    } catch {
                        // ignore
                    }
                }

                if (nextUrl && nextUrl !== request.url) {
                    await enqueueLinks({
                        urls: [nextUrl],
                        userData: { label: 'LIST', pageNo: pageNo + 1 },
                    });
                    crawlerLog.info(`📄 Enqueued next page: ${nextUrl}`);
                } else {
                    crawlerLog.info(`🏁 No more pages after page ${pageNo}`);
                }
            }
        }

        // Helper function for DETAIL pages
        async function handleDetailPage({ request, page, crawlerLog, stats, RESULTS_WANTED, saved, debugMode, keyword, location, category, onSave }) {
            if (saved >= RESULTS_WANTED) {
                crawlerLog.info(`⏭️ Skipping detail, target reached: ${saved}/${RESULTS_WANTED}`);
                return;
            }

            // Wait for content to load
            await page.waitForLoadState('domcontentloaded');
            await randomDelay(500, 1500);

            stats.detailPages++;

            // Extract job data
            let jobData = {
                title: null,
                company: null,
                location_text: null,
                salary: null,
                date_posted: null,
                description_html: null,
                description_text: null,
            };

            // Try JSON-LD first (most reliable)
            const jsonLdScript = await page.evaluate(() => {
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const script of scripts) {
                    try {
                        const data = JSON.parse(script.textContent);
                        if (data['@type'] === 'JobPosting' || (Array.isArray(data) && data.some(d => d['@type'] === 'JobPosting'))) {
                            return script.textContent;
                        }
                        if (data['@graph']) {
                            const job = data['@graph'].find(d => d['@type'] === 'JobPosting');
                            if (job) return JSON.stringify(job);
                        }
                    } catch {}
                }
                return null;
            });

            if (jsonLdScript) {
                const jobJson = findJobPosting(safeJsonParse(jsonLdScript));
                if (jobJson) {
                    jobData.title = jobJson.title || jobJson.name || null;
                    
                    if (jobJson.hiringOrganization) {
                        jobData.company = typeof jobJson.hiringOrganization === 'string' 
                            ? jobJson.hiringOrganization 
                            : (jobJson.hiringOrganization.name || jobJson.hiringOrganization.legalName);
                    }

                    if (jobJson.jobLocation) {
                        const loc = Array.isArray(jobJson.jobLocation) ? jobJson.jobLocation[0] : jobJson.jobLocation;
                        const addr = loc?.address || {};
                        jobData.location_text = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
                    }

                    if (jobJson.baseSalary) {
                        const bs = jobJson.baseSalary;
                        if (typeof bs === 'string') {
                            jobData.salary = bs;
                        } else {
                            const val = bs.value || {};
                            const parts = [];
                            if (val.minValue) parts.push(`$${val.minValue}`);
                            if (val.maxValue) parts.push(`$${val.maxValue}`);
                            if (bs.currency) parts.push(bs.currency);
                            if (val.unitText) parts.push(`per ${val.unitText.toLowerCase()}`);
                            jobData.salary = parts.join(' - ') || null;
                        }
                    }

                    jobData.date_posted = jobJson.datePosted || null;
                    jobData.description_html = jobJson.description || null;
                }
            }

            // Fallback: scrape from HTML
            if (!jobData.title) {
                jobData.title = clean(await page.locator('h1').first().textContent().catch(() => null));
            }

            if (!jobData.company) {
                const companySelectors = ['h2 a', '[class*="company"]', '[data-company]'];
                for (const sel of companySelectors) {
                    const text = await page.locator(sel).first().textContent().catch(() => null);
                    if (text) {
                        jobData.company = clean(text);
                        break;
                    }
                }
            }

            if (!jobData.location_text) {
                // Try to get location from page
                const locText = await page.evaluate(() => {
                    // Look for location near h2
                    const h2Links = document.querySelectorAll('h2 a');
                    if (h2Links.length > 1) {
                        return h2Links[1].textContent?.trim();
                    }
                    // Try other selectors
                    const locEl = document.querySelector('[class*="location"]') || 
                                  document.querySelector('[data-location]');
                    return locEl?.textContent?.trim() || null;
                });
                jobData.location_text = clean(locText);
            }

            if (!jobData.salary) {
                const salaryText = await page.evaluate(() => {
                    const salaryEl = document.querySelector('[class*="salary"]') ||
                                     document.querySelector('[data-salary]');
                    return salaryEl?.textContent?.trim() || null;
                });
                jobData.salary = clean(salaryText);
            }

            if (!jobData.date_posted) {
                const dateText = await page.evaluate(() => {
                    const text = document.body.innerText;
                    const match = text.match(/Date posted[:\s]*([^\n]+)/i) ||
                                  text.match(/Posted[:\s]*(\d+\s*\w+\s*ago)/i);
                    return match ? match[1].trim() : null;
                });
                jobData.date_posted = clean(dateText);
            }

            if (!jobData.description_html) {
                // Get description from page
                const descHtml = await page.evaluate(() => {
                    const selectors = [
                        '[class*="job-description"]',
                        '[class*="description"]',
                        'article',
                        'main'
                    ];
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el && el.innerHTML.length > 100) {
                            return el.innerHTML;
                        }
                    }
                    return null;
                });
                jobData.description_html = descHtml;
            }

            // Generate plain text from HTML
            if (jobData.description_html && !jobData.description_text) {
                const $ = cheerioLoad(`<div>${jobData.description_html}</div>`);
                jobData.description_text = clean($('div').text());
            }

            // Build final item
            const item = {
                site: 'Careerone',
                keyword: keyword || null,
                location: location || null,
                category: category || null,
                title: jobData.title,
                company: jobData.company,
                location_text: jobData.location_text,
                salary: jobData.salary,
                date_posted: jobData.date_posted,
                description_html: jobData.description_html,
                description_text: jobData.description_text,
                url: request.url,
                _source: 'careerone.com.au',
                _scraped_at: new Date().toISOString(),
            };

            await Dataset.pushData(item);
            onSave();

            crawlerLog.info(`✅ Saved: "${item.title}" at ${item.company} (${saved + 1}/${RESULTS_WANTED})`);
        }

        // Run the crawler
        await crawler.run(
            initialUrls.map((u) => ({
                url: u,
                userData: { label: 'LIST', pageNo: 1 },
            })),
        );

        // Final stats
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        log.info('🏁 Scraping completed!', {
            duration_seconds: duration,
            saved,
            failed,
            list_pages: stats.listPages,
            detail_pages: stats.detailPages,
        });

        if (stats.errors.length) {
            log.warning(`⚠️ ${stats.errors.length} errors occurred`);
            await Actor.setValue('errors.json', stats.errors);
        }

        if (!saved) {
            log.warning('⚠️ No jobs saved. Check debug HTML files in Key-value store.');
        }

    } catch (err) {
        log.error('❌ Fatal error:', { message: err.message, stack: err.stack });
        throw err;
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    log.error('❌ Unhandled error:', err);
    process.exit(1);
});
