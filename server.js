const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const cors = require('cors');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const pLimit = require('p-limit');

const app = express();
const cache = new NodeCache({ stdTTL: 300 }); // Cache for 5 minutes
const limit = pLimit(10); // Limit concurrent requests to 10
app.use(cors());

// Rate limiting for scraping endpoints
const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit to 100 requests per minute
});

// Pre-configured Axios instance
const axiosInstance = axios.create({
  timeout: 5000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
});

const baseUrl = 'https://komikcast02.com';
const baseUrl2 = 'https://ngomik.id';

// Puppeteer browser pool
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserPromise;
}

app.get("/project", scrapeLimiter, async (req, res) => {
  const cacheKey = 'project-data';
  const cachedData = cache.get(cacheKey);
  if (cachedData) return res.json(cachedData);

  try {
    const { data } = await axiosInstance.get(baseUrl);
    const $ = cheerio.load(data);
    const results = [];

    $(".listupd .utao").each((i, el) => {
      const element = $(el);
      const title = element.find("h3").text().trim();
      
      // PERBAIKAN DI SINI:
      const rawLink = element.find("a.series").attr("href");
      const slug = rawLink?.replace(`${baseUrl}/komik/`, '').replace(/\/$/, '');
      const link = slug ? `https://192.168.19.177/comic/${slug}` : null;
      
      let thumb = element.find('.imgu img').attr('data-src') || element.find('.imgu img').attr('src');
      thumb = thumb?.split('?')[0];

      const chapters = [];
      element.find('.luf ul li').each((i, chapterElement) => {
        chapters.push({
          title: $(chapterElement).find('a').text().trim(),
          url: $(chapterElement).find('a').attr('href')?.replace(`${baseUrl}/chapter`, "https://zeds.rocks/read"),
          uploaded: $(chapterElement).find('span i').text().trim(),
        });
      });

      results.push({
        title,
        link,
        thumb,
        isHot: element.find("span.hot").length > 0,
        chapters
      });
    });

    cache.set(cacheKey, results);
    res.json(results);
  } catch (error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

// Comics list endpoint
app.get('/comics', scrapeLimiter, async (req, res) => {
  const page = req.query.page || 1;
  const cacheKey = `comics_page_${page}`;

  // Check cache
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { data } = await axiosInstance.get(`${baseUrl}/daftar-komik/page/${page}/?sortby=update`);
    const $ = cheerio.load(data);
    const comics = [];

    $('.list-update_item').each((_, el) => {
      const $el = $(el);
      const title = $el.find('.title').text().trim();
      const url = $el.find('a').attr('href');
      const slug = url?.replace(`${baseUrl}/komik/`, '').replace('/', '');
      const thumb = $el.find('img').attr('src');
      const type = $el.find('.type').text().trim();
      const chapter = $el.find('.chapter').text().trim();
      const rating = $el.find('.numscore').text().trim();
      const uploaded = $el.find('i').text().trim();

      if (title && slug) {
        comics.push({ title, slug, thumb, type, chapter, rating, uploaded });
      }
    });

    const response = { current_page: parseInt(page), comics };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch comics list' });
  }
});

// Search endpoint
app.get('/search', scrapeLimiter, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Query is required' });

  const cacheKey = `search_${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [komikcastRes, ngomikRes] = await Promise.allSettled([
      limit(() => axiosInstance.get(`${baseUrl}/?s=${encodeURIComponent(q)}`)),
      limit(() => axiosInstance.get(`${baseUrl2}/?s=${encodeURIComponent(q)}`)),
    ]);

    const results = [];
    const seenTitles = new Map();

    // Process komikcast02 results
    if (komikcastRes.status === 'fulfilled') {
      const $ = cheerio.load(komikcastRes.value.data);
      $('.list-update_item').each((_, el) => {
        const $el = $(el);
        const title = $el.find('.title').text().trim();
        const url = $el.find('a').attr('href');
        const slug = url?.replace(`${baseUrl}/komik/`, '').replace('/', '');
        const thumb = $el.find('img').attr('src');
        const type = $el.find('.type').text().trim();
        const chapter = $el.find('.chapter').text().trim();
        const rating = $el.find('.numscore').text().trim();

        if (title && slug) {
          seenTitles.set(title.toLowerCase(), {
            title,
            slug,
            thumb,
            type,
            chapter,
            rating,
            source: 'komikcast02',
          });
        }
      });
    }

    // Process ngomik results (only if not already in komikcast)
    if (ngomikRes.status === 'fulfilled') {
      const $ = cheerio.load(ngomikRes.value.data);
      $('.listupd .bs').each((_, el) => {
        const $el = $(el);
        const a = $el.find('a');
        const title = a.attr('title')?.trim();
        const href = a.attr('href')?.trim();
        const slug = href ? new URL(href).pathname.split('/').filter(Boolean).pop() : null;
        const img = a.find('img').attr('data-src') || a.find('img').attr('src');
        const type = ($el.find('.limit .type').attr('class') || '').split(' ')[1] || '';
        const chapterRaw = $el.find('.epxs').text().trim();
        const chapterNumber = chapterRaw.replace(/Chapter\s*/i, '').trim();
        const chapter = chapterNumber ? `Ch.${chapterNumber}` : '';
        const rating = $el.find('.numscore').text().trim();

        if (title && slug && !seenTitles.has(title.toLowerCase())) {
          seenTitles.set(title.toLowerCase(), {
            title,
            slug,
            thumb: img,
            type,
            chapter,
            rating,
            source: 'ngomik',
          });
        }
      });
    }

    const finalResults = Array.from(seenTitles.values()).map(({ source, ...rest }) => rest);
    const response = { query: q, results: finalResults };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Failed to perform search' });
  }
});

// Comic details endpoint with baseUrl priority
app.get('/comics/:slug', scrapeLimiter, async (req, res) => {
  const { slug } = req.params;
  const { source } = req.query;
  const cacheKey = `comic_${slug}_${source || 'auto'}`;

  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    let result;
    const startTime = Date.now();

    if (source === 'ngomik') {
      result = await scrapeNgomik(slug);
    } else if (source === 'komikcast') {
      result = await scrapeKomikcast(slug);
    } else {
      // Prioritize baseUrl (komikcast02)
      try {
        result = await scrapeKomikcast(slug);
        result.source += ' (auto)';
      } catch (komikcastErr) {
        try {
          result = await scrapeNgomik(slug);
          result.source += ' (auto)';
        } catch (ngomikErr) {
          throw new Error('Both sources failed');
        }
      }
    }

    console.log(`Scraped in ${Date.now() - startTime}ms`);
    const response = { success: true, data: result };
    cache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Chapters endpoint
app.get('/comics/:slug/chapters', scrapeLimiter, async (req, res) => {
  const { slug } = req.params;  // Mendapatkan slug dari URL
  const cacheKey = `chapters_${slug}`;

  try {
    // Mengambil data dari komikcast02.com menggunakan baseUrl
    const url = `${baseUrl}/komik/${slug}/`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(data);  // Parsing HTML menggunakan cheerio
    const title = $('.komik_info-content-body-title').text().trim();  // Mengambil judul komik
    const chapters = [];  // Array untuk menyimpan chapter

    // Loop untuk mengambil semua chapter
    $('#chapter-wrapper .komik_info-chapters-item').each((_, el) => {
      const chapterTitle = $(el).find('.chapter-link-item').text().trim();  // Judul chapter
      const chapterUrl = $(el).find('.chapter-link-item').attr('href');  // URL chapter
      const uploaded = $(el).find('.chapter-link-time').text().trim();  // Waktu upload chapter

      if (chapterUrl) {
        // Memproses URL chapter untuk mendapatkan slug yang bersih
        const cleanSlug = chapterUrl.replace(new RegExp(`${baseUrl}/chapter/|/`, 'g'), '');
        chapters.push({
          title: chapterTitle,
          slug: cleanSlug,
          uploaded
        });
      }
    });

    // Mengirimkan respons dalam format JSON
    res.json({ title, chapters });

  } catch (err) {
    // Jika terjadi error di Web 1, coba ambil data dari Web 2 (ngomik.id)
    console.error('Error fetching from Web Komikcast (ComicDetailPage):', err.message);

    try {
      // Mengambil data dari ngomik.id menggunakan baseUrl2
      const { data } = await axios.get(`${baseUrl2}/manga/${slug}/`);
      const $ = cheerio.load(data);
      const chapters = [];

      // Loop untuk mengambil data chapter dari ngomik.id
      $('#chapterlist li').each((_, el) => {
        const chapterLink = $(el).find('a').attr('href');
        const chapterTitle = $(el).find('.chapternum').text().trim();
        const chapterDate = $(el).find('.chapterdate').text().trim();
      
        if (chapterLink && chapterTitle) {
          const cleanSlug = chapterLink.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '');
          chapters.push({
            title: chapterTitle,
            slug: cleanSlug,
            uploaded: chapterDate
          });
        }
      });      

      // Mengirimkan data dari Web 2 dalam format JSON
      res.json({ slug, chapters });
      
    } catch (err) {
      // Jika gagal di kedua web, kirimkan status 500
      console.error('Failed to fetch chapters from Web Ngomik(ComicDetailPage):', err.message);
      return res.status(500).json({ error: 'Failed to fetch chapters from both sources' });
    }
  }
});


// Consolidated read endpoint
app.get('/read/:chapterSlug', scrapeLimiter, async (req, res) => {
  const { chapterSlug } = req.params;
  const { source } = req.query;
  const cacheKey = `read_${chapterSlug}_${source || 'komikcast'}`;

  try {
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let title, images;

    // Try Web 1 (baseUrl)
    const urlWeb1 = `${baseUrl}/chapter/${chapterSlug}/`;
    try {
      const { data } = await axiosInstance.get(urlWeb1);
      const $ = cheerio.load(data);
      title = $('h1.entry-title').text().trim();
      images = $('.main-reading-area img')
        .map((_, el) => $(el).attr('src'))
        .get()
        .filter(Boolean);

      if (images.length > 0) {
        const response = { title, slug: chapterSlug, images };
        cache.set(cacheKey, response);
        console.log(`scraped chapter image komikcast`)
        return res.json(response);
      }
    } catch (err) {
      console.error('GetChapterImage (Komikcast) Error:', err.message);
    }

    // Try Web 2 (baseUrl2)
    const urlWeb2 = `${baseUrl2}/${chapterSlug}/`;
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();

      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (['stylesheet', 'font', 'media'].includes(request.resourceType())) {
          request.abort();
        } else {
          request.continue();
        }
      });

      await page.goto(urlWeb2, { waitUntil: 'domcontentloaded' });
      const data = await page.evaluate(() => {
        const title = document.querySelector('titletf')?.textContent.replace('', '').trim();
        const images = Array.from(document.querySelectorAll('#readerarea img.ts-main-image'))
          .map((img) => {
            const src = img.classList.contains('loaded') ? img.getAttribute('src') : img.getAttribute('data-src');
            if (src && !src.includes('/999.png')) return src;
            return null;
          })
          .filter(Boolean);
        return { title, images };
      });

      await page.close();
      title = data.title;
      images = data.images.map((img) => `${req.protocol}://${req.get('host')}/proxy-image?url=${encodeURIComponent(img)}`);

      const response = { title, slug: chapterSlug, images };
      cache.set(cacheKey, response);
      console.log(`Scrapped Ngomik Chapter Image`);
      console.log('RAW API RESPONSE:', data);
      console.log('Images array:', data.images);
      console.log('FINAL RESPONSE TO FRONTEND:', response);
      return res.json(response);

    } catch (err) {
      console.error('GetChapterImage (Ngomik) Error:', err.message);
      return res.status(500).json({ error: 'Failed to read comic from both sources' });
    }
  } catch (err) {
    console.error('General Scrape Error:', err.message);
    return res.status(500).json({ error: 'Failed to read comic' });
  }
});


