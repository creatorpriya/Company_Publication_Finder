# Company_Publication_Finder

Company_Publication_Finder is an automated RSS feed and publication discovery tool built with Node.js. It scans company websites, blogs, news pages, and sitemaps to identify valid RSS/Atom feeds and publication sources for content monitoring and intelligence collection.

The application intelligently detects blogs, newsrooms, press releases, articles, and resource hubs using RSS validation, sitemap crawling, HTML parsing, and feed discovery techniques at scale.

## Features

* Automated RSS/Atom feed discovery
* Blog & newsroom feed detection
* Sitemap.xml crawling
* RSS validation & filtering
* Feed normalization & deduplication
* Smart publication URL discovery
* MongoDB integration
* Concurrent batch processing
* Scheduled daily execution
* Scalable domain processing

## Tech Stack

* Node.js
* Axios
* Cheerio
* RSS Parser
* XML2JS
* MongoDB
* P-Map

## Supported Publication Sources

* Blogs
* Newsrooms
* Press Releases
* Articles
* Insights
* Resource Centers
* Company Updates

## Detection Techniques

* Common RSS path scanning
* HTML RSS tag extraction
* Sitemap crawling
* Content URL filtering
* Feed validation using RSS parsing
* Feed deduplication & normalization

## Workflow

1. Fetch company domains
2. Scan websites for RSS feeds
3. Crawl sitemaps & content pages
4. Validate RSS/Atom feeds
5. Normalize and deduplicate feeds
6. Store results in MongoDB
7. Run continuously in scheduled batches

## Scalability

The system supports:

* Batch processing
* Concurrency control
* Automated scheduling
* Large-scale company crawling
* Retry-safe processing

Ideal for publication monitoring, news aggregation, threat intelligence, market research, and automated content discovery pipelines.
