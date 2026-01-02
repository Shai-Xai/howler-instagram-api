const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors());
app.use(express.json());

// In-memory storage
let mediaLibrary = [];
let scraperConfig = {
    accounts: [],
    intervalHours: 1,
    enabled: false,
    lastRun: null
};

// Rate limiting
const rateLimitMap = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    const userRequests = rateLimitMap.get(ip) || [];
    const recentRequests = userRequests.filter(time => now - time < 60000);
    if (recentRequests.length >= 10) return false;
    recentRequests.push(now);
    rateLimitMap.set(ip, recentRequests);
    return true;
}

function extractUsername(input) {
    if (!input) return null;
    input = input.trim().replace(/^@/, '');
    const match = input.match(/instagram\.com\/([^\/\?]+)/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9_.]+$/.test(input)) return input;
    return null;
}

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function parsePost(node, username) {
    return {
        id: node.id,
        shortcode: node.shortcode,
        displayUrl: node.display_url,
        thumbnailUrl: node.thumbnail_src || node.display_url,
        caption: node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
        likes: node.edge_liked_by?.count || node.edge_media_preview_like?.count || 0,
        comments: node.edge_media_to_comment?.count || 0,
        timestamp: node.taken_at_timestamp,
        date: new Date(node.taken_at_timestamp * 1000).toISOString(),
        isVideo: node.is_video,
        sourceAccount: username,
        carouselMedia: node.edge_sidecar_to_children?.edges?.map(edge => ({
            id: edge.node.id,
            displayUrl: edge.node.display_url,
            isVideo: edge.node.is_video
        })) || null
    };
}