// Proxy image endpoint
app.get('/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing URL');

  try {
    const targetUrl = decodeURIComponent(url);
    const isNgomik = targetUrl.includes('srvr2.ngomik.site');
    const response = await axiosInstance.get(targetUrl, {
      responseType: 'stream',
      headers: isNgomik ? { Referer: 'https://ngomik.id' } : {},
    });

    res.setHeader('Content-Type', response.headers['content-type']);
    response.data.pipe(res);
  } catch (error) {
    res.status(500).send('Failed to fetch image');
  }
});

// Scrape functions
async function scrapeNgomik(slug) {
  const { data } = await axiosInstance.get(`${baseUrl2}/manga/${slug}/`);
  const $ = cheerio.load(data);

  const info = {};
  $('.imptdt').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text.includes('Released')) info.released = $el.find('i').text().trim();
    else if (text.includes('Author')) info.author = $el.find('i').text().trim();
    else if (text.includes('Status')) info.status = $el.find('i').text().trim();
    else if (text.includes('Type')) info.type = $el.find('a').text().trim();
  });

  return {
    title: $('h1.entry-title').text().trim(),
    slug,
    thumbnail: $('.thumb img').attr('src'),
    rating: $('.rating-prc .num').text().trim(),
    genres: $('.wd-full a').map((_, el) => $(el).text().trim()).get(),
    info: {
      released: info.released || '',
      author: info.author || '',
      status: info.status || $('.imptdt i:contains("Ongoing")').length ? 'Ongoing' : 'Completed',
      type: info.type || '',
      total_chapter: '?',
      updated: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    },
    sinopsis: $('.entry-content p').first().text().trim(),
    source: 'ngomik.id',
  };
}

