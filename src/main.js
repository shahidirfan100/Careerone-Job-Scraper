// Careerone jobs scraper - PlaywrightCrawler implementation
import { Actor, log } from 'apify';
import { PlaywrightCrawler, Dataset } from 'crawlee';

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

        const buildStartUrl = (kw, loc) => {
            let locationSlug = 'australia';
            if (loc) {
                locationSlug = String(loc).trim().toLowerCase().replace(/\s+/g, '-');
            }
            const u = new URL(`https://www.careerone.com.au/jobs/in-${locationSlug}`);
            if (kw) u.searchParams.set('keywords', String(kw).trim());
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location));

        log.info(`Starting URLs: ${JSON.stringify(initial)}`);
        log.info(`Target: ${RESULTS_WANTED} results, Max pages: ${MAX_PAGES}, Collect details: ${collectDetails}`);

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();

        const crawler = new PlaywrightCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 3,
            requestHandlerTimeoutSecs: 120,
            maxConcurrency: 5,
            async requestHandler({ request, page, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                crawlerLog.info(`[${label}] Processing ${request.url} (page ${pageNo})`);

                if (label === 'LIST') {
                    // Wait for job listings to load
                    try {
                        await page.waitForSelector('a[href*="/jobview/"]', { timeout: 15000 });
                    } catch (err) {
                        crawlerLog.warning(`No job listings found on ${request.url}: ${err.message}`);
                        return;
                    }

                    // Extract job links from the page
                    const jobLinks = await page.$$eval('a[href*="/jobview/"]', (links) => {
                        return [...new Set(links.map(a => a.href))];
                    });

                    crawlerLog.info(`Found ${jobLinks.length} job links on page ${pageNo}`);

                    if (collectDetails) {
                        // Enqueue job detail pages
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = jobLinks.slice(0, Math.max(0, remaining)).filter(link => !seenUrls.has(link));
                        toEnqueue.forEach(link => seenUrls.add(link));
                        
                        if (toEnqueue.length > 0) {
                            await enqueueLinks({ 
                                urls: toEnqueue, 
                                userData: { label: 'DETAIL' } 
                            });
                            crawlerLog.info(`Enqueued ${toEnqueue.length} job details`);
                        }
                    } else {
                        // Save job URLs without details
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = jobLinks.slice(0, Math.max(0, remaining)).filter(link => !seenUrls.has(link));
                        toPush.forEach(link => seenUrls.add(link));
                        
                        if (toPush.length > 0) {
                            await Dataset.pushData(toPush.map(u => ({ 
                                url: u, 
                                _source: 'careerone.com.au' 
                            })));
                            saved += toPush.length;
                            crawlerLog.info(`Saved ${toPush.length} job URLs (total: ${saved})`);
                        }
                    }

                    // Handle pagination
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                        // Check if there's a next page
                        const hasNextPage = await page.$('a:has-text("NEXT"), a[rel="next"]');
                        
                        if (hasNextPage) {
                            const nextPageUrl = new URL(request.url);
                            nextPageUrl.searchParams.set('page', String(pageNo + 1));
                            
                            await enqueueLinks({ 
                                urls: [nextPageUrl.href], 
                                userData: { label: 'LIST', pageNo: pageNo + 1 } 
                            });
                            crawlerLog.info(`Enqueued next page: ${pageNo + 1}`);
                        } else {
                            crawlerLog.info('No next page found');
                        }
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) return;

                    try {
                        // Wait for page content to load
                        await page.waitForSelector('h1', { timeout: 10000 });

                        // Extract job details
                        const jobData = await page.evaluate(() => {
                            const title = document.querySelector('h1')?.textContent?.trim() || null;
                            const company = document.querySelector('h2 a')?.textContent?.trim() || null;
                            const location = document.querySelectorAll('h2 a')?.[1]?.textContent?.trim() || null;
                            
                            // Try to find date posted
                            let datePosted = null;
                            const bodyText = document.body.textContent;
                            const dateMatch = bodyText.match(/Date posted[:\s]*([^\n]+)/i) || 
                                            bodyText.match(/Posted[:\s]*([^\n]+)/i);
                            if (dateMatch) {
                                datePosted = dateMatch[1].trim();
                            }

                            // Extract description - get all content after h2
                            const descriptionElements = [];
                            const h2 = document.querySelector('h2');
                            if (h2) {
                                let element = h2.nextElementSibling;
                                while (element && descriptionElements.length < 20) {
                                    if (element.textContent?.trim().length > 50) {
                                        descriptionElements.push(element.outerHTML);
                                    }
                                    element = element.nextElementSibling;
                                }
                            }
                            
                            const descriptionHtml = descriptionElements.join('<br>') || null;
                            const descriptionText = descriptionElements
                                .map(html => {
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
                                datePosted,
                                descriptionHtml,
                                descriptionText
                            };
                        });

                        const item = {
                            title: jobData.title,
                            company: jobData.company,
                            category: category || null,
                            location: jobData.location,
                            date_posted: jobData.datePosted,
                            description_html: jobData.descriptionHtml,
                            description_text: jobData.descriptionText,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Saved job: ${item.title} (${saved}/${RESULTS_WANTED})`);
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                    }
                }
            },
            failedRequestHandler({ request }, error) {
                log.error(`Request ${request.url} failed: ${error.message}`);
            },
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { 
    console.error(err); 
    process.exit(1); 
});
