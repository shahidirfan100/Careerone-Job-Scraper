// Careerone jobs scraper - API-lite implementation that evaluates Nuxt state and falls back to detail scraping
import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import vm from 'vm';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            category = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://www.careerone.com.au') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc) => {
            let locationSlug = 'australia';
            if (loc) {
                locationSlug = String(loc).trim().toLowerCase().replace(/\s+/g, '-');
            }
            // Use the “latest-jobs” path that is server-rendered.
            const u = new URL(`https://www.careerone.com.au/latest-jobs/in-${locationSlug}`);
            if (kw) u.searchParams.set('keywords', String(kw).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location));
        
        log.info(`Starting URLs: ${JSON.stringify(initial)}`);

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();
        const headerGen = new HeaderGenerator({
            browsers: [{ name: 'chrome', minVersion: 120, httpVersion: '2' }],
            devices: ['desktop'],
            operatingSystems: ['linux', 'windows'],
        });

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        async function fetchHtml(url) {
            const headers = {
                ...headerGen.getHeaders({
                    httpVersion: '2',
                    locale: 'en-US,en;q=0.9',
                }),
                // Align with observed browser headers to reduce blocking.
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'accept-language': 'en-US,en;q=0.9',
                'cache-control': 'max-age=0',
                'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'same-origin',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
            };
            const res = await gotScraping({
                url,
                proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                headers,
                http2: true,
                timeout: { request: 45000 },
                throwHttpErrors: false,
            });
            log.info(`Fetched ${url} - Status: ${res.statusCode}, Body length: ${res.body?.length || 0}`);
            return res.body || '';
        }

        function parseNuxtState(html) {
            const match = html.match(/window.__NUXT__=(.*?);<\/script>/s);
            if (!match) {
                log.warning('No __NUXT__ state found in HTML');
                return null;
            }
            try {
                const state = vm.runInNewContext(match[1], {});
                log.info(`Parsed Nuxt state successfully`);
                return state;
            } catch (err) {
                log.error(`Failed to parse Nuxt state: ${err.message}`);
                return null;
            }
        }

        function extractJobsFromState(state) {
            if (!state) {
                log.warning('State is null/undefined');
                return { jobs: [], meta: {} };
            }
            
            // Try multiple paths to find jobs
            const jobs = state?.state?.search?.searchPayload?.search_results?.jobs 
                || state?.state?.searchPayload?.search_results?.jobs 
                || state?.data?.search?.searchPayload?.search_results?.jobs
                || state?.search?.searchPayload?.search_results?.jobs
                || [];
            
            const meta = state?.state?.search?.searchPayload?.search_results?.meta 
                || state?.state?.searchPayload?.search_results?.meta 
                || state?.data?.search?.searchPayload?.search_results?.meta
                || state?.search?.searchPayload?.search_results?.meta
                || {};
            
            log.info(`Extracted ${jobs.length} jobs from state. Meta: ${JSON.stringify(meta).substring(0, 200)}`);
            
            if (!Array.isArray(jobs) || !jobs.length) return { jobs: [], meta: {} };
            return { jobs, meta };
        }

        function extractJobLinksFromHtml(html, base) {
            const $ = cheerioLoad(html);
            const links = new Set();
            $('a[href*="/jobview/"]').each((_, a) => {
                const href = $(a).attr('href');
                const abs = href ? toAbs(href, base) : null;
                if (abs) links.add(abs);
            });
            log.info(`Extracted ${links.size} job links from HTML`);
            return [...links];
        }

        function normalizeJob(job) {
            return {
                title: job?.title || job?.job_title || null,
                company: job?.company || job?.company_name || job?.company_title || null,
                location: job?.location || job?.display_location || job?.state || null,
                date_posted: job?.created_at || job?.posted_at || job?.date || null,
                url: toAbs(job?.jobview_url || job?.url || job?.job_url || job?.jobview || job?.share_url),
                description_html: job?.description || job?.description_html || null,
                description_text: job?.description ? cleanText(job.description) : null,
                raw: job,
            };
        }

        async function fetchDetail(url) {
            const html = await fetchHtml(url);
            const $ = cheerioLoad(html);
            const json = extractFromJsonLd($);
            const data = json || {};
            if (!data.title) data.title = $('h1').first().text().trim() || null;
            if (!data.company) data.company = $('[data-company], h2 a').first().text().trim() || null;
            if (!data.description_html) {
                const descElements = $('article, section, div, p').filter((_, el) => $(el).text().length > 120);
                data.description_html = descElements.map((_, el) => $(el).html()).get().join('<br>') || null;
            }
            data.description_text = data.description_html ? cleanText(data.description_html) : null;
            if (!data.location) data.location = $('h2 a, [data-location]').eq(1).text().trim() || null;
            return data;
        }

        for (const start of initial) {
            log.info(`Starting scrape from: ${start}`);
            let pageNo = 1;
            let nextUrl = start;
            while (saved < RESULTS_WANTED && pageNo <= MAX_PAGES && nextUrl) {
                log.info(`Processing page ${pageNo}: ${nextUrl}`);
                const html = await fetchHtml(nextUrl);
                const state = parseNuxtState(html);
                const { jobs, meta } = extractJobsFromState(state);

                let normalizedJobs = [];
                if (jobs.length) {
                    normalizedJobs = jobs.map(normalizeJob).filter(j => j.url);
                    log.info(`LIST ${nextUrl} -> ${normalizedJobs.length} jobs (page ${pageNo})`);
                } else {
                    const links = extractJobLinksFromHtml(html, nextUrl);
                    normalizedJobs = links.map(link => ({ url: link }));
                    log.warning(`LIST ${nextUrl} -> no JSON jobs, fell back to ${normalizedJobs.length} link(s)`);
                }

                const remaining = RESULTS_WANTED - saved;
                const toProcess = normalizedJobs.slice(0, Math.max(0, remaining)).filter(j => j.url && !seenUrls.has(j.url));
                toProcess.forEach(j => seenUrls.add(j.url));
                log.info(`Will process ${toProcess.length} jobs (${remaining} remaining to reach target)`);

                for (const job of toProcess) {
                    if (saved >= RESULTS_WANTED) break;
                    if (!collectDetails) {
                        await Dataset.pushData({
                            title: job.title || null,
                            company: job.company || null,
                            location: job.location || null,
                            category: category || null,
                            date_posted: job.date_posted || null,
                            url: job.url,
                            description_html: job.description_html || null,
                            description_text: job.description_text || null,
                            _raw: job.raw,
                        });
                        saved++;
                        continue;
                    }

                    try {
                        const detail = await fetchDetail(job.url);
                        const item = {
                            title: detail.title || job.title || null,
                            company: detail.company || job.company || null,
                            category: category || null,
                            location: detail.location || job.location || null,
                            date_posted: detail.date_posted || job.date_posted || null,
                            description_html: detail.description_html || job.description_html || null,
                            description_text: detail.description_text || job.description_text || null,
                            url: job.url,
                        };
                        await Dataset.pushData(item);
                        saved++;
                    } catch (err) {
                        log.error(`DETAIL ${job.url} failed: ${err.message}`);
                    }
                }

                if (saved >= RESULTS_WANTED) {
                    log.info('Reached target results count');
                    break;
                }
                const totalPages = meta?.total_pages || meta?.totalPages || meta?.total_pages_count;
                const currentPage = meta?.page || pageNo;
                if (totalPages && currentPage >= totalPages) {
                    log.info(`Reached last page (${currentPage}/${totalPages})`);
                    break;
                }
                const nextPage = currentPage + 1;
                if (nextPage > MAX_PAGES) {
                    log.info(`Reached max pages limit (${MAX_PAGES})`);
                    break;
                }
                const u = new URL(nextUrl);
                u.searchParams.set('page', String(nextPage));
                nextUrl = u.href;
                pageNo = nextPage;
                log.info(`Moving to next page: ${nextUrl}`);
            }
            log.info(`Finished processing start URL: ${start}`);
        }

        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
