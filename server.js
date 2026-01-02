const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Data storage paths
const DATA_DIR = process.env.DATA_DIR || './data';
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());

// ============ IN-MEMORY STORAGE ============
let mediaLibrary = [];
let scraperConfig = {
    accounts: [],
    intervalHours: 1,
    enabled: false,
    lastRun: null
};
let scraperInterval = null;

// Load data from files
function loadData() {
    try {
        if (fs.existsSync(LIBRARY_FILE)) {
            mediaLibrary = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
            console.log(`📚 Loaded ${mediaLibrary.length} items from library`);
        }
        if (fs.existsSync(CONFIG_FILE)) {
            scraperConfig = { ...scraperConfig, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
            console.log(`⚙️ Loaded scraper config`);
        }
    } catch (error) {
        console.error('Error loading data:', error.message);
    }
}

// Save data to files
function saveData() {
    try {
        fs.writeFileSync(LIBRARY_FILE, JSON.stringify(mediaLibrary, null, 2));
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(scraperConfig, null, 2));
    } catch (error) {
        console.error('Error saving data:', error.message);
    }
}

// Rate limiting
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;

function checkRateLimit(ip) {
    const now = Date.now();
    const userRequests = rateLimitMap.get(ip) || [];
    const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= RATE_LIMIT_MAX) {
        return false;
    }
    
    recentRequests.push(now);
    rateLimitMap.set(ip, recentRequests);
    return true;
}

// ============ INSTAGRAM SCRAPING FUNCTIONS ============

function extractUsername(input) {
    if (!input) return null;
    input = input.trim().replace(/^@/, '');
    
    const urlPatterns = [
        /instagram\.com\/([^\/\?]+)/,
        /instagr\.am\/([^\/\?]+)/
    ];
    
    for (const pattern of urlPatterns) {
        const match = input.match(pattern);
        if (match) return match[1];
    }
    
    if (/^[a-zA-Z0-9_.]+$/.test(input)) return input;
    return null;
}

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0'
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Parse individual post
function parsePost(node, username) {
    return {
        id: node.id,
        shortcode: node.shortcode,
        type: node.__typename,
        displayUrl: node.display_url,
        thumbnailUrl: node.thumbnail_src || node.display_url,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        likes: node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
        comments: node.edge_media_to_comment?.count || 0,
        timestamp: node.taken_at_timestamp,
        date: new Date(node.taken_at_timestamp * 1000).toISOString(),
        isVideo: node.is_video,
        videoUrl: node.video_url || null,
        accessibilityCaption: node.accessibility_caption || '',
        sourceAccount: username,
        carouselMedia: node.edge_sidecar_to_children?.edges?.map(edge => ({
            id: edge.node.id,
            displayUrl: edge.node.display_url,
            isVideo: edge.node.is_video,
            videoUrl: edge.node.video_url || null
        })) || null
    };
}

// Fetch via Mobile API
async function fetchViaMobileAPI(username) {
    const searchResponse = await axios.get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
        headers: {
            'User-Agent': 'Instagram 219.0.0.12.117 Android',
            'X-IG-App-ID': '936619743392459'
        },
        timeout: 15000
    });

    const user = searchResponse.data?.data?.user;
    if (!user) throw new Error('User not found');

    const posts = user.edge_owner_to_timeline_media?.edges || [];

    return {
        success: true,
        profile: {
            username: user.username,
            fullName: user.full_name,
            bio: user.biography,
            profilePic: user.profile_pic_url_hd || user.profile_pic_url,
            followers: user.edge_followed_by?.count || 0,
            following: user.edge_follow?.count || 0,
            postsCount: user.edge_owner_to_timeline_media?.count || 0,
            isPrivate: user.is_private,
            isVerified: user.is_verified,
            isBusiness: user.is_business_account
        },
        posts: posts.map(edge => parsePost(edge.node, username))
    };
}

