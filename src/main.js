// Careerone Jobs Scraper - High-performance HTTP/JSON-LD implementation
// Uses CheerioCrawler (HTTP + HTML parsing) instead of a full browser
// This avoids most headless-browser blocks and is much faster & cheaper.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Simple UA pool. In practice got-scraping already generates realistic headers,
// so we only override if we really need to.
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 13.5; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
];

const pickUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Utility: safely parse JSON, returning null on error
const safeJsonParse = (txt) => {
    if (!txt) return null;
    try {
        return JSON.parse(txt);
    } catch {
        return null;
    }
};

// Utility: recursively search for a JobPosting object in arbitrary JSON-LD
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

        // Logging level
        log.setLevel(debugMode ? log.LEVELS.DEBUG : log.LEVELS.INFO);

        log.info('🚀 Starting Careerone Jobs Scraper (HTTP/JSON-LD version)', {
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

        // Proxy configuration
        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration(proxyConfiguration)
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

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,

            useSessionPool: true,
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: { maxUsageCount: 10 },
            },

            // High but safe concurrency - HTTP parsing is cheap
            minConcurrency: 5,
            maxConcurrency: 20,

            maxRequestRetries: 5,
            navigationTimeoutSecs: 30,
            requestHandlerTimeoutSecs: 45,

            // Tune autoscaled pool thresholds so it doesn't sit at concurrency 1
            autoscaledPoolOptions: {
                systemStatusOptions: {
                    maxCpuOverloadedRatio: 0.95,
                    maxMemoryOverloadedRatio: 0.9,
                    maxEventLoopOverloadedRatio: 0.95,
                    maxClientOverloadedRatio: 0.95,
                },
            },

            // Customize HTTP headers (via got-scraping) for each request
            // preNavigationHooks signature: (crawlingContext, gotOptions) => {...}
            // docs: https://crawlee.dev/js/api/cheerio-crawler/interface/CheerioCrawlerOptions#preNavigationHooks 
            preNavigationHooks: [
                async ({ session }, gotOptions) => {
                    // Persist header generator output per session to look like one stable browser
                    const stored = session.userData.headers;
                    if (stored) {
                        gotOptions.headers = {
                            ...stored,
                        };
                    } else {
                        // Let got-scraping generate realistic headers; we only add Accept-Language and UA override once
                        gotOptions.headers = {
                            ...(gotOptions.headers || {}),
                            'accept-language': 'en-US,en;q=0.9',
                        };

                        if (!session.userData.ua) {
                            session.userData.ua = pickUserAgent();
                        }
                        gotOptions.headers['user-agent'] = session.userData.ua;
                    }
                },
            ],

            // Main handler: LIST + DETAIL logic
            async requestHandler({ request, $, enqueueLinks, session, response, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;
                const startedAt = Date.now();

                if (label === 'LIST' || debugMode) {
                    crawlerLog.info(`[${label}] Page ${pageNo}: ${request.url}`);
                }

                // Handle explicit HTTP blocks
                const statusCode = response?.statusCode;
                if (statusCode === 403 || statusCode === 429) {
                    crawlerLog.warning(`?? HTTP ${statusCode} on ${label}, retiring session`);
                    session?.retire();
                    // Throw to let Crawlee retry with a fresh session/proxy
                    throw new Error(`Blocked with status ${statusCode}`);
                }

                if (label === 'LIST') {
                    if (!$) {
                        throw new Error('Cheerio $ is undefined on LIST page');
                    }

                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`🎯 Target already reached (${saved}/${RESULTS_WANTED}), skipping list page.`);
                        return;
                    }

                    stats.listPages++;

                    // Extract job detail links
                    const jobLinks = $('a[href*="/jobview/"]')
                        .map((_, el) => {
                            const href = $(el).attr('href') || '';
                            if (!href) return null;
                            // Normalize to absolute URL if needed
                            if (href.startsWith('http')) return href.split('?')[0];
                            if (href.startsWith('/')) {
                                return `https://www.careerone.com.au${href.split('?')[0]}`;
                            }
                            return null;
                        })
                        .get()
                        .filter(Boolean);

                    const uniqueLinks = [...new Set(jobLinks)];

                    crawlerLog.info(`📊 Found ${uniqueLinks.length} unique job links on page ${pageNo}`);

                    if (!uniqueLinks.length) {
                        crawlerLog.warning('⚠️ No job links extracted on LIST page. Saving HTML for debug.');
                        try {
                            await Actor.setValue(
                                `debug-list-page-${pageNo}.html`,
                                $.html(),
                                { contentType: 'text/html; charset=utf-8' },
                            );
                        } catch {
                            // ignore
                        }
                        return;
                    }

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = uniqueLinks
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
                        const toPush = uniqueLinks
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

                    // Pagination: only if we still need more results and below MAX_PAGES
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        let nextUrl = null;

                        // 1) rel="next"
                        const relNext = $('a[rel="next"]').attr('href');
                        if (relNext) {
                            nextUrl = relNext.startsWith('http')
                                ? relNext
                                : `https://www.careerone.com.au${relNext}`;
                        }

                        // 2) visible "Next" link
                        if (!nextUrl) {
                            $('a').each((_, el) => {
                                if (nextUrl) return;
                                const txt = ($(el).text() || '').trim();
                                if (/^next$/i.test(txt) || /^(›|»)$/.test(txt)) {
                                    const href = $(el).attr('href');
                                    if (href) {
                                        nextUrl = href.startsWith('http')
                                            ? href
                                            : `https://www.careerone.com.au${href}`;
                                    }
                                }
                            });
                        }

                        // 3) conservative ?page=N fallback
                        if (!nextUrl) {
                            try {
                                const u = new URL(request.url);
                                u.searchParams.set('page', String(pageNo + 1));
                                const candidate = u.href;
                                if (candidate !== request.url) nextUrl = candidate;
                            } catch {
                                // ignore
                            }
                        }

                        if (nextUrl) {
                            await enqueueLinks({
                                urls: [nextUrl],
                                userData: { label: 'LIST', pageNo: pageNo + 1 },
                            });
                            crawlerLog.info(`📄 Enqueued next page: ${nextUrl}`);
                        } else {
                            crawlerLog.info(`🏁 No more pages after page ${pageNo}`);
                        }
                    } else if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`🎯 Reached target: ${saved} jobs`);
                    } else if (pageNo >= MAX_PAGES) {
                        crawlerLog.info(`🛑 Reached max pages limit: ${MAX_PAGES}`);
                    }
                }

                if (label === 'DETAIL') {
                    if (!$) {
                        throw new Error('Cheerio $ is undefined on DETAIL page');
                    }

                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`⏭️ Skipping detail, target reached: ${saved}/${RESULTS_WANTED}`);
                        return;
                    }

                    stats.detailPages++;

                    // First, try JSON-LD (JobPosting schema)
                    let jobJson = null;

                    $('script[type="application/ld+json"]').each((_, el) => {
                        if (jobJson) return; // already found
                        const raw = $(el).contents().text().trim();
                        const parsed = safeJsonParse(raw);
                        const found = findJobPosting(parsed);
                        if (found) jobJson = found;
                    });

                    // Map JSON-LD to our item fields
                    let title = null;
                    let company = null;
                    let locationText = null;
                    let salary = null;
                    let datePosted = null;
                    let descriptionHtml = null;
                    let descriptionText = null;

                    if (jobJson) {
                        title = jobJson.title || jobJson.name || null;
                        if (jobJson.hiringOrganization) {
                            if (typeof jobJson.hiringOrganization === 'string') {
                                company = jobJson.hiringOrganization;
                            } else {
                                company =
                                    jobJson.hiringOrganization.name ||
                                    jobJson.hiringOrganization.legalName ||
                                    null;
                            }
                        }

                        if (jobJson.jobLocation) {
                            const locObj = Array.isArray(jobJson.jobLocation)
                                ? jobJson.jobLocation[0]
                                : jobJson.jobLocation;
                            const addr = locObj?.address || {};
                            const parts = [
                                addr.streetAddress,
                                addr.addressLocality,
                                addr.addressRegion,
                                addr.postalCode,
                                addr.addressCountry,
                            ]
                                .filter(Boolean)
                                .join(', ');
                            locationText = parts || null;
                        }

                        if (jobJson.baseSalary) {
                            const bs = jobJson.baseSalary;
                            if (typeof bs === 'string') {
                                salary = bs;
                            } else {
                                const val = bs.value || {};
                                const amount = val.value || val.minValue || val.maxValue || null;
                                const currency = val.currency || bs.currency || null;
                                const unitText = val.unitText || bs.unitText || null;
                                const parts = [];
                                if (amount != null) parts.push(String(amount));
                                if (currency) parts.push(currency);
                                if (unitText) parts.push(`(${unitText})`);
                                salary = parts.join(' ') || null;
                            }
                        }

                        datePosted = jobJson.datePosted || jobJson.validFrom || null;
                        descriptionHtml =
                            typeof jobJson.description === 'string' ? jobJson.description : null;
                    }

                    // Fallbacks from HTML if JSON-LD missing fields
                    const clean = (t) => (t ? t.trim().replace(/\s+/g, ' ') : null);

                    if (!title) {
                        title = clean($('h1').first().text());
                    }

                    if (!company) {
                        company =
                            clean($('h2 a').first().text()) ||
                            clean($('[data-company]').first().text()) ||
                            clean($('.company-name').first().text());
                    }

                    if (!locationText) {
                        const locLinks = $('h2 a');
                        locationText =
                            clean(locLinks.eq(1).text()) ||
                            clean($('[data-location]').first().text()) ||
                            clean($('.location').first().text());
                    }

                    if (!salary) {
                        salary =
                            clean($('[class*="salary"]').first().text()) ||
                            clean($('[data-salary]').first().text());
                    }

                    if (!datePosted) {
                        const bodyTxt = $('body').text() || '';
                        const patterns = [
                            /Date posted[:\s]*([^\n]+)/i,
                            /Posted[:\s]*(\d+[dhmyw]?\s*ago)/i,
                            /Posted[:\s]*([^\n]+)/i,
                        ];
                        for (const p of patterns) {
                            const m = bodyTxt.match(p);
                            if (m) {
                                datePosted = clean(m[1]);
                                break;
                            }
                        }
                    }

                    if (!descriptionHtml) {
                        const chunks = [];
                        const containers = [
                            $('[class*="job-description"]').first(),
                            $('[class*="description"]').first(),
                            $('article').first(),
                            $('main').first(),
                        ];
                        for (const c of containers) {
                            if (!c || !c.length) continue;
                            c.find('p, div, li').each((_, el) => {
                                const t = $(el).text().trim();
                                if (t && t.length > 30) {
                                    chunks.push($.html(el));
                                    if (chunks.length >= 80) return false;
                                }
                            });
                            if (chunks.length) break;
                        }
                        descriptionHtml = chunks.join('\n') || null;
                    }

                    if (descriptionHtml) {
                        // Strip tags for plain text
                        descriptionText = clean(
                            // Create a dummy wrapper to strip HTML using Cheerio
                            (() => {
                                const wrapper = $('<div></div>');
                                wrapper.html(descriptionHtml);
                                return wrapper.text();
                            })(),
                        );
                    }

                    const item = {
                        site: 'Careerone',
                        keyword: keyword || null,
                        location: location || null,
                        category: category || null,
                        title,
                        company,
                        location_text: locationText,
                        salary,
                        date_posted: datePosted,
                        description_html: descriptionHtml,
                        description_text: descriptionText,
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
                    log.debug(`⏱️ ${label} page ${pageNo} handled in ${took} ms`);
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
            log.warning('⚠️ No jobs were saved. Check debug-list-page-*.html in Key-value store to see what HTML the site returned.');
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
