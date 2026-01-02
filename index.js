const axios = require('axios');

// In-memory storage
if (!global.mediaLibrary) global.mediaLibrary = [];
if (!global.scraperConfig) global.scraperConfig = { accounts: [], intervalHours: 1, enabled: false, lastRun: null };

// Helper functions
function extractUsername(input) {
    if (!input) return null;
    input = input.trim().replace(/^@/, '');
    const match = input.match(/instagram\.com\/([^\/\?]+)/);
    if (match) return match[1];
    if (/^[a-zA-Z0-9_.]+$/.test(input)) return input;
    return null;
}

function getRandomUserAgent() {
    const agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    ];
    return agents[Math.floor(Math.random() * agents.length)];
}

async function getInstagramData(username) {
    try {
        const response = await axios.get(
            `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
            {
                headers: {
                    'User-Agent': 'Instagram 219.0.0.12.117 Android',
                    'X-IG-App-ID': '936619743392459'
                },
                timeout: 15000
            }
        );
        const user = response.data?.data?.user;
        if (!user) return { success: false, error: 'User not found' };
        
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
            posts: (user.edge_owner_to_timeline_media?.edges || []).map(edge => ({
                id: edge.node.id,
                shortcode: edge.node.shortcode,
                displayUrl: edge.node.display_url,
                thumbnailUrl: edge.node.thumbnail_src || edge.node.display_url,
                caption: edge.node.edge_media_to_caption?.edges?.[0]?.node?.text || '',
                likes: edge.node.edge_liked_by?.count || edge.node.edge_media_preview_like?.count || 0,
                comments: edge.node.edge_media_to_comment?.count || 0,
                timestamp: edge.node.taken_at_timestamp,
                date: new Date(edge.node.taken_at_timestamp * 1000).toISOString(),
                isVideo: edge.node.is_video
            }))
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

function addToLibrary(posts, accountUsername) {
    let newCount = 0;
    const now = new Date().toISOString();
    posts.forEach(post => {
        if (!global.mediaLibrary.find(item => item.id === post.id)) {
            global.mediaLibrary.unshift({
                ...post,
                libraryId: `lib_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                importedAt: now,
                sourceAccount: accountUsername,
                used: false
            });
            newCount++;
        }
    });
    if (global.mediaLibrary.length > 500) global.mediaLibrary = global.mediaLibrary.slice(0, 500);
    return newCount;
}