// Fetch via GraphQL
async function fetchViaGraphQL(username) {
    const profileResponse = await axios.get(`https://www.instagram.com/${username}/?__a=1&__d=dis`, {
        headers: {
            'User-Agent': getRandomUserAgent(),
            'Accept': 'application/json',
            'X-IG-App-ID': '936619743392459',
            'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 15000
    });

    const user = profileResponse.data?.graphql?.user || profileResponse.data?.data?.user;
    if (!user) throw new Error('User not found');

    const posts = user.edge_owner_to_timeline_media?.edges || [];

    return {
        success: true,
        profile: {
            username: user.username,
            fullName: user.full_name,
            bio: user.biography,
            profilePic: user.profile_pic_url_hd || user.profile_pic_url,
            followers: user.edge_followed_by?.count || 0,
            following: user.edge_follow?.count || 0,
            postsCount: user.edge_owner_to_timeline_media?.count || 0,
            isPrivate: user.is_private,
            isVerified: user.is_verified,
            isBusiness: user.is_business_account
        },
        posts: posts.map(edge => parsePost(edge.node, username))
    };
}

// Main scraping function
async function getInstagramData(username) {
    const errors = [];

    try {
        return await fetchViaMobileAPI(username);
    } catch (error) {
        errors.push(`Mobile API: ${error.message}`);
    }

    try {
        return await fetchViaGraphQL(username);
    } catch (error) {
        errors.push(`GraphQL: ${error.message}`);
    }

    return {
        success: false,
        error: 'Failed to fetch Instagram data',
        details: errors
    };
}

// ============ LIBRARY FUNCTIONS ============

function addToLibrary(posts, accountUsername) {
    let newCount = 0;
    const now = new Date().toISOString();
    
    posts.forEach(post => {
        const existingIndex = mediaLibrary.findIndex(item => item.id === post.id);
        
        if (existingIndex === -1) {
            mediaLibrary.unshift({
                ...post,
                libraryId: `lib_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                importedAt: now,
                sourceAccount: accountUsername,
                used: false,
                usedAt: null,
                tags: [],
                notes: ''
            });
            newCount++;
        } else {
            mediaLibrary[existingIndex] = {
                ...mediaLibrary[existingIndex],
                likes: post.likes,
                comments: post.comments,
                lastUpdated: now
            };
        }
    });
    
    mediaLibrary.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    const MAX_LIBRARY_SIZE = 1000;
    if (mediaLibrary.length > MAX_LIBRARY_SIZE) {
        mediaLibrary = mediaLibrary.slice(0, MAX_LIBRARY_SIZE);
    }
    
    saveData();
    return newCount;
}

// ============ AUTO SCRAPER ============

async function runAutoScraper() {
    if (!scraperConfig.enabled || scraperConfig.accounts.length === 0) {
        return { success: false, message: 'Scraper not configured' };
    }
    
    console.log(`\n🔄 Running auto-scraper for ${scraperConfig.accounts.length} account(s)...`);
    const results = [];
    let totalNewPosts = 0;
    
    for (const account of scraperConfig.accounts) {
        try {
            console.log(`   📸 Scraping @${account.username}...`);
            const data = await getInstagramData(account.username);
            
            if (data.success && !data.profile.isPrivate) {
                const newCount = addToLibrary(data.posts, account.username);
                totalNewPosts += newCount;
                results.push({
                    account: account.username,
                    success: true,
                    postsFound: data.posts.length,
                    newPosts: newCount
                });
                console.log(`   ✅ @${account.username}: ${newCount} new posts`);
            } else {
                results.push({
                    account: account.username,
                    success: false,
                    error: data.profile?.isPrivate ? 'Private account' : data.error
                });
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
        } catch (error) {
            results.push({
                account: account.username,
                success: false,
                error: error.message
            });
        }
    }
    
    scraperConfig.lastRun = new Date().toISOString();
    saveData();
    
    console.log(`✅ Auto-scraper complete: ${totalNewPosts} new posts\n`);
    
    return {
        success: true,
        timestamp: scraperConfig.lastRun,
        results,
        totalNewPosts,
        librarySize: mediaLibrary.length
    };
}

function startAutoScraper() {
    if (scraperInterval) clearInterval(scraperInterval);
    
    if (scraperConfig.enabled && scraperConfig.accounts.length > 0) {
        const intervalMs = (scraperConfig.intervalHours || 1) * 60 * 60 * 1000;
        console.log(`⏰ Auto-scraper: every ${scraperConfig.intervalHours} hour(s)`);
        
        runAutoScraper();
        scraperInterval = setInterval(runAutoScraper, intervalMs);
    }
}

function stopAutoScraper() {
    if (scraperInterval) {
        clearInterval(scraperInterval);
        scraperInterval = null;
    }
}

// ============ API ROUTES ============

app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Howler Instagram API with Auto-Scraper',
        librarySize: mediaLibrary.length,
        scraperEnabled: scraperConfig.enabled,
        lastScrape: scraperConfig.lastRun
    });
});

// Get Instagram profile
app.get('/api/instagram/:username', async (req, res) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (!checkRateLimit(clientIP)) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const username = extractUsername(req.params.username);
    if (!username) {
        return res.status(400).json({ success: false, error: 'Invalid username' });
    }

    try {
        const data = await getInstagramData(username);
        res.json(data);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ LIBRARY ROUTES ============

app.get('/api/library', (req, res) => {
    const { page = 1, limit = 50, account, used, search, sortBy = 'date', sortOrder = 'desc' } = req.query;
    
    let filtered = [...mediaLibrary];
    
    if (account) filtered = filtered.filter(item => item.sourceAccount === account);
    if (used !== undefined) filtered = filtered.filter(item => item.used === (used === 'true'));
    if (search) {
        const s = search.toLowerCase();
        filtered = filtered.filter(item => 
            item.caption?.toLowerCase().includes(s) || item.sourceAccount?.toLowerCase().includes(s)
        );
    }
    
    filtered.sort((a, b) => {
        let aVal = sortBy === 'likes' ? (a.likes || 0) : new Date(a[sortBy === 'importedAt' ? 'importedAt' : 'date']);
        let bVal = sortBy === 'likes' ? (b.likes || 0) : new Date(b[sortBy === 'importedAt' ? 'importedAt' : 'date']);
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });
    
    const startIndex = (page - 1) * limit;
    const paginated = filtered.slice(startIndex, startIndex + parseInt(limit));
    
    res.json({
        success: true,
        data: paginated,
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: filtered.length,
            totalPages: Math.ceil(filtered.length / limit)
        }
    });
});

app.get('/api/library/stats', (req, res) => {
    const accounts = [...new Set(mediaLibrary.map(item => item.sourceAccount))];
    
    res.json({
        success: true,
        stats: {
            totalItems: mediaLibrary.length,
            usedItems: mediaLibrary.filter(item => item.used).length,
            accounts: accounts.map(account => ({
                username: account,
                count: mediaLibrary.filter(item => item.sourceAccount === account).length
            })),
            lastImport: scraperConfig.lastRun
        }
    });
});

app.post('/api/library/mark-used/:id', (req, res) => {
    const item = mediaLibrary.find(item => item.libraryId === req.params.id || item.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, error: 'Not found' });
    
    item.used = req.body.used !== false;
    item.usedAt = item.used ? new Date().toISOString() : null;
    saveData();
    
    res.json({ success: true, item });
});

app.delete('/api/library/:id', (req, res) => {
    const index = mediaLibrary.findIndex(item => item.libraryId === req.params.id || item.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, error: 'Not found' });
    
    mediaLibrary.splice(index, 1);
    saveData();
    res.json({ success: true });
});

// ============ SCRAPER CONFIG ROUTES ============

app.get('/api/scraper/config', (req, res) => {
    res.json({ success: true, config: scraperConfig });
});

app.post('/api/scraper/config', (req, res) => {
    const { enabled, intervalHours } = req.body;
    
    if (typeof enabled === 'boolean') scraperConfig.enabled = enabled;
    if (intervalHours >= 0.5 && intervalHours <= 24) scraperConfig.intervalHours = intervalHours;
    
    saveData();
    
    if (scraperConfig.enabled) startAutoScraper();
    else stopAutoScraper();
    
    res.json({ success: true, config: scraperConfig });
});

app.post('/api/scraper/accounts', async (req, res) => {
    const cleanUsername = extractUsername(req.body.username);
    if (!cleanUsername) return res.status(400).json({ success: false, error: 'Invalid username' });
    
    if (scraperConfig.accounts.find(a => a.username === cleanUsername)) {
        return res.status(400).json({ success: false, error: 'Account already added' });
    }
    
    try {
        const data = await getInstagramData(cleanUsername);
        if (!data.success) return res.status(400).json({ success: false, error: 'Could not access account' });
        if (data.profile.isPrivate) return res.status(400).json({ success: false, error: 'Private account' });
        
        scraperConfig.accounts.push({
            username: cleanUsername,
            addedAt: new Date().toISOString(),
            profilePic: data.profile.profilePic,
            fullName: data.profile.fullName,
            followers: data.profile.followers
        });
        
        const newCount = addToLibrary(data.posts, cleanUsername);
        saveData();
        
        if (scraperConfig.enabled) startAutoScraper();
        
        res.json({
            success: true,
            message: `Added @${cleanUsername} (${newCount} posts imported)`,
            config: scraperConfig
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/scraper/accounts/:username', (req, res) => {
    const index = scraperConfig.accounts.findIndex(a => a.username === req.params.username);
    if (index === -1) return res.status(404).json({ success: false, error: 'Not found' });
    
    scraperConfig.accounts.splice(index, 1);
    if (req.query.removeMedia === 'true') {
        mediaLibrary = mediaLibrary.filter(item => item.sourceAccount !== req.params.username);
    }
    saveData();
    
    res.json({ success: true, config: scraperConfig });
});

app.post('/api/scraper/run', async (req, res) => {
    try {
        const result = await runAutoScraper();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Image proxy
app.get('/api/proxy/image', async (req, res) => {
    if (!req.query.url) return res.status(400).json({ error: 'URL required' });

    try {
        const response = await axios.get(req.query.url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': getRandomUserAgent() },
            timeout: 10000
        });
        res.set('Content-Type', response.headers['content-type']);
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// ============ START SERVER ============
loadData();

app.listen(PORT, () => {
    console.log(`\n🚀 Howler Instagram API on port ${PORT}`);
    console.log(`📚 Library: ${mediaLibrary.length} items`);
    console.log(`👥 Accounts: ${scraperConfig.accounts.length}`);
    
    if (scraperConfig.enabled) startAutoScraper();
});

module.exports = app;
