# Careerone Jobs Scraper

Scrape job listings from [Careerone.com.au](https://www.careerone.com.au/), one of Australia's largest job boards. Extract comprehensive job data including titles, companies, locations, salaries, and full descriptions.

## Features

- **Flexible search** - Search by keywords, location, or use direct URLs
- **Full job details** - Extract complete job descriptions from detail pages
- **Pagination support** - Automatically navigate through multiple result pages
- **Proxy support** - Built-in proxy configuration for reliable scraping
- **Structured output** - Clean JSON output ready for analysis or integration
- **Deduplication** - Remove duplicate job listings automatically

## How it works

1. The scraper starts from a search URL built from your keyword and location, or uses a direct URL you provide
2. It extracts job listings from search result pages, navigating through pagination
3. For each job, it optionally visits the detail page to extract the full description
4. All data is saved to the default dataset in structured JSON format

## Input

| Field | Type | Description |
|-------|------|-------------|
| `keyword` | String | Job search keyword (e.g., "software engineer", "marketing manager") |
| `location` | String | Location filter (e.g., "Sydney", "Melbourne VIC") |
| `startUrl` | String | Direct Careerone search URL (overrides keyword/location) |
| `results_wanted` | Integer | Maximum number of jobs to collect (default: 100) |
| `max_pages` | Integer | Maximum search result pages to visit (default: 20) |
| `collectDetails` | Boolean | Visit detail pages for full descriptions (default: true) |
| `proxyConfiguration` | Object | Proxy settings for the scraper |
| `dedupe` | Boolean | Remove duplicate job URLs (default: true) |

### Example input

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

### Using a direct URL

```json
{
    "startUrl": "https://www.careerone.com.au/jobs/in-melbourne?keywords=data%20analyst",
    "results_wanted": 100,
    "collectDetails": true,
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

## Output

The scraper saves each job as a JSON object with the following fields:

| Field | Description |
|-------|-------------|
| `title` | Job position title |
| `company` | Hiring company name |
| `location` | Job location |
| `salary` | Salary information (when available) |
| `job_type` | Employment type (full-time, part-time, etc.) |
| `date_posted` | Job posting date |
| `description_text` | Full job description (plain text) |
| `description_html` | Full job description (HTML) |
| `url` | Direct link to the job posting |
| `site` | Source site name |
| `keyword` | Search keyword used |
| `_scraped_at` | Timestamp of when the job was scraped |

### Example output

```json
{
    "title": "Senior Software Engineer",
    "company": "TechCorp Australia",
    "location": "Sydney NSW",
    "salary": "$120,000 - $150,000 per annum",
    "job_type": "Full Time",
    "date_posted": "2025-01-15",
    "description_text": "We are looking for an experienced software engineer to join our team...",
    "description_html": "<div>We are looking for an experienced software engineer...</div>",
    "url": "https://www.careerone.com.au/jobview/senior-software-engineer/abc123",
    "site": "Careerone",
    "keyword": "software engineer",
    "_scraped_at": "2025-01-20T10:30:00.000Z"
}
```

## Use cases

- **Job market research** - Analyze hiring trends in the Australian job market
- **Recruitment** - Build candidate pipelines by monitoring job postings
- **Competitive analysis** - Track competitor hiring activities
- **Salary benchmarking** - Collect salary data for specific roles and locations
- **Job aggregation** - Feed job data into job boards or career platforms

## Tips for best results

- **Enable proxies** - Use Apify Proxy to avoid rate limiting
- **Use specific keywords** - More specific searches yield more relevant results
- **Enable detail collection** - Set `collectDetails: true` for complete job descriptions
- **Set reasonable limits** - Balance `results_wanted` with execution time

## Memory and performance

| Use case | Recommended memory |
|----------|-------------------|
| Small runs (< 50 jobs) | 4 GB |
| Medium runs (50-200 jobs) | 8 GB |
| Large runs (> 200 jobs) | 16 GB |

## Integrations

Connect this scraper to other apps and services:

- Export data to Google Sheets, Airtable, or databases
- Set up scheduled runs for regular job monitoring
- Use webhooks to trigger actions when new jobs are found
- Connect via Zapier, Make, or direct API calls

## Resources

- [What is web scraping?](https://apify.com/web-scraping)
- [Apify Proxy documentation](https://docs.apify.com/platform/proxy)
- [Integrating with other services](https://apify.com/integrations)
- [Video tutorials](https://www.youtube.com/@apaborea)

## Legal notice

Scraping publicly available data is generally legal, but always review the target website's terms of service. Use this tool responsibly and in compliance with applicable laws and regulations.