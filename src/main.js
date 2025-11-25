// Careerone Jobs Scraper - Production-grade Apify Actor
// Optimized for speed, stealth, and full job description extraction

import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset, RequestQueue } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';

// ============================================================================
// CONFIGURATION - Production optimized
// ============================================================================

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

// Block heavy resources but keep scripts (needed for Vue/Nuxt)
const BLOCKED_RESOURCES = ['image', 'media', 'font'];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const pickUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

const randomDelay = (min = 100, max = 500) => 
    new Promise(resolve => setTimeout(resolve, min + Math.random() * (max - min)));

const clean = (t) => (t ? t.trim().replace(/\s+/g, ' ') : null);

const buildStartUrl = (kw, loc, category) => {
    let locationSlug = 'australia';
    if (loc) {
        locationSlug = String(loc).trim().toLowerCase()
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
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            category = '',
            results_wanted: RESULTS_WANTED_RAW = 10,
            max_pages: MAX_PAGES_RAW = 5,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
            debugMode = false,
            dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 10;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 5;

        log.setLevel(debugMode ? log.LEVELS.DEBUG : log.LEVELS.INFO);

        log.info('🚀 Starting Careerone Jobs Scraper (Production)', {
            keyword, location, results_wanted: RESULTS_WANTED, max_pages: MAX_PAGES, collectDetails,
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

        log.info('📍 Initial URLs:', { urls: initialUrls });

        // Proxy configuration - use residential for best results
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration(proxyConfiguration)
            : await Actor.createProxyConfiguration({ useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] });

        if (proxyConf) log.info('🔐 Proxy enabled');

        // Stats
        let saved = 0;
        let failed = 0;
        const seenUrls = new Set();
        const stats = { listPages: 0, detailPages: 0, errors: [], blocked: 0 };

        // Create request queue for better control
        const requestQueue = await RequestQueue.open();

        // Create crawler with production settings
        const crawler = new PlaywrightCrawler({
            requestQueue,
            proxyConfiguration: proxyConf,

            // Session pool for stealth
            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 30,
                sessionOptions: { maxUsageCount: 40 },
            },
            persistCookiesPerSession: true,

            // Faster throughput
            minConcurrency: 4,
            maxConcurrency: 12,
            
            // Retry settings
            maxRequestRetries: 3,
            
            // Timeouts tuned for slower pages
            navigationTimeoutSecs: 35,
            requestHandlerTimeoutSecs: 70,

            // Browser launch - optimized for Apify
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
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process',
                    ],
                },
            },

            // Autoscaling for high throughput
            autoscaledPoolOptions: {
                desiredConcurrency: 8,
                minConcurrency: 4,
                maxConcurrency: 12,
                scaleUpStepRatio: 0.3,
                scaleDownStepRatio: 0.15,
            },

            // Pre-navigation hooks for stealth
            preNavigationHooks: [
                async ({ page, request, session }) => {
                    // Random viewport
                    const width = 1200 + Math.floor(Math.random() * 300);
                    const height = 720 + Math.floor(Math.random() * 240);
                    await page.setViewportSize({ width, height });

                    const ua = pickUserAgent();
                    const ref = request.userData?.referrer || 'https://www.google.com/';

                    // Headers
                    await page.setExtraHTTPHeaders({
                        'user-agent': ua,
                        'Accept-Language': 'en-AU,en-GB;q=0.9,en;q=0.8',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"',
                        'sec-fetch-dest': 'document',
                        'sec-fetch-mode': 'navigate',
                        'sec-fetch-site': 'none',
                        'sec-fetch-user': '?1',
                        'upgrade-insecure-requests': '1',
                        'referer': ref,
                    });

                    // Block heavy resources
                    await page.route('**/*', (route) => {
                        const type = route.request().resourceType();
                        const url = route.request().url();
                        
                        // Block images, fonts, media, and tracking
                        if (BLOCKED_RESOURCES.includes(type) || 
                            url.includes('analytics') || 
                            url.includes('tracking') ||
                            url.includes('facebook') ||
                            url.includes('google-analytics') ||
                            url.includes('gtm.js')) {
                            route.abort();
                        } else {
                            route.continue();
                        }
                    });

                    // Stealth scripts
                    await page.addInitScript(() => {
                        // Hide webdriver
                        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                        
                        // Chrome runtime
                        window.chrome = { runtime: {} };
                        
                        // Permissions
                        const originalQuery = window.navigator.permissions.query;
                        window.navigator.permissions.query = (parameters) =>
                            parameters.name === 'notifications'
                                ? Promise.resolve({ state: Notification.permission })
                                : originalQuery(parameters);
                        
                        // Plugins
                        Object.defineProperty(navigator, 'plugins', {
                            get: () => [1, 2, 3, 4, 5],
                        });
                        
                        // Languages
                        Object.defineProperty(navigator, 'languages', {
                            get: () => ['en-AU', 'en-GB', 'en'],
                        });

                        // Hardware hints
                        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
                        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
                        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
                        Object.defineProperty(navigator, 'language', { get: () => 'en-AU' });
                    });

                    // Light jitter to reduce concurrency spikes
                    await randomDelay(50, 200);

                    // Track referrer chain for detail pages
                    if (request.userData?.fromPageUrl) {
                        request.userData.referrer = request.userData.fromPageUrl;
                    }

                    // Reset blocked sessions quickly
                    session?.markGood();
                },
            ],

            // Post-navigation hook
            postNavigationHooks: [
                async ({ page, session }) => {
                    // Small delay after navigation for JS to execute
                    await page.waitForTimeout(250 + Math.random() * 200);

                    // If page clearly blocked, retire session early
                    const title = await page.title().catch(() => '');
                    if (title.toLowerCase().includes('access denied') || title.toLowerCase().includes('forbidden')) {
                        session?.retire();
                    }
                },
            ],

            // Main request handler
            async requestHandler({ request, page, session, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // Check for blocks
                const url = page.url();
                const pageTitle = await page.title().catch(() => '');
                if (url.includes('blocked') || url.includes('captcha') || url.includes('challenge') || pageTitle.toLowerCase().includes('access denied')) {
                    stats.blocked++;
                    session?.retire();
                    throw new Error('Blocked or captcha detected');
                }

                crawlerLog.info(`[${label}] ${request.url}`);

                if (label === 'LIST') {
                    await handleListPage(request, page, crawlerLog, pageNo);
                } else if (label === 'DETAIL') {
                    await handleDetailPage(request, page, crawlerLog);
                }
            },

            failedRequestHandler({ request, log: crawlerLog }, error) {
                failed++;
                if (String(error?.message || '').includes('403')) stats.blocked++;
                crawlerLog.error(`❌ Failed: ${request.url}`, { error: error?.message });
                stats.errors.push({ url: request.url, error: error?.message });
            },
        });

        // ====================================================================
        // LIST PAGE HANDLER
        // ====================================================================
        async function handleListPage(request, page, crawlerLog, pageNo) {
            if (saved >= RESULTS_WANTED) {
                crawlerLog.info(`🎯 Target reached (${saved}/${RESULTS_WANTED})`);
                return;
            }

            // Wait for content
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
                    await page.waitForSelector('a[href*="/jobview/"]', { timeout: 4000 }).catch(() => {});
            
            // Scroll to load more jobs (lazy loading)
            await autoScroll(page);
            
            stats.listPages++;

            // Extract all job links
            const jobLinks = await page.$$eval('a[href*="/jobview/"]', (anchors) => {
                const links = new Set();
                anchors.forEach((el) => {
                    const href = el.getAttribute('href');
                    if (!href) return;
                    const fullUrl = href.startsWith('http') ? href : `https://www.careerone.com.au${href}`;
                    links.add(fullUrl.split('?')[0]);
                });
                return [...links];
            });

            crawlerLog.info(`📊 Found ${jobLinks.length} jobs on page ${pageNo}`);

            if (!jobLinks.length) {
                crawlerLog.warning('⚠️ No jobs found, saving debug HTML');
                await Actor.setValue(`debug-list-${pageNo}.html`, await page.content(), { contentType: 'text/html' });
                return;
            }

            // Filter and enqueue new jobs
            const remaining = RESULTS_WANTED - saved;
            const newLinks = jobLinks
                .filter((link) => (dedupe ? !seenUrls.has(link) : true))
                .slice(0, remaining);
            newLinks.forEach((link) => seenUrls.add(link));

            if (collectDetails && newLinks.length) {
                // Add to queue with high priority for parallel processing
                for (const link of newLinks) {
                    await requestQueue.addRequest({
                        url: link,
                        userData: { label: 'DETAIL', fromPage: pageNo, fromPageUrl: request.url },
                    }, { forefront: false });
                }
                crawlerLog.info(`➕ Enqueued ${newLinks.length} job details`);
            } else if (!collectDetails && newLinks.length) {
                const items = newLinks.map((u) => ({
                    url: u, _source: 'careerone.com.au', _scraped_at: new Date().toISOString(),
                }));
                await Dataset.pushData(items);
                saved += newLinks.length;
                crawlerLog.info(`💾 Saved ${newLinks.length} URLs (${saved}/${RESULTS_WANTED})`);
            }

            // Pagination - enqueue next page
            if (saved + newLinks.length < RESULTS_WANTED && pageNo < MAX_PAGES) {
                const nextPageUrl = buildNextPageUrl(request.url, pageNo);
                if (nextPageUrl && !seenUrls.has(nextPageUrl)) {
                    seenUrls.add(nextPageUrl);
                    await requestQueue.addRequest({
                        url: nextPageUrl,
                        userData: { label: 'LIST', pageNo: pageNo + 1 },
                    }, { forefront: true }); // List pages have priority
                    crawlerLog.info(`📄 Enqueued page ${pageNo + 1}`);
                }
            }
        }

        // ====================================================================
        // DETAIL PAGE HANDLER - FULL DESCRIPTION EXTRACTION
        // ====================================================================
        async function handleDetailPage(request, page, crawlerLog) {
            if (saved >= RESULTS_WANTED) {
                crawlerLog.info(`✅ Skipping, target reached`);
                return;
            }

            // Wait for content to fully load
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
            await page.waitForSelector('h1', { timeout: 5000 }).catch(() => {});
            
            // Scroll down to trigger lazy-loaded content
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
            await page.waitForTimeout(200);

            stats.detailPages++;

            // Extract job data - prioritize JSON-LD for accuracy
            const jobData = await page.evaluate(() => {
                const data = {
                    title: null,
                    company: null,
                    location: null,
                    salary: null,
                    date_posted: null,
                    description_html: null,
                    description_text: null,
                    work_type: null,
                    contract_type: null,
                };

                // 1. Try JSON-LD first
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const script of scripts) {
                    try {
                        let json = JSON.parse(script.textContent);
                        
                        // Handle @graph structure
                        if (json['@graph']) {
                            const graphHit = json['@graph'].find(item => {
                                const type = item['@type'];
                                if (typeof type === 'string') return type.toLowerCase().includes('jobposting');
                                if (Array.isArray(type)) return type.some(t => String(t).toLowerCase().includes('jobposting'));
                                return false;
                            });
                            if (graphHit) json = graphHit;
                        }
                        
                        const type = json['@type'];
                        const isJob = (typeof type === 'string' && type.toLowerCase().includes('jobposting')) ||
                                      (Array.isArray(type) && type.some(t => String(t).toLowerCase().includes('jobposting')));

                        if (isJob) {
                            data.title = json.title || json.name;
                            
                            if (json.hiringOrganization) {
                                data.company = typeof json.hiringOrganization === 'string' 
                                    ? json.hiringOrganization 
                                    : (json.hiringOrganization.name || json.hiringOrganization.legalName);
                            }
                            
                            if (json.jobLocation) {
                                const loc = Array.isArray(json.jobLocation) ? json.jobLocation[0] : json.jobLocation;
                                const addr = loc?.address || {};
                                data.location = [addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ');
                            }
                            
                            if (json.baseSalary) {
                                const bs = json.baseSalary;
                                if (typeof bs === 'string') {
                                    data.salary = bs;
                                } else if (bs.value) {
                                    const v = bs.value;
                                    const parts = [];
                                    if (v.minValue) parts.push(`$${Number(v.minValue).toLocaleString()}`);
                                    if (v.maxValue) parts.push(`$${Number(v.maxValue).toLocaleString()}`);
                                    if (v.unitText) parts.push(`per ${String(v.unitText).toLowerCase()}`);
                                    data.salary = parts.join(' - ');
                                }
                            }
                            
                            data.date_posted = json.datePosted;
                            data.description_html = json.description; // JSON-LD usually has full description
                            data.work_type = json.employmentType;
                            break;
                        }
                    } catch {}
                }

                // 2. Fallback to HTML scraping if JSON-LD missing data
                if (!data.title) {
                    data.title = document.querySelector('h1')?.textContent?.trim();
                }
                
                if (!data.company) {
                    const companyEl = document.querySelector('h2 a') || 
                                      document.querySelector('[class*="company"]');
                    data.company = companyEl?.textContent?.trim();
                }
                
                if (!data.location) {
                    const links = document.querySelectorAll('h2 a');
                    if (links.length > 1) {
                        data.location = links[1]?.textContent?.trim();
                    }
                }

                // 3. CRITICAL: Get FULL description from page content
                if (!data.description_html || data.description_html.length < 500) {
                    // Look for the main job description container
                    const descSelectors = [
                        '[class*="JobDescription"]',
                        '[class*="job-description"]',
                        '[class*="jobDescription"]',
                        '[data-testid="job-description"]',
                        'article [class*="description"]',
                        '.description-content',
                        'article',
                        'main section',
                    ];
                    
                    for (const sel of descSelectors) {
                        const el = document.querySelector(sel);
                        if (el && el.innerHTML.length > 200) {
                            // Clean up the HTML - remove scripts, styles, and unwanted elements
                            const clone = el.cloneNode(true);
                            clone.querySelectorAll('script, style, nav, header, footer, [class*="related"], [class*="similar"], [class*="recommend"]').forEach(e => e.remove());
                            
                            const html = clone.innerHTML.trim();
                            if (html.length > (data.description_html?.length || 0)) {
                                data.description_html = html;
                            }
                            break;
                        }
                    }
                }

                // 4. Extract plain text from body as last resort
                if (!data.description_text && data.description_html) {
                    const temp = document.createElement('div');
                    temp.innerHTML = data.description_html;
                    data.description_text = temp.textContent?.replace(/\s+/g, ' ').trim();
                }

                // 5. If still no description, get from page body
                if (!data.description_html) {
                    // Find all paragraphs in main content
                    const mainContent = document.querySelector('main') || document.querySelector('article') || document.body;
                    const paragraphs = mainContent.querySelectorAll('p');
                    const textParts = [];
                    paragraphs.forEach(p => {
                        const text = p.textContent?.trim();
                        if (text && text.length > 50) {
                            textParts.push(p.outerHTML);
                        }
                    });
                    if (textParts.length > 2) {
                        data.description_html = textParts.join('\n');
                        data.description_text = textParts.map(h => {
                            const temp = document.createElement('div');
                            temp.innerHTML = h;
                            return temp.textContent?.trim();
                        }).join('\n\n');
                    }
                }

                // 6. Get additional metadata
                const bodyText = document.body.innerText;
                
                if (!data.date_posted) {
                    const dateMatch = bodyText.match(/Date posted[:\s]*([^\n]+)/i) ||
                                      bodyText.match(/Posted[:\s]*(\d+\s*\w+\s*ago)/i) ||
                                      bodyText.match(/Posted\s+(\w+)/i);
                    if (dateMatch) data.date_posted = dateMatch[1].trim();
                }
                
                if (!data.salary) {
                    const salaryEl = document.querySelector('[class*="salary"]') ||
                                     document.querySelector('[class*="pay"]');
                    if (salaryEl) data.salary = salaryEl.textContent?.trim();
                }

                return data;
            });

            // Process description with cheerio for clean text
            if (jobData.description_html && !jobData.description_text) {
                const $ = cheerioLoad(`<div>${jobData.description_html}</div>`);
                $('script, style, nav, header, footer').remove();
                jobData.description_text = clean($('div').text());
            }

            // Build final item
            const item = {
                site: 'Careerone',
                keyword: keyword || null,
                location: clean(jobData.location || location) || null,
                category: category || null,
                title: jobData.title,
                company: jobData.company,
                salary: jobData.salary,
                work_type: jobData.work_type,
                contract_type: jobData.contract_type,
                date_posted: jobData.date_posted,
                description_html: jobData.description_html,
                description_text: jobData.description_text,
                url: request.url,
                _source: 'careerone.com.au',
                _scraped_at: new Date().toISOString(),
            };

            // Remove empty fields to keep output clean
            Object.keys(item).forEach((k) => {
                const v = item[k];
                if (v === null || v === undefined || v === '') delete item[k];
            });

            await Dataset.pushData(item);
            saved++;

            const descLength = item.description_text?.length || 0;
            crawlerLog.info(`💾 Saved: "${item.title}" at ${item.company} (${saved}/${RESULTS_WANTED}) [desc: ${descLength} chars]`);
        }

        // ====================================================================
        // HELPER FUNCTIONS
        // ====================================================================
        
        // Auto-scroll to load lazy content
        async function autoScroll(page) {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let totalHeight = 0;
                    const distance = 700;
                    const timer = setInterval(() => {
                        window.scrollBy(0, distance);
                        totalHeight += distance;
                        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 100);
                    // Max ~2 seconds of scrolling
                    setTimeout(() => { clearInterval(timer); resolve(); }, 2000);
                });
            });
            await page.waitForTimeout(200);
        }

        // Build next page URL
        function buildNextPageUrl(currentUrl, currentPage) {
            try {
                const u = new URL(currentUrl);
                u.searchParams.set('page', String(currentPage + 1));
                return u.href;
            } catch {
                return null;
            }
        }

        // ====================================================================
        // RUN CRAWLER
        // ====================================================================
        
        // Add initial URLs to queue
        for (const url of initialUrls) {
            await requestQueue.addRequest({
                url,
                userData: { label: 'LIST', pageNo: 1 },
            });
        }

        await crawler.run();

        // Final stats
        const durationSeconds = (Date.now() - startTime) / 1000;
        const duration = durationSeconds.toFixed(2);
        log.info('🏁 Scraping completed!', {
            duration_seconds: duration,
            saved,
            failed,
            list_pages: stats.listPages,
            detail_pages: stats.detailPages,
            jobs_per_minute: (saved / (Math.max(durationSeconds, 1) / 60)).toFixed(1),
            blocked: stats.blocked,
        });

        if (stats.errors.length) {
            log.warning(`⚠️ ${stats.errors.length} errors`);
            await Actor.setValue('errors.json', stats.errors);
        }

        if (!saved) {
            log.warning('⚠️ No jobs saved. Check debug files.');
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