async function scrapeKomikcast(slug) {
  const { data } = await axiosInstance.get(`${baseUrl}/komik/${slug}/`);
  const $ = cheerio.load(data);

  const info = {};
  $('.komik_info-content-meta span').each((_, el) => {
    const $el = $(el);
    const text = $el.text().replace(/\n/g, '').trim();
    const [key, ...values] = text.split(':');
    const value = values.join(':').trim();

    if (key.includes('Released')) info.released = value;
    else if (key.includes('Author')) info.author = value;
    else if (key.includes('Status')) info.status = value;
    else if (key.includes('Type')) info.type = $el.find('a').text().trim();
    else if (key.includes('Total Chapter')) info.total_chapter = value;
    else if (key.includes('Updated on')) info.updated = $el.find('time').text().trim();
  });

  return {
    title: $('.komik_info-content-body-title').text().trim(),
    slug,
    thumbnail: $('.komik_info-content-thumbnail img').attr('src'),
    rating: $('.data-rating').data('ratingkomik') || $('.data-rating strong').text().replace('Rating ', ''),
    genres: $('.komik_info-content-genre a').map((_, el) => $(el).text().trim()).get(),
    info,
    sinopsis: $('.komik_info-description-sinopsis p').first().text().trim(),
    source: 'komikcast02.com',
  };
}

// Cleanup Puppeteer on server shutdown
process.on('SIGTERM', async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`✅ Server running on http://localhost:${port}`);
});