# Careerone Job Scraper

Effortlessly scrape and collect job listings from Careerone.com.au, Australia's leading job board. This powerful Apify actor automates the extraction of job opportunities, including titles, companies, locations, salaries, and detailed descriptions, directly from Careerone's search results and individual job pages.

## 🚀 Key Features

- **⚡ Playwright-Powered**: Uses Playwright for full browser automation to handle JavaScript-rendered content
- **🎯 Comprehensive Job Data Extraction**: Captures essential job details such as title, company, location, salary, posting date, and full descriptions
- **🔍 Flexible Search Options**: Search by keywords, locations, or categories to target specific job markets in Australia
- **📄 Pagination Handling**: Automatically navigates through multiple search result pages
- **🎭 Stealth & Anti-Detection**: User agent rotation, session pooling, proxy support for reliable enterprise scraping
- **📊 Structured Output**: Saves data in clean, consistent JSON format ready for analysis or integration
- **🌐 Proxy Support**: Built-in support for Apify proxies to handle rate limits and ensure reliable scraping
- **📈 Production-Ready**: Optimized for speed and large-scale job data collection

## 📋 Input Parameters

Configure the scraper with the following options to customize your job search:

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `keyword` | string | Job title or skill to search for (e.g., "software engineer", "project manager"). | - |
| `location` | string | Location filter (e.g., "Sydney", "Melbourne"). | - |
| `category` | string | Job category to filter by (if supported by Careerone). | - |
| `startUrl` / `url` / `startUrls` | string/array | Specific Careerone search URL(s) to start from. Overrides keyword/location if provided. | - |
| `results_wanted` | integer | Maximum number of job listings to collect. | 100 |
| `max_pages` | integer | Maximum number of search pages to visit. | 10 |
| `collectDetails` | boolean | Whether to visit job detail pages for full descriptions. | true |
| `proxyConfiguration` | object | Proxy settings for enhanced scraping reliability. | Apify Proxy recommended |

### Example Input Configuration

```json
{
  "keyword": "software engineer",
  "location": "Sydney",
  "results_wanted": 50,
  "collectDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true
  }
}
```

## 📊 Output Data Structure

Each scraped job is saved as a JSON object with the following fields:

```json
{
  "site": "Careerone",
  "keyword": "software engineer",
  "location": "Sydney",
  "category": null,
  "title": "Senior Software Engineer",
  "company": "TechCorp",
  "location_text": "Sydney NSW",
  "salary": "$100,000 - $120,000 per annum",
  "date_posted": "2025-11-20",
  "description_html": "<p>Detailed job description...</p>",
  "description_text": "Plain text version of the job description...",
  "url": "https://www.careerone.com.au/job/12345678",
  "_source": "careerone.com.au",
  "_scraped_at": "2025-11-25T10:00:00.000Z"
}
```

- **site**: Source site name
- **keyword**: Search keyword used
- **location**: Search location used
- **category**: Job category (if available)
- **title**: Job position title
- **company**: Hiring company name
- **location_text**: Job location
- **salary**: Salary information (when provided)
- **date_posted**: Job posting date
- **description_html**: Full job description in HTML format
- **description_text**: Plain text version of the description
- **url**: Direct link to the job posting on Careerone
- **_source**: Data source identifier
- **_scraped_at**: Timestamp of scraping

## 🛠️ Usage Examples

### Basic Job Search
Run the actor with simple keyword and location inputs to collect recent job listings:

```json
{
  "keyword": "marketing",
  "location": "Melbourne",
  "results_wanted": 25
}
```

### Advanced Configuration
For targeted scraping with proxy support:

```json
{
  "startUrls": ["https://www.careerone.com.au/jobs/in-melbourne?keywords=data%20analyst"],
  "collectDetails": true,
  "max_pages": 10,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Integration with Apify API
Use the Apify API to run the scraper programmatically:

```bash
curl -X POST https://api.apify.com/v2/acts/your-actor-id/runs \
  -H "Authorization: Bearer YOUR_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keyword": "sales", "location": "Brisbane", "results_wanted": 100}'
```

## ⚙️ Configuration Best Practices & Memory Requirements

### 💾 Memory Recommendations

**Playwright Architecture Memory Usage:**
- **Minimum (Development/Testing)**: 4 GB - Supports low concurrency (1-3 jobs at a time)
- **Recommended (Production)**: 8 GB - Optimal for concurrency 5-10 with stable performance
- **High Volume**: 16 GB - For heavy workloads with 15+ concurrent page extractions

### ⚡ Performance Configuration

- **Proxy Usage**: Always enable proxy configuration to avoid IP blocking and ensure smooth scraping
- **Result Limits**: Set reasonable `results_wanted` values to balance data volume and execution time
- **Detail Scraping**: Enable `collectDetails` for comprehensive data
- **Concurrency**: PlaywrightCrawler runs at optimized concurrency levels
- **Rate Limiting**: The actor handles rate limits automatically with session pooling

## 🔧 Troubleshooting

### Common Issues
- **No Results Found**: Verify keyword and location spellings. Try broader search terms.
- **Incomplete Data**: Ensure `collectDetails` is enabled for full descriptions.
- **Rate Limiting**: Use proxy configuration to distribute requests.
- **Timeout Errors**: Reduce `results_wanted` or increase timeout settings.

### Performance Tips
- For large datasets, run the actor during off-peak hours.
- Use specific keywords to reduce irrelevant results.
- Monitor dataset size to avoid exceeding Apify storage limits.

## 📈 SEO and Discoverability

This scraper is optimized for finding Australian job market data. Keywords include: Careerone scraper, Australian jobs, employment Australia, job listings Australia, automated job scraping, recruitment data, Careerone API alternative.

## 🤝 Support and Resources

For questions or issues:
- Check the Apify community forums
- Review Careerone's terms of service before large-scale scraping
- Ensure compliance with local data protection regulations

*Last updated: November 2025*