// Main handler
module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const url = req.url.split('?')[0];
    const query = req.query;
    const body = req.body || {};

    try {
        // Root
        if (url === '/' || url === '/api') {
            return res.json({ status: 'ok', message: 'Howler Instagram API', librarySize: global.mediaLibrary.length });
        }

        // Instagram fetch
        if (url.startsWith('/api/instagram/')) {
            const username = extractUsername(url.split('/api/instagram/')[1]);
            if (!username) return res.status(400).json({ success: false, error: 'Invalid username' });
            return res.json(await getInstagramData(username));
        }

        // Image proxy
        if (url === '/api/proxy/image') {
            if (!query.url) return res.status(400).json({ error: 'URL required' });
            const response = await axios.get(query.url, {
                responseType: 'arraybuffer',
                headers: { 'User-Agent': getRandomUserAgent() },
                timeout: 10000
            });
            res.setHeader('Content-Type', response.headers['content-type']);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(response.data);
        }

        // Library stats
        if (url === '/api/library/stats') {
            const accounts = [...new Set(global.mediaLibrary.map(i => i.sourceAccount).filter(Boolean))];
            return res.json({
                success: true,
                stats: {
                    totalItems: global.mediaLibrary.length,
                    usedItems: global.mediaLibrary.filter(i => i.used).length,
                    accounts: accounts.map(a => ({ username: a, count: global.mediaLibrary.filter(i => i.sourceAccount === a).length })),
                    lastImport: global.scraperConfig.lastRun
                }
            });
        }

        // Library list
        if (url === '/api/library') {
            let filtered = [...global.mediaLibrary];
            if (query.account) filtered = filtered.filter(i => i.sourceAccount === query.account);
            if (query.used !== undefined) filtered = filtered.filter(i => i.used === (query.used === 'true'));
            if (query.search) filtered = filtered.filter(i => i.caption?.toLowerCase().includes(query.search.toLowerCase()));
            
            const page = parseInt(query.page) || 1;
            const limit = parseInt(query.limit) || 50;
            const start = (page - 1) * limit;
            
            return res.json({
                success: true,
                data: filtered.slice(start, start + limit),
                pagination: { page, limit, total: filtered.length, totalPages: Math.ceil(filtered.length / limit) || 1 }
            });
        }

        // Library mark used
        if (url.startsWith('/api/library/mark-used/') && req.method === 'POST') {
            const id = url.split('/api/library/mark-used/')[1];
            const item = global.mediaLibrary.find(i => i.libraryId === id || i.id === id);
            if (!item) return res.status(404).json({ success: false, error: 'Not found' });
            item.used = body.used !== false;
            return res.json({ success: true, item });
        }

        // Library delete
        if (url.startsWith('/api/library/') && req.method === 'DELETE') {
            const id = url.split('/api/library/')[1];
            const idx = global.mediaLibrary.findIndex(i => i.libraryId === id || i.id === id);
            if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
            global.mediaLibrary.splice(idx, 1);
            return res.json({ success: true });
        }

        // Scraper config
        if (url === '/api/scraper/config') {
            if (req.method === 'POST') {
                if (typeof body.enabled === 'boolean') global.scraperConfig.enabled = body.enabled;
                if (body.intervalHours >= 0.5) global.scraperConfig.intervalHours = body.intervalHours;
            }
            return res.json({ success: true, config: global.scraperConfig });
        }

        // Scraper accounts - add
        if (url === '/api/scraper/accounts' && req.method === 'POST') {
            const username = extractUsername(body.username);
            if (!username) return res.status(400).json({ success: false, error: 'Invalid username' });
            if (global.scraperConfig.accounts.find(a => a.username === username)) {
                return res.status(400).json({ success: false, error: 'Already added' });
            }
            
            const data = await getInstagramData(username);
            if (!data.success) return res.status(400).json({ success: false, error: data.error });
            if (data.profile.isPrivate) return res.status(400).json({ success: false, error: 'Private account' });
            
            global.scraperConfig.accounts.push({
                username: data.profile.username,
                addedAt: new Date().toISOString(),
                profilePic: data.profile.profilePic,
                fullName: data.profile.fullName,
                followers: data.profile.followers
            });
            
            const newCount = addToLibrary(data.posts, username);
            return res.json({ success: true, message: `Added @${username} (${newCount} posts)`, config: global.scraperConfig });
        }

        // Scraper accounts - list
        if (url === '/api/scraper/accounts' && req.method === 'GET') {
            return res.json({ success: true, accounts: global.scraperConfig.accounts });
        }

        // Scraper accounts - delete
        if (url.startsWith('/api/scraper/accounts/') && req.method === 'DELETE') {
            const username = url.split('/api/scraper/accounts/')[1];
            const idx = global.scraperConfig.accounts.findIndex(a => a.username === username);
            if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });
            global.scraperConfig.accounts.splice(idx, 1);
            if (query.removeMedia === 'true') {
                global.mediaLibrary = global.mediaLibrary.filter(i => i.sourceAccount !== username);
            }
            return res.json({ success: true, config: global.scraperConfig });
        }

        // Scraper run
        if (url === '/api/scraper/run' && req.method === 'POST') {
            if (global.scraperConfig.accounts.length === 0) {
                return res.json({ success: false, message: 'No accounts configured' });
            }
            
            const results = [];
            let totalNewPosts = 0;
            
            for (const account of global.scraperConfig.accounts) {
                const data = await getInstagramData(account.username);
                if (data.success && !data.profile.isPrivate) {
                    const newCount = addToLibrary(data.posts, account.username);
                    totalNewPosts += newCount;
                    results.push({ account: account.username, success: true, newPosts: newCount });
                } else {
                    results.push({ account: account.username, success: false, error: data.error || 'Private' });
                }
            }
            
            global.scraperConfig.lastRun = new Date().toISOString();
            return res.json({ success: true, results, totalNewPosts, librarySize: global.mediaLibrary.length });
        }

        return res.status(404).json({ error: 'Not found' });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};