async function getInstagramData(username) {
    try {
        const response = await axios.get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
            headers: {
                'User-Agent': 'Instagram 219.0.0.12.117 Android',
                'X-IG-App-ID': '936619743392459'
            },
            timeout: 15000
        });

        const user = response.data?.data?.user;
        if (!user) throw new Error('User not found');

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
            posts: (user.edge_owner_to_timeline_media?.edges || []).map(edge => parsePost(edge.node, username))
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function addToLibrary(posts, accountUsername) {
    let newCount = 0;
    const now = new Date().toISOString();
    
    posts.forEach(post => {
        if (!mediaLibrary.find(item => item.id === post.id)) {
            mediaLibrary.unshift({
                ...post,
                libraryId: `lib_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                importedAt: now,
                used: false
            });
            newCount++;
        }
    });
    
    mediaLibrary.sort((a, b) => new Date(b.date) - new Date(a.date));
    if (mediaLibrary.length > 500) mediaLibrary = mediaLibrary.slice(0, 500);
    
    return newCount;
}

async function runAutoScraper() {
    if (scraperConfig.accounts.length === 0) {
        return { success: false, message: 'No accounts configured' };
    }
    
    const results = [];
    let totalNewPosts = 0;
    
    for (const account of scraperConfig.accounts) {
        try {
            const data = await getInstagramData(account.username);
            if (data.success && !data.profile.isPrivate) {
                const newCount = addToLibrary(data.posts, account.username);
                totalNewPosts += newCount;
                results.push({ account: account.username, success: true, newPosts: newCount });
            } else {
                results.push({ account: account.username, success: false, error: data.error || 'Private' });
            }
        } catch (error) {
            results.push({ account: account.username, success: false, error: error.message });
        }
    }
    
    scraperConfig.lastRun = new Date().toISOString();
    return { success: true, results, totalNewPosts, librarySize: mediaLibrary.length };
}

// Routes
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Howler Instagram API',
        librarySize: mediaLibrary.length,
        trackedAccounts: scraperConfig.accounts.length
    });
});

app.get('/api/instagram/:username', async (req, res) => {
    if (!checkRateLimit(req.ip || 'default')) {
        return res.status(429).json({ success: false, error: 'Rate limited' });
    }
    const username = extractUsername(req.params.username);
    if (!username) return res.status(400).json({ success: false, error: 'Invalid username' });
    res.json(await getInstagramData(username));
});

app.get('/api/library', (req, res) => {
    const { page = 1, limit = 50, account, used, search, sortBy = 'date', sortOrder = 'desc' } = req.query;
    let filtered = [...mediaLibrary];
    
    if (account) filtered = filtered.filter(i => i.sourceAccount === account);
    if (used !== undefined) filtered = filtered.filter(i => i.used === (used === 'true'));
    if (search) filtered = filtered.filter(i => i.caption?.toLowerCase().includes(search.toLowerCase()));
    
    filtered.sort((a, b) => {
        const aVal = sortBy === 'likes' ? a.likes : new Date(a.date);
        const bVal = sortBy === 'likes' ? b.likes : new Date(b.date);
        return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });
    
    const start = (page - 1) * limit;
    res.json({
        success: true,
        data: filtered.slice(start, start + parseInt(limit)),
        pagination: { page: +page, limit: +limit, total: filtered.length, totalPages: Math.ceil(filtered.length / limit) }
    });
});

app.get('/api/library/stats', (req, res) => {
    const accounts = [...new Set(mediaLibrary.map(i => i.sourceAccount))];
    res.json({
        success: true,
        stats: {
            totalItems: mediaLibrary.length,
            usedItems: mediaLibrary.filter(i => i.used).length,
            accounts: accounts.map(a => ({ username: a, count: mediaLibrary.filter(i => i.sourceAccount === a).length })),
            lastImport: scraperConfig.lastRun
        }
    });
});

app.post('/api/library/mark-used/:id', (req, res) => {
    const item = mediaLibrary.find(i => i.libraryId === req.params.id || i.id === req.params.id);
    if (!item) return res.status(404).json({ success: false, error: 'Not found' });
    item.used = req.body.used !== false;
    res.json({ success: true, item });
});

app.delete('/api/library/:id', (req, res) => {
    const idx = mediaLibrary.findIndex(i => i.libraryId === req.params.id || i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
    mediaLibrary.splice(idx, 1);
    res.json({ success: true });
});

app.get('/api/scraper/config', (req, res) => res.json({ success: true, config: scraperConfig }));

app.post('/api/scraper/config', (req, res) => {
    if (typeof req.body.enabled === 'boolean') scraperConfig.enabled = req.body.enabled;
    if (req.body.intervalHours >= 0.5) scraperConfig.intervalHours = req.body.intervalHours;
    res.json({ success: true, config: scraperConfig });
});

app.post('/api/scraper/accounts', async (req, res) => {
    const username = extractUsername(req.body.username);
    if (!username) return res.status(400).json({ success: false, error: 'Invalid username' });
    if (scraperConfig.accounts.find(a => a.username === username)) {
        return res.status(400).json({ success: false, error: 'Already added' });
    }
    
    const data = await getInstagramData(username);
    if (!data.success) return res.status(400).json({ success: false, error: data.error });
    if (data.profile.isPrivate) return res.status(400).json({ success: false, error: 'Private account' });
    
    scraperConfig.accounts.push({
        username,
        addedAt: new Date().toISOString(),
        profilePic: data.profile.profilePic,
        fullName: data.profile.fullName,
        followers: data.profile.followers
    });
    
    const newCount = addToLibrary(data.posts, username);
    res.json({ success: true, message: `Added @${username} (${newCount} posts)`, config: scraperConfig });
});

app.delete('/api/scraper/accounts/:username', (req, res) => {
    const idx = scraperConfig.accounts.findIndex(a => a.username === req.params.username);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
    scraperConfig.accounts.splice(idx, 1);
    if (req.query.removeMedia === 'true') {
        mediaLibrary = mediaLibrary.filter(i => i.sourceAccount !== req.params.username);
    }
    res.json({ success: true, config: scraperConfig });
});

app.post('/api/scraper/run', async (req, res) => res.json(await runAutoScraper()));

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
    } catch (e) {
        res.status(500).json({ error: 'Failed' });
    }
});

// Export for Vercel
module.exports = app;